/**
 * Unit tests for includes/security.php — the URL policy behind SEC-2 and
 * SEC-3. These run the real PHP functions directly (no curl, no PBX), so the
 * allowlist rules are proven rather than assumed.
 *
 *   node tests/php/security.mjs
 */
import { PhpHarness } from './php.mjs';

const harness = await new PhpHarness();
await harness.boot();

/* One PHP process evaluates the whole table and prints JSON. */
const phpCases = {
  /* pbxRecordingUrl(): first element = input, second = expected verdict. */
  recording: [
    ['https://pbx.example/ns-api/v2/domains/x/recordings/1.mp3', true, 'legit PBX recording'],
    ['https://PBX.EXAMPLE/ns-api/v2/recordings/1.mp3', true, 'host is case-insensitive'],
    ['https://evil.example/ns-api/recording.mp3', false, 'foreign host that merely looks like a PBX path'],
    ['https://pbx.example.evil.example/ns-api/x.mp3', false, 'suffix attack (superstring host)'],
    ['https://pbx.example/notnsapi/x.mp3', false, 'path outside /ns-api/'],
    ['http://pbx.example/ns-api/x.mp3', false, 'PBX is https, so http is refused'],
    ['https://169.254.169.254/ns-api/latest/meta-data', false, 'link-local metadata address'],
    ['https://127.0.0.1/ns-api/x.mp3', false, 'loopback'],
    ['https://pbx.example:8443/ns-api/x.mp3', false, 'port other than the configured one'],
    ['https://pbx.example:443/ns-api/x.mp3', true, 'explicit default port is fine'],
    ['https://user:pass@pbx.example/ns-api/x.mp3', false, 'credentials in the URL'],
    ['javascript:alert(1)//ns-api/', false, 'javascript: scheme'],
    ['file:///etc/passwd', false, 'file: scheme'],
    ['/ns-api/v2/recordings/1.mp3', false, 'relative URL is not accepted here'],
    ['https://pbx.example/ns-api/../../etc/passwd', false, 'path traversal'],
    ["https://pbx.example/ns-api/x.mp3\\r\\nX-Test: 1", false, 'CRLF header injection'],
    ['https://pbx.example/ns-api/x.mp3%20', true, 'percent-encoded space is allowed'],
    ['https://pbx.example/ns-api/my file.mp3', true, 'raw space is percent-encoded by the policy']
  ],
  /* pbxPublicRecordingUrl(): the CDN fallback, never carries the token. */
  publicUrl: [
    ['https://169.254.169.254/recordings/1.mp3', false, 'metadata address'],
    ['https://10.1.2.3/recordings/1.mp3', false, 'private range'],
    ['https://192.168.1.10:8080/x.mp3', false, 'private range with odd port'],
    ['http://records.example.com/1.mp3', false, 'http refused while the PBX is https'],
    ['https://records.example.com:8080/1.mp3', false, 'non-standard port'],
    ['https://records.example.com/1.mp3', false, 'unresolvable host fails closed (no DNS in tests)'],
    ['file:///etc/passwd', false, 'file: scheme'],
    ['//records.example.com/1.mp3', false, 'protocol-relative URL']
  ],
  /* pbxTraceApiIsAcceptable(): call-flow trace values. */
  trace: [
    ['', true, 'empty is allowed (optional)'],
    ['/ns-api/v2/sipflow?callids=a1&type=cradle_to_grave', true, 'canonical relative trace'],
    ['https://pbx.example/ns-api/v2/sipflow?callids=a1', true, 'canonical absolute trace on the PBX'],
    ['callids=a1&start_time=2026-08-02%2010:00:00', true, 'bare query string'],
    ['https://evil.example/ns-api/v2/sipflow?callids=a1', false, 'absolute trace on a foreign host'],
    ['/ns-api/v2/domains/x/recordings?callids=a1', false, 'another PBX endpoint'],
    ['/ns-api/v2/sipflow?callids=a1\r\nHost: evil.example', false, 'CRLF injection'],
    ['/ns-api/v2/sipflow?x=1&callids=a1&callids=b2', true, 'unknown/duplicate parameters are dropped, not refused']
  ]
};

