/**
 * Real-PHP harness (php-wasm, PHP 8.4) for the API layer.
 *
 * There is no PHP binary in CI/dev containers, so the endpoints are executed
 * by the phpwasm runtime with:
 *   - the repo's real includes/ files,
 *   - a stubbed bootstrap (no session_start, no PBX),
 *   - stubbed PBX responses so every endpoint can be exercised offline,
 *   - a captured jsonResponse() so status codes + payloads can be asserted.
 *
 * What this can prove: routing/method handling, role gates, input validation,
 * JSON shapes, scoping helpers, pure computation (concurrency, summaries).
 * What it cannot prove: live PBX behaviour (curl) or MySQL/SQLite servers.
 */
import { readFileSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import PhpNodePkg from 'php-wasm/PhpNode.js';

const { PhpNode } = PhpNodePkg;
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(ROOT, 'tests/.tmp');

const BOOTSTRAP_STUB = `<?php
declare(strict_types=1);
/*
 * Test bootstrap: mirrors includes/bootstrap.php (config, timezone, session
 * shape, jsonResponse, readJsonBody) without session_start() or PBX calls.
 * jsonResponse() writes THE response to disk and exits, exactly like the real
 * one terminates the request.
 */
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/security.php';
date_default_timezone_set(DEFAULT_TIMEZONE);
foreach ([CACHE_DIR, LOG_DIR] as $directory) {
    if (!is_dir($directory) && !@mkdir($directory, 0770, true) && !is_dir($directory)) {}
}
function appLog(string $message, ?Throwable $e = null): void {
    if ($e instanceof Throwable) $message .= ' ' . $e->getMessage();
    file_put_contents(TEST_LOG, gmdate('c') . " {$message}\\n", FILE_APPEND);
}
function jsonResponse(array $data, int $status = 200): never {
    file_put_contents(TEST_OUT, json_encode(['status' => $status, 'body' => $data]));
    exit(0);
}
function requireMethod(string $method): void {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== $method) jsonResponse(['error' => 'Method not allowed'], 405);
}
function readJsonBody(?string $raw = null): array {
    $raw = $raw ?? (string)file_get_contents(TEST_BODY);
    if (trim($raw) === '') return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) jsonResponse(['error' => 'Invalid JSON body.'], 422);
    return $data;
}
if (!defined('TEST_TMP')) define('TEST_TMP', __DIR__ . '/..');
if (!defined('TEST_OUT')) define('TEST_OUT', __DIR__ . '/../out.json');
if (!defined('TEST_BODY')) define('TEST_BODY', __DIR__ . '/../body.json');
if (!defined('TEST_LOG')) define('TEST_LOG', __DIR__ . '/../app.log');
`;

/** PBX stub: returns canned data for every PbxClient call the endpoints make. */
const PBX_STUB = `<?php
declare(strict_types=1);
/**
 * Test double for includes/PbxClient.php.
 *
 * It mirrors the REAL public surface (method names and signatures are copied
 * from includes/PbxClient.php) and answers each call from
 * tests/.tmp/pbx/<method>.json when that file exists, otherwise from a safe
 * default. Every call is recorded, so tests can assert what the endpoints
 * asked the PBX for. If an endpoint starts calling a method this stub does not
 * define, the test fails loudly — that is deliberate.
 */
final class PbxClient
{
    private const TMP = TEST_TMP;
    /** @var list<string> */
    public static array $calls = [];

    public function __construct(private string $token = '') {}

    public static function reset(): void { self::$calls = []; }

    private function canned(string $method, mixed $fallback): mixed
    {
        $this->record($method);
        $file = self::TMP . '/pbx/' . $method . '.json';
        if (is_file($file)) {
            $data = json_decode((string)file_get_contents($file), true);
            if (is_array($data)) return $data;
        }
        return $fallback;
    }

    private function record(string $call): void
    {
        self::$calls[] = $call;
        /* Endpoints exit inside jsonResponse(), so the call log has to leave
         * the process to be assertable. */
        @file_put_contents(self::TMP . '/pbx-calls.jsonl', json_encode($call) . "\n", FILE_APPEND | LOCK_EX);
    }

    public function users(string $domain): array { return (array)$this->canned('users', []); }
    public function callqueues(string $domain): array { return (array)$this->canned('callqueues', []); }
    public function callqueueAgents(string $domain, string $queue): array { return (array)$this->canned('callqueueAgents', []); }
    public function phonenumbers(string $domain): array { return (array)$this->canned('phonenumbers', []); }
    public function cdrs(string $domain, string $start, string $end): array { return (array)$this->canned('cdrs', []); }
    public function aaReport(string $domain, string $start, string $end): array { return (array)$this->canned('aaReport', []); }
    public function autoAttendantList(string $domain): array { return (array)$this->canned('autoAttendantList', []); }
    public function autoAttendants(string $domain, string $extension, ?string $prompt = null): array { return (array)$this->canned('autoAttendants', []); }
    public function autoAttendantsBatch(array $extensions, int $concurrency = 6): array {
        $rows = (array)$this->canned('autoAttendantsBatch', []);
        if ($rows !== []) return $rows;
        $out = [];
        foreach ($extensions as $ext) $out[(string)$ext] = [];
        return $out;
    }
    public function cradle(string $origCallId, string $termCallId, string $start10, string $end10): array { return (array)$this->canned('cradle', []); }
    public function recording(string $domain, string $ext, string $callId): array { return (array)$this->canned('recording', []); }

    public function fetchCdrs(
        string $domain,
        string $start,
        string $end,
        int $startOffset = 0,
        array $existing = [],
        ?callable $onPage = null
    ): array {
        /*
         * fetchCdrs.json          → one complete page (the default)
         * fetchCdrsPages.json     → [[newRowsOfPage, nextOffset, complete], ...]
         *                           so a test can drive the multi-page path.
         *                           The stub accumulates the pages and hands
         *                           the callback the accumulated list, which
         *                           is what the real client passes (its
         *                           $serverRows grows per CDR_PAGE_SIZE page).
         */
        $pages = (array)$this->canned('fetchCdrsPages', []);
        if ($pages !== []) {
            $accumulated = [];
            $result = ['records' => [], 'complete' => false, 'nextOffset' => 0];
            foreach ($pages as $page) {
                $rows = is_array($page[0] ?? null) ? $page[0] : [];
                foreach ($rows as $row) {
                    if (is_array($row)) $accumulated[] = $row;
                }
                $offset = isset($page[1]) ? (int)$page[1] : count($accumulated);
                $complete = !empty($page[2]);
                if (is_callable($onPage)) {
                    $onPage($accumulated, $offset, $complete);
                }
                $result = ['records' => $accumulated, 'complete' => $complete, 'nextOffset' => $offset];
            }
            return $result;
        }

        $rows = (array)$this->canned('fetchCdrs', []);
        if (is_callable($onPage)) {
            $onPage($rows, count($rows), true);
        }
        return ['records' => $rows, 'complete' => true, 'nextOffset' => count($rows)];
    }

    public function sipflowCradle(
        string $startTime,
        string $endTime,
        string $callids,
        string $servers = '',
        string $traceApi = ''
    ): array {
        $this->record('sipflowCradle:' . $traceApi);
        return (array)$this->canned('sipflowCradle', []);
    }

    /** Mirrors the real client: a URL outside the PBX allowlist is refused. */
    public function download(string $url): array
    {
        $candidate = html_entity_decode(trim($url), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $this->record('download:' . $candidate);
        if (pbxRecordingUrl($candidate) === null) {
            $this->record('download-refused');
            return ['ok' => false, 'status' => 0, 'contentType' => '', 'body' => ''];
        }
        return $this->payload();
    }

    /** CDN fallback: never carries the token, public hosts only. */
    public function downloadPublic(string $url): array
    {
        $candidate = html_entity_decode(trim($url), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $this->record('downloadPublic:' . $candidate);
        if (pbxPublicRecordingUrl($candidate) === null) {
            $this->record('downloadPublic-refused');
            return ['ok' => false, 'status' => 0, 'contentType' => '', 'body' => ''];
        }
        return $this->payload();
    }

    private function payload(): array
    {
        $file = self::TMP . '/pbx/download.json';
        if (is_file($file)) {
            $data = json_decode((string)file_get_contents($file), true);
            if (is_array($data)) return $data;
        }
        return ['ok' => true, 'status' => 200, 'contentType' => 'audio/mpeg', 'body' => 'STUB-AUDIO'];
    }
}
`;
export class PhpHarness {
  constructor() {
    this.php = new PhpNode();
    this.out = [];
    this.php.addEventListener('output', e => this.out.push(String(e.detail)));
  }

  /** php-wasm's mkdir is not recursive (and throws EEXIST), so walk the path. */
  async mkdirp(dir) {
    const parts = dir.split('/').filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      try { await this.php.mkdir(acc); } catch { /* exists */ }
    }
  }

  async boot() {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    for (const dir of ['includes', 'api', 'pbx', 'cache', 'logs', 'scripts']) {
      mkdirSync(path.join(TMP, dir), { recursive: true });
      await this.mkdirp(path.join(TMP, dir));
    }
    await this.mkdirp(TMP);

    await this.write('includes/config.php', readFileSync(path.join(ROOT, 'includes/config.php'), 'utf8'));
    /* The harness deployment uses includes/config.local.php, which is also how
     * a real server overrides the committed defaults (the file is git-ignored). */
    await this.write('includes/config.local.php', `<?php
declare(strict_types=1);
/*
 * Harness deployment. Keeping this file also proves config.php loads
 * includes/config.local.php and that a local value wins over the default.
 * PBX credentials stay empty on purpose: php-wasm has no curl extension, so
 * login.php is exercised up to (and including) its "not configured" branch.
 */
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
`);
    await this.write('includes/bootstrap.php', BOOTSTRAP_STUB);
    await this.write('includes/PbxClient.php', PBX_STUB);
    /* Mirror includes/ recursively (reporting/ is a package of modules) and
     * api/ flat, skipping the files the harness replaces with stubs. */
    const skip = new Set(['config.php', 'bootstrap.php', 'PbxClient.php']);
    const mirror = async (absolute, relative) => {
      for (const name of readdirSync(absolute)) {
        const full = path.join(absolute, name);
        if (statSync(full).isDirectory()) {
          await mirror(full, `${relative}/${name}`);
          continue;
        }
        if (!name.endsWith('.php') || (relative === 'includes' && skip.has(name))) continue;
        await this.write(`${relative}/${name}`, readFileSync(full, 'utf8'));
      }
    };
    await mirror(path.join(ROOT, 'includes'), 'includes');
    await mirror(path.join(ROOT, 'api'), 'api');
    this.includes = this.relativeIncludes();
    return this;
  }

  /** The real api/*.php files require ../includes/... — mirror that under .tmp. */
  relativeIncludes() {
    return true;
  }

  async write(rel, data) {
    const full = path.join(TMP, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    await this.mkdirp(path.dirname(full));
    await this.php.writeFile(full, data);
  }

  async seedPbx(name, rows) {
    await this.write(`pbx/${name}.json`, JSON.stringify(rows));
  }

  /** Read a file the interpreter wrote (audit trail, app log, fixtures). */
  async readInterpreterFile(relative) {
    try {
      return String(await this.php.readFile(path.join(TMP, relative), { encoding: 'utf8' }));
    } catch {
      return '';
    }
  }

  /**
   * Run an arbitrary PHP snippet with the harness bootstrap loaded and return
   * everything it echoed. Used for pure-function tests (the URL policy).
   */
  /**
   * PBX method calls the stub recorded during the last request.
   *
   * NOTE: php-wasm runs on an in-memory filesystem — files written by the
   * harness (and by PHP) live inside the interpreter, not in the repository,
   * so this has to be read back through the interpreter too. A side effect is
   * welcome: nothing under tests/.tmp/ can ever be committed by accident.
   */
  async pbxCalls() {
    let raw = '';
    try {
      raw = await this.php.readFile(path.join(TMP, 'pbx-calls.jsonl'), { encoding: 'utf8' });
    } catch { return []; }
    return String(raw).split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return line; }
    });
  }

  async script(body) {
    if (body.trimStart().startsWith('<?php')) {
      body = body.trimStart().slice(5).replace(/^\s*declare\(strict_types=1\);/, '');
    }
    const code = [
      '<?php',
      'error_reporting(E_ALL & ~E_DEPRECATED & ~E_WARNING & ~E_NOTICE);',
      `require '${TMP}/includes/bootstrap.php';`,
      body
    ].join('\n');
    try { await this.php.refresh(); } catch { /* first run */ }
    this.out.length = 0;
    await this.php.run(code);
    return this.out.join('');
  }

  /**
   * Run one endpoint request.
   * @param {string} endpoint  e.g. 'report.php'
   * @param {object} options   {method, body, query, user, rawBody}
   * @returns {{status:number, body:object, log:string}}
   */
  async request(endpoint, options = {}) {
    const {
      method = 'POST',
      body = null,
      rawBody = body === null ? '' : JSON.stringify(body),
      query = {},
      user = null
    } = options;

    await this.write('body.json', rawBody);
    await this.write('input.json', JSON.stringify({ method, query, user }));
    try { await this.php.unlink(path.join(TMP, 'out.json')); } catch { /* absent */ }
    try { await this.php.unlink(path.join(TMP, 'app.log')); } catch { /* absent */ }
    try { await this.php.unlink(path.join(TMP, 'pbx-calls.jsonl')); } catch { /* absent */ }

    const code = [
      '<?php',
      "error_reporting(E_ALL & ~E_DEPRECATED & ~E_WARNING & ~E_NOTICE);",
      `$cfg = json_decode((string)file_get_contents('${TMP}/input.json'), true);`,
      "$_SERVER['REQUEST_METHOD'] = $cfg['method'];",
      "$_SERVER['REMOTE_ADDR'] = '127.0.0.1';",
      "$_SERVER['HTTPS'] = 'on';",
      "$_GET = $cfg['query'] ?? [];",
      "$_REQUEST = $_GET;",
      "$_POST = [];",
      "$_SESSION = [];",
      "if ($cfg['user']) {",
      "    $_SESSION['user'] = $cfg['user'];",
      "    $_SESSION['last_activity'] = time();",
      "    $_SESSION['token'] = 'test-token';",
      "    $_SESSION['refresh_token'] = 'test-refresh';",
      "    $_SESSION['token_expires_at'] = time() + 3600;",
      "}",
      "try {",
      `    require '${TMP}/api/${endpoint}';`,
      `    file_put_contents('${TMP}/out.json', json_encode(['status' => 200, 'body' => ['note' => 'endpoint returned']]));`,
      "} catch (Throwable $e) {",
      `    file_put_contents('${TMP}/out.json', json_encode(['status' => 599, 'body' => ['fatal' => get_class($e) . ': ' . $e->getMessage(), 'file' => $e->getFile(), 'line' => $e->getLine()]]));`,
      "}"
    ].join('\n');

    /* jsonResponse() exits the previous request; reset the interpreter. */
    try { await this.php.refresh(); } catch { /* first run */ }
    this.out.length = 0;
    await this.php.run(code);

    let payload = { status: 0, body: { error: 'no response' } };
    let log = '';
    try {
      payload = JSON.parse(await this.php.readFile(path.join(TMP, 'out.json'), { encoding: 'utf8' }));
    } catch { /* endpoint produced nothing */ }
    try {
      log = await this.php.readFile(path.join(TMP, 'app.log'), { encoding: 'utf8' });
    } catch { /* no log */ }
    return {
      status: payload.status,
      body: payload.body,
      log,
      phpOutput: this.out.join(''),
      pbxCalls: await this.pbxCalls()
    };
  }
}

export const USERS = {
  office_manager: { username: 'om', role: 'office_manager', domain: 'test.example', extension: '1000', department: '', site: '', displayName: 'OM' },
  supervisor: { username: 'sup', role: 'supervisor', domain: 'test.example', extension: '1100', department: 'Sales', site: '', displayName: 'Sup' },
  agent: { username: 'ag', role: 'agent', domain: 'test.example', extension: '6080', department: 'Sales', site: '', displayName: 'Agent' },
  /* The dashboard-only role: never allowed into a report or a setting. */
  basic_user: { username: 'bu', role: 'basic_user', domain: 'test.example', extension: '6082', department: '', site: '', displayName: 'Basic' }
};