const php = `<?php
/**
 * $kind 'nullable': the function returns the URL (allowed) or null (refused).
 * $kind 'bool': the function returns a boolean verdict directly.
 */
function verdictTable(string $fn, array $cases, string $kind): array {
    $out = [];
    foreach ($cases as $case) {
        $value = $fn($case[0]);
        $allowed = $kind === 'bool' ? ((bool)$value) : ($value !== null);
        $out[] = [
            'input' => $case[0],
            'expected' => $case[1],
            'ok' => $allowed === $case[1],
            'why' => $case[2]
        ];
    }
    return $out;
}
$result = [
    'recording' => verdictTable('pbxRecordingUrl', json_decode($RECORDING, true), 'nullable'),
    'publicUrl' => verdictTable('pbxPublicRecordingUrl', json_decode($PUBLICURL, true), 'nullable'),
    'trace' => verdictTable('pbxTraceApiIsAcceptable', json_decode($TRACE, true), 'bool'),
    'hosts' => pbxAllowedHosts(),
    'scheme' => pbxScheme(),
    'port' => pbxPort(),
    'parentDomain' => [pbxParentDomain('nms1.birns.net'), pbxParentDomain('pbx.example'), pbxParentDomain('192.168.0.1')],
    'hostIsPublic' => [
        pbxHostIsPublic('10.0.0.5'),
        pbxHostIsPublic('169.254.169.254'),
        pbxHostIsPublic('127.0.0.1'),
        pbxHostIsPublic('localhost'),
        pbxHostIsPublic('metadata.internal'),
        pbxHostIsPublic('pbx.example')
    ],
    'resolveUrl' => [
        pbxResolveUrl('https://pbx.example/ns-api/a/b.mp3', '/ns-api/c.mp3'),
        pbxResolveUrl('https://pbx.example/ns-api/a/b.mp3', 'c.mp3'),
        pbxResolveUrl('https://pbx.example/ns-api/a/b.mp3', '//pbx.example/ns-api/d.mp3'),
        pbxResolveUrl('https://pbx.example/ns-api/a/b.mp3', 'https://pbx.example/ns-api/e.mp3')
    ]
];
echo json_encode($result);
`;

const raw = await harness.script(php
  .replace('$RECORDING', JSON.stringify(JSON.stringify(phpCases.recording)))
  .replace('$PUBLICURL', JSON.stringify(JSON.stringify(phpCases.publicUrl)))
  .replace('$TRACE', JSON.stringify(JSON.stringify(phpCases.trace))));

let result;
try {
  /* The bootstrap materialises CACHE_DIR/LOG_DIR but never echoes anything. */
  const start = raw.indexOf('{');
  result = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1));
} catch (error) {
  console.log('  FAIL could not parse PHP output:', raw.slice(0, 800));
  process.exit(1);
}

let failures = 0;
const report = (label, ok, detail = '') => {
  if (ok) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

console.log('== URL policy unit tests (real PHP 8.4) ==\n');
for (const [group, cases] of Object.entries({ recording: result.recording, publicUrl: result.publicUrl, trace: result.trace })) {
  console.log(`-- ${group} --`);
  for (const test of cases) {
    report(
      `${test.expected ? 'allow' : 'refuse'} ${JSON.stringify(test.input).slice(0, 64)} (${test.why})`,
      test.ok
    );
  }
}

console.log('\n-- allowlist derivation --');
report('exact hosts come from PBX_SERVERS', JSON.stringify(result.hosts.exact) === JSON.stringify(['pbx.example']),
  JSON.stringify(result.hosts));
report('two-label PBX host yields no wildcard', result.hosts.suffix.length === 0, JSON.stringify(result.hosts.suffix));
report('scheme/port follow the configured PBX', result.scheme === 'https' && result.port === 443);
report('parent domain of a 3-label host', result.parentDomain[0] === 'example' || result.parentDomain[0] === 'birns.net',
  JSON.stringify(result.parentDomain));
report('parent domain needs three labels', result.parentDomain[1] === '' && result.parentDomain[2] === '');
report('private/metadata/hostname-only hosts are not public',
  result.hostIsPublic.slice(0, 5).every(v => v === false), JSON.stringify(result.hostIsPublic));
report('unresolvable public host fails closed', result.hostIsPublic[5] === false);

console.log('\n-- redirect resolution --');
report('absolute path', result.resolveUrl[0] === 'https://pbx.example/ns-api/c.mp3', result.resolveUrl[0]);
report('relative path', result.resolveUrl[1] === 'https://pbx.example/ns-api/a/c.mp3', result.resolveUrl[1]);
report('protocol relative', result.resolveUrl[2] === 'https://pbx.example/ns-api/d.mp3', result.resolveUrl[2]);
report('absolute URL', result.resolveUrl[3] === 'https://pbx.example/ns-api/e.mp3', result.resolveUrl[3]);

/* --- the path builder: the caller must never choose the path ------------- */
console.log('\n-- sipflow path builder --');
const pathCases = [
  { name: 'hostile trace cannot change the path', php: `pbxSipflowPath('/ns-api/v2/domains/other?x=1', '2026-08-02 10:00:00', '2026-08-02 10:05:00', 'a1', '')` },
  { name: 'absolute foreign trace is ignored', php: `pbxSipflowPath('https://evil.example/ns-api/v2/sipflow?callids=z9', '2026-08-02 10:00:00', '', 'a1', '')` },
  { name: 'query reuse keeps callids and start_time', php: `pbxSipflowPath('/ns-api/v2/sipflow?callids=a1&start_time=2026-08-02%2010:00:00&evil=1', '', '', '', '')` },
  { name: 'CRLF and traversal are stripped', php: `pbxSipflowPath("/ns-api/v2/sipflow?callids=a1%0d%0aHost:%20evil.example&x=../../", '2026-08-02 10:00:00', '', 'a1', '')` },
  { name: 'servers parameter is reduced to a hostname', php: `pbxSipflowPath('', '2026-08-02 10:00:00', '', 'a1', 'https://pbx.example/path?x=1')` },
  { name: 'type defaults to cradle_to_grave', php: `pbxSipflowPath('', '2026-08-02 10:00:00', '2026-08-02 10:05:00', 'a1,b2', '')` }
];

/* Evaluate the builder cases in one PHP process. */
const builderCode = [
  '<?php',
  '$out = [];',
  ...pathCases.map(test => `$out[] = ${test.php};`),
  'echo json_encode($out);'
].join('\n');
const builder = await harness.script(builderCode);
let built = [];
try {
  const start = builder.indexOf('[');
  built = JSON.parse(builder.slice(start, builder.lastIndexOf(']') + 1));
} catch { /* handled below */ }

const expectations = [
  p => p.startsWith('/ns-api/v2/sipflow?'),
  p => p.startsWith('/ns-api/v2/sipflow?') && !p.includes('evil.example'),
  p => p.includes('callids=a1') && p.includes('start_time=2026-08-02%2010%3A00%3A00') && !p.includes('evil=1'),
  p => !/[\r\n]/.test(p) && !p.includes('..') && !p.includes('Host'),
  p => p.includes('servers=pbx.example') && !p.includes('%2F'),
  p => p.includes('type=cradle_to_grave') && p.includes('callids=a1%2Cb2')
];
pathCases.forEach((test, index) => {
  const value = built[index];
  const ok = typeof value === 'string' && expectations[index](value);
  report(`${test.name}${ok ? '' : ` → ${String(value).slice(0, 120)}`}`, ok);
});

console.log(`\n${failures === 0 ? 'SECURITY POLICY OK' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
