<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

/* Trimming raw CDRs to the fields the app reads happens here, at the edge
 * where they arrive, so the wide PBX shape never accumulates in memory. */
require_once __DIR__ . '/reporting/cdr_trim.php';

final class PbxClient
{

    private const PBX_RATE_LIMIT_DIR =
        __DIR__ . '/../cache/pbx-rate-limit';

    /**
     * Requests per second to ONE PBX server, enforced with a file lock shared
     * by every PHP process. 5 is the conservative default; a deployment whose
     * PBX tolerates more can raise it in includes/config.local.php with
     *   define('PBX_REQUESTS_PER_SECOND', 10);
     * and tools/pbx-bench.php measures what the server actually sustains
     * before you try.
     */
    private const PBX_REQUESTS_PER_SECOND = 5;

    private const PAGE_ATTEMPTS = 3;

    /** Parallel CDR pages in flight (curl_multi). Stay under NS 429. */
    private const MULTI_CONCURRENCY = 4;

    /** The configured request rate, clamped to something sane. */
    public static function requestsPerSecond(): float
    {
        $rate = defined('PBX_REQUESTS_PER_SECOND') ? (float)PBX_REQUESTS_PER_SECOND : 5.0;
        if ($rate < 0.5) {
            $rate = 0.5;
        }
        if ($rate > 50.0) {
            $rate = 50.0;
        }
        return $rate;
    }

    /**
     * The page size to ask for, from CDR_PAGE_SIZE (default 250).
     *
     * A bigger page means fewer round trips for the same records, which is the
     * whole cost of a cold range - but ONLY if the PBX honours it: a server
     * that caps the page at 250 while we ask for 1000 would look like "the day
     * ended" and silently truncate. tools/pbx-bench.php proves which size the
     * server honours before this is raised, and the fetch loop below treats a
     * short page as the last page either way.
     */
    public static function pageSize(): int
    {
        $size = defined('CDR_PAGE_SIZE') ? (int)CDR_PAGE_SIZE : 250;
        if ($size < 1) {
            $size = 250;
        }
        if ($size > 5000) {
            $size = 5000;
        }
        return $size;
    }

    /**
     * In-request memoization so one PHP request
     * never hits the same PBX list twice.
     *
     * @var array<string, mixed>
     */
    private static array $memo = [];


    public function __construct(
        private string $token
    ) {}


    /**
     * Shared per-PBX limiter.
     *
     * Workers reserve a time slot, release the lock,
     * then sleep. Other workers can queue behind them
     * instead of waiting on a held lock.
     */
    private function rateLimit(string $server): void
    {
        if (!is_dir(self::PBX_RATE_LIMIT_DIR)) {

            if (
                !mkdir(
                    self::PBX_RATE_LIMIT_DIR,
                    0775,
                    true
                ) &&
                !is_dir(self::PBX_RATE_LIMIT_DIR)
            ) {

                throw new RuntimeException(
                    'Unable to create PBX rate-limit directory'
                );
            }
        }

        $safeServer = preg_replace(
            '/[^a-zA-Z0-9_-]/',
            '_',
            $server
        );

        if (
            $safeServer === null ||
            $safeServer === ''
        ) {
            $safeServer = 'default';
        }

        $lockFile =
            self::PBX_RATE_LIMIT_DIR .
            DIRECTORY_SEPARATOR .
            $safeServer .
            '.lock';

        $timeFile =
            self::PBX_RATE_LIMIT_DIR .
            DIRECTORY_SEPARATOR .
            $safeServer .
            '.time';

        $lock = fopen($lockFile, 'c');

        if ($lock === false) {

            throw new RuntimeException(
                'Unable to create PBX rate-limit lock'
            );
        }

        $sleepUntil = 0.0;

        try {

            if (!flock($lock, LOCK_EX)) {

                throw new RuntimeException(
                    'Unable to acquire PBX rate-limit lock'
                );
            }

            $now = microtime(true);
            $interval = 1.0 / self::requestsPerSecond();
            $next = $now;

            if (is_file($timeFile)) {

                $contents = trim(
                    (string)file_get_contents($timeFile)
                );

                if (
                    $contents !== '' &&
                    is_numeric($contents)
                ) {
                    $next = (float)$contents;
                }
            }

            /*
             * Next free slot is the later of now
             * or the previously reserved slot + interval.
             */
            $slot = max($now, $next);
            $sleepUntil = $slot;

            file_put_contents(
                $timeFile,
                sprintf("%.6f\n", $slot + $interval),
                LOCK_EX
            );

            flock($lock, LOCK_UN);

        } finally {

            fclose($lock);
        }

        $wait = $sleepUntil - microtime(true);

        if ($wait > 0) {

            usleep((int)ceil($wait * 1_000_000));
        }
    }


    private function memoGet(string $key): mixed
    {
        return self::$memo[$key] ?? null;
    }


    private function memoSet(string $key, mixed $value): mixed
    {
        self::$memo[$key] = $value;
        return $value;
    }


    private function bearerToken(): string
    {
        if (
            function_exists('ensurePbxToken') &&
            !ensurePbxToken()
        ) {
            throw new RuntimeException(
                'PBX authentication expired'
            );
        }

        return (string)($_SESSION['token'] ?? $this->token);
    }

    /**
     * @return \CurlHandle|resource
     */
    private function newCurl(
        string $server,
        string $path,
        array $query = [],
        string $method = 'GET',
        ?array $body = null
    ) {
        $token = $this->bearerToken();
        $url =
            rtrim(PBX_SERVERS[$server], '/') .
            $path .
            ($query ? '?' . http_build_query($query) : '');

        $curl = curl_init($url);
        if ($curl === false) {
            throw new RuntimeException('Unable to initialize cURL');
        }

        $headers = [
            'Accept: application/json',
            'Accept-Encoding: gzip, deflate',
            'Authorization: Bearer ' . $token,
        ];

        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_ENCODING => '',
            CURLOPT_TCP_KEEPALIVE => 1,
            CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
        ];

        if ($method === 'POST') {
            $headers[] = 'Content-Type: application/json';
            $opts[CURLOPT_HTTPHEADER] = $headers;
            $opts[CURLOPT_POST] = true;
            $opts[CURLOPT_POSTFIELDS] = json_encode($body, JSON_THROW_ON_ERROR);
        }

        curl_setopt_array($curl, $opts);
        return $curl;
    }

    /**
     * @param \CurlHandle|resource $curl
     * @return array{ok: bool, status: int, errno: int, error: string, data: mixed, raw: string|false}
     */
    private function decodeCurl($curl, mixed $raw): array
    {
        $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $errno = curl_errno($curl);
        $error = curl_error($curl);
        $transient =
            $raw === false
            || in_array($errno, [7, 28, 52, 56], true)
            || in_array($status, [429, 502, 503, 504], true);

        $data = null;
        if (is_string($raw) && $raw !== '' && $status < 400 && $errno === 0) {
            try {
                $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
            } catch (Throwable $e) {
                $error = $e->getMessage();
                $transient = true;
            }
        }

        return [
            'ok' => is_array($data) && $status < 400 && $errno === 0,
            'status' => $status,
            'errno' => $errno,
            'error' => $error,
            'data' => $data,
            'raw' => $raw,
            'transient' => $transient,
        ];
    }

    /**
     * Execute a PBX API request.
     */
    private function request(
        string $server,
        string $path,
        array $query = [],
        string $method = 'GET',
        ?array $body = null
    ): array {

        $attempt = 0;

        while ($attempt < self::PAGE_ATTEMPTS) {

            $curl = $this->newCurl($server, $path, $query, $method, $body);
            $this->rateLimit($server);
            $raw = curl_exec($curl);
            $parsed = $this->decodeCurl($curl, $raw);
            curl_close($curl);

            if (
                $parsed['status'] === 401 &&
                $attempt === 0 &&
                function_exists('refreshPbxToken') &&
                refreshPbxToken()
            ) {
                appLog("PBX {$server} {$path}: HTTP 401 - refreshing token and retrying");
                $attempt++;
                continue;
            }

            if (
                !$parsed['ok'] &&
                $parsed['transient'] &&
                $attempt < self::PAGE_ATTEMPTS - 1
            ) {
                $wait = $attempt + 1;
                appLog(
                    "PBX {$server} {$path}: HTTP {$parsed['status']} errno={$parsed['errno']} {$parsed['error']} - retry in {$wait}s (attempt " .
                    ($attempt + 1) . '/' . self::PAGE_ATTEMPTS . ')'
                );
                sleep($wait);
                $attempt++;
                continue;
            }

            if (!$parsed['ok']) {
                appLog(
                    "PBX {$server} {$path}: HTTP {$parsed['status']} errno={$parsed['errno']} {$parsed['error']}"
                );
                throw new RuntimeException('PBX query failed');
            }

            return is_array($parsed['data']) ? $parsed['data'] : [];
        }

        throw new RuntimeException('PBX authentication failed');
    }

    /**
     * Parallel GET pages. $jobs = list of ['id'=>, 'server'=>, 'path'=>, 'query'=>]
     *
     * @param list<array{id:string,server:string,path:string,query:array}> $jobs
     * @return array<string, array{ok: bool, data: mixed, status: int, error: string, transient: bool}>
     */
    private function requestMulti(array $jobs): array
    {
        if ($jobs === []) {
            return [];
        }

        $mh = curl_multi_init();
        if ($mh === false) {
            throw new RuntimeException('Unable to initialize cURL multi');
        }

        $handles = [];
        foreach ($jobs as $job) {
            $this->rateLimit($job['server']);
            $curl = $this->newCurl($job['server'], $job['path'], $job['query']);
            $handles[$job['id']] = $curl;
            curl_multi_add_handle($mh, $curl);
        }

        do {
            $status = curl_multi_exec($mh, $running);
            if ($running) {
                curl_multi_select($mh, 1.0);
            }
        } while ($running && $status === CURLM_OK);

        $out = [];
        foreach ($handles as $id => $curl) {
            $raw = curl_multi_getcontent($curl);
            $out[$id] = $this->decodeCurl($curl, $raw);
            curl_multi_remove_handle($mh, $curl);
            curl_close($curl);
        }
        curl_multi_close($mh);

        return $out;
    }


    /**
     * Page through a list endpoint.
     *
     * @return list<array>
     */
    private function paged(
        string $server,
        string $path,
        array $query = [],
        callable $normalize
    ): array {

        $all = [];
        $pageSize = self::pageSize();

        for (
            $offset = 0;
            ;
            $offset += $pageSize
        ) {

            $response = $this->request(
                $server,
                $path,
                $query + [
                    'start' => $offset,
                    'limit' => $pageSize
                ]
            );

            $rows = $normalize($response);

            if (!is_array($rows) || $rows === []) {
                break;
            }

            foreach ($rows as $row) {

                if (is_array($row)) {
                    $all[] = $row;
                }
            }

            if (count($rows) < $pageSize) {
                break;
            }
        }

        return $all;
    }


    /**
     * CDRs from configured PBX servers.
     *
     * Replicas share IDs. Fetch the first healthy
     * server fully, then stop. Later servers are
     * only used if the previous one failed.
     */
    public function cdrs(
        string $domain,
        string $start,
        string $end
    ): array {

        $memoKey = 'cdrs:' . $domain . ':' . $start . ':' . $end;
        $cached = $this->memoGet($memoKey);

        if (is_array($cached)) {
            return $cached;
        }

        $result = $this->fetchCdrs($domain, $start, $end);

        if (!$result['complete'] && $result['records'] === []) {
            throw new RuntimeException(
                'No PBX CDR server responded'
            );
        }

        return $this->memoSet(
            $memoKey,
            $result['records']
        );
    }

    /**
     * Page CDRs with retry. Does not discard pages already fetched.
     *
     * $onPage is called once per page with ONLY the rows that page added -
     * not with the whole accumulated list. It used to be handed
     * array_values($serverRows) every page, which is O(n) per page (O(n^2)
     * for a day) and doubles the peak: on a wide window that copy, on top of
     * the day cache's own merge, is what exhausted PHP's memory_limit in
     * production. Callers that append to a store get the new rows, which is
     * what they want anyway; a caller that needs the running total keeps
     * accumulating the return value.
     *
     * Each row is trimmed to the fields the application can read
     * (includes/reporting/cdr_trim.php) as it arrives, so the wide PBX shape
     * never accumulates.
     *
     * @param list<array> $existing
     * @return array{records: list<array>, complete: bool, nextOffset: int}
     */
    public function fetchCdrs(
        string $domain,
        string $start,
        string $end,
        int $startOffset = 0,
        array $existing = [],
        ?callable $onPage = null
    ): array {

        $pageSize = self::pageSize();

        $path =
            '/ns-api/v2/domains/' .
            rawurlencode($domain) .
            '/cdrs';

        $lastError = null;

        foreach (array_keys(PBX_SERVERS) as $server) {

            $serverRows = [];
            foreach ($existing as $row) {
                if (is_array($row)) {
                    $serverRows[
                        $this->cdrKey($row, (string)count($serverRows))
                    ] = $row;
                }
            }

            $offset = max(0, $startOffset);
            $complete = false;
            $stopAt = null;
            /* Rows this page added, and rows of this batch that the callback
             * has not been handed yet - see the $onPage contract above. */
            $pageRows = [];
            $unpublished = [];

            try {

                while ($stopAt === null || $offset < $stopAt) {

                    if (function_exists('set_time_limit')) {
                        set_time_limit(60);
                    }

                    $jobs = [];
                    $launch = $offset;
                    for ($i = 0; $i < self::MULTI_CONCURRENCY; $i++) {
                        if ($stopAt !== null && $launch >= $stopAt) {
                            break;
                        }
                        $jobs[] = [
                            'id' => (string)$launch,
                            'server' => $server,
                            'path' => $path,
                            'query' => [
                                'datetime-start' => $start,
                                'datetime-end' => $end,
                                'start' => $launch,
                                'limit' => $pageSize,
                                'raw' => 'yes',
                            ],
                        ];
                        $launch += $pageSize;
                    }

                    if ($jobs === []) {
                        $complete = true;
                        break;
                    }

                    $batch = $this->requestMulti($jobs);
                    $retry = [];

                    foreach ($jobs as $job) {
                        $id = $job['id'];
                        $parsed = $batch[$id] ?? ['ok' => false, 'transient' => true, 'status' => 0, 'error' => 'missing', 'data' => null];

                        if (
                            !$parsed['ok']
                            && (int)($parsed['status'] ?? 0) === 401
                            && function_exists('refreshPbxToken')
                            && refreshPbxToken()
                        ) {
                            $retry[] = $job;
                            continue;
                        }

                        if (!$parsed['ok'] && !empty($parsed['transient'])) {
                            $retry[] = $job;
                        }
                    }

                    if ($retry !== []) {
                        sleep(1);
                        $again = $this->requestMulti($retry);
                        foreach ($again as $id => $parsed) {
                            $batch[$id] = $parsed;
                        }
                    }

                    ksort($batch, SORT_NUMERIC);
                    $failedOffset = null;

                    foreach ($batch as $id => $parsed) {
                        $pageOffset = (int)$id;
                        if ($stopAt !== null && $pageOffset >= $stopAt) {
                            continue;
                        }

                        if (!$parsed['ok'] || !is_array($parsed['data'])) {
                            appLog(
                                "CDR {$server} offset={$pageOffset}: HTTP " .
                                ($parsed['status'] ?? 0) . ' ' . ($parsed['error'] ?? '')
                            );
                            $failedOffset = $pageOffset;
                            break;
                        }

                        $records = $parsed['data'];
                        if ($records === []) {
                            $stopAt = $pageOffset;
                            $complete = true;
                            break;
                        }

                        foreach ($records as $row) {
                            if (!is_array($row)) {
                                continue;
                            }
                            $row = cdrTrimRecord($row);
                            $row['_server'] = $server;
                            $key = $this->cdrKey($row, $server . ':' . $pageOffset);
                            /* Only rows this page actually added go to the
                             * callback: a duplicate already seen on another
                             * server (or an earlier page) is not new. */
                            if (!array_key_exists($key, $serverRows)) {
                                $pageRows[$key] = $row;
                            }
                            $serverRows[$key] = $row;
                        }
                        $batchRows = array_values($pageRows);
                        $pageRows = [];
                        foreach ($batchRows as $batchIndex => $batchRow) {
                            $unpublished[$batchIndex] = $batchRow;
                        }

                        $got = count($records);
                        if ($got < $pageSize) {
                            $stopAt = $pageOffset + $pageSize;
                            $complete = true;
                            $offset = $stopAt;
                            break;
                        }
                    }

                    if ($failedOffset !== null) {
                        $offset = $failedOffset;
                        if ($serverRows !== []) {
                            if (is_callable($onPage) && $unpublished !== []) {
                                $onPage(array_values($unpublished), $offset, false);
                                $unpublished = [];
                            }
                            return [
                                'records' => array_values($serverRows),
                                'complete' => false,
                                'nextOffset' => $offset,
                            ];
                        }
                        throw new RuntimeException('PBX query failed');
                    }

                    if ($stopAt === null) {
                        $offset = $launch;
                    }

                    if (is_callable($onPage) && $unpublished !== []) {
                        $onPage(
                            array_values($unpublished),
                            $stopAt ?? $offset,
                            $complete
                        );
                        $unpublished = [];
                    }

                    if ($complete) {
                        break;
                    }
                }

                if (is_callable($onPage) && $unpublished !== []) {
                    $onPage(array_values($unpublished), $offset, $complete);
                    $unpublished = [];
                }

                if ($complete || $serverRows !== []) {
                    return [
                        'records' => array_values($serverRows),
                        'complete' => $complete,
                        'nextOffset' => $offset,
                    ];
                }

            } catch (Throwable $e) {

                $lastError = $e;
                appLog(
                    "CDR {$server} offset={$offset}: " .
                    $e->getMessage()
                );

                if (is_callable($onPage) && $unpublished !== []) {
                    $onPage(array_values($unpublished), $offset, false);
                    $unpublished = [];
                }

                if ($serverRows !== []) {
                    return [
                        'records' => array_values($serverRows),
                        'complete' => false,
                        'nextOffset' => $offset,
                    ];
                }
            }
        }

        throw new RuntimeException(
            $lastError instanceof Throwable
                ? $lastError->getMessage()
                : 'No PBX CDR server responded'
        );
    }

    private function cdrKey(
        array $row,
        string $fallback
    ): string {

        foreach (
            [
                'id',
                'call-parent-cdr-id',
                'call-orig-call-id',
                'call-term-call-id'
            ] as $field
        ) {

            if (!empty($row[$field])) {
                return (string)$row[$field];
            }
        }

        return hash(
            'sha256',
            implode('|', [
                $row['call-start-datetime'] ?? '',
                $row['call-orig-from-name'] ?? '',
                $row['call-orig-to-user'] ?? '',
                $row['call-term-user'] ?? '',
                $fallback
            ])
        );
    }


    public function users(string $domain): array
    {
        $memoKey = 'users:' . $domain;
        $cached = $this->memoGet($memoKey);

        if (is_array($cached)) {
            return $cached;
        }

        $all = [];

        foreach (['nms1'] as $server) {

            try {

                $rows = $this->paged(
                    $server,
                    '/ns-api/v2/domains/' .
                    rawurlencode($domain) .
                    '/users',
                    [],
                    static function ($response): array {

                        if (!is_array($response)) {
                            return [];
                        }

                        if (isset($response['user'])) {
                            return [$response];
                        }

                        return $response;
                    }
                );

                foreach ($rows as $row) {

                    $all[(string)($row['user'] ?? '')] = $row;
                }

            } catch (Throwable $e) {

                appLog($e->getMessage());
            }
        }

        return $this->memoSet(
            $memoKey,
            array_values($all)
        );
    }


    public function phonenumbers(string $domain): array
    {
        $memoKey = 'phonenumbers:' . $domain;
        $cached = $this->memoGet($memoKey);

        if (is_array($cached)) {
            return $cached;
        }

        $merged = [];

        foreach (['nms1'] as $server) {

            try {

                $rows = $this->paged(
                    $server,
                    '/ns-api/v2/domains/' .
                    rawurlencode($domain) .
                    '/phonenumbers',
                    [],
                    static function ($response): array {

                        if (!is_array($response)) {
                            return [];
                        }

                        if (isset($response['phonenumber'])) {
                            return [$response];
                        }

                        if (
                            isset($response['data']) &&
                            is_array($response['data'])
                        ) {
                            return $response['data'];
                        }

                        if (
                            isset($response['phonenumbers']) &&
                            is_array($response['phonenumbers'])
                        ) {
                            return $response['phonenumbers'];
                        }

                        return $response;
                    }
                );

                foreach ($rows as $row) {

                    $number = trim(
                        (string)(
                            $row['phonenumber']
                            ?? $row['phone-number']
                            ?? $row['number']
                            ?? ''
                        )
                    );

                    if ($number === '') {
                        continue;
                    }

                    $key = preg_replace('/\D+/', '', $number);

                    if ($key === null || $key === '') {
                        continue;
                    }

                    $merged[$key] = $row;
                }

            } catch (Throwable $e) {

                appLog(
                    "Phone numbers {$server} skipped: " .
                    $e->getMessage()
                );
            }
        }

        return $this->memoSet(
            $memoKey,
            array_values($merged)
        );
    }


    public function aaReport(
        string $domain,
        string $start,
        string $end
    ): array {

        $users = $this->users($domain);
        $aaUsers = [];

        foreach ($users as $user) {

            if (!is_array($user)) {
                continue;
            }

            if (($user['service-code'] ?? '') !== 'system-aa') {
                continue;
            }

            $extension = trim((string)($user['user'] ?? ''));

            if ($extension === '') {
                continue;
            }

            $aaUsers[$extension] = $user;
        }

        if (!$aaUsers) {
            return [];
        }

        $cdrs = $this->cdrs($domain, $start, $end);
        $grouped = [];

        foreach ($cdrs as $cdr) {

            if (!is_array($cdr)) {
                continue;
            }

            $aaExtension = trim(
                (string)($cdr['call-through-user'] ?? '')
            );

            if (
                $aaExtension === '' ||
                !isset($aaUsers[$aaExtension])
            ) {
                continue;
            }

            $preRouting = (string)(
                $cdr['call-term-pre-routing-uri'] ?? ''
            );

            $case = '';

            if (
                preg_match('/\.Case_(\d+)/i', $preRouting, $matches)
            ) {
                $case = (string)$matches[1];
            }

            $destination = trim(
                (string)($cdr['call-term-user'] ?? '')
            );

            if ($destination === '') {
                $destination = '-';
            }

            $key = $aaExtension . '|' . $case . '|' . $destination;

            if (!isset($grouped[$key])) {

                $grouped[$key] = [
                    'extension' => $aaExtension,
                    'name' => trim(
                        (string)(
                            ($aaUsers[$aaExtension]['name-first-name'] ?? '') .
                            ' ' .
                            ($aaUsers[$aaExtension]['name-last-name'] ?? '')
                        )
                    ),
                    'case' => $case,
                    'destination' => $destination,
                    'calls' => 0,
                    'talkSeconds' => 0
                ];
            }

            $grouped[$key]['calls']++;

            $talkSeconds = (int)(
                $cdr['call-talking-duration-seconds'] ?? 0
            );

            if ($talkSeconds > 0) {
                $grouped[$key]['talkSeconds'] += $talkSeconds;
            }
        }

        return array_values($grouped);
    }


    public function autoAttendants(
        string $domain,
        string $extension,
        ?string $prompt = null
    ): array {

        $path =
            '/ns-api/v2/domains/' .
            rawurlencode($domain) .
            '/users/' .
            rawurlencode($extension) .
            '/autoattendants';

        if (
            $prompt !== null &&
            trim($prompt) !== ''
        ) {

            $path .= '/' . rawurlencode(trim($prompt));
        }

        foreach (array_keys(PBX_SERVERS) as $server) {

            try {

                $response = $this->request($server, $path);

                if (is_array($response)) {
                    return $response;
                }

            } catch (Throwable $e) {

                appLog(
                    'AA API ERROR ' .
                    $server . ' ' . $path . ': ' .
                    $e->getMessage()
                );
            }
        }

        return [];
    }


    /**
     * PERF: fetch many auto-attendant configurations concurrently.
     *
     * getAaOptions() used to call autoAttendants() once per AA, strictly
     * serially — N blocking round-trips before the AA dashboard could
     * render anything (~180 ms x 40 AAs = ~7 s on a cold cache).
     *
     * The requests are independent, so they are issued in bounded
     * batches through the same curl_multi path the CDR pager uses.
     * Concurrency is capped so a large domain cannot open dozens of
     * simultaneous PBX sockets.
     *
     * Semantics match autoAttendants() per entry: try each server in
     * PBX_SERVERS order, take the first array response, and fall back to
     * [] when every server fails. Failures are isolated — one bad AA
     * cannot abort the batch.
     *
     * @param array<string,string> $prompts  extension => starting prompt
     * @param int $concurrency               simultaneous requests (clamped 1..8)
     * @return array<string,array>           extension => configuration
     */
    public function autoAttendantsBatch(
        string $domain,
        array $prompts,
        int $concurrency = 6
    ): array {

        if ($prompts === []) {
            return [];
        }

        if ($concurrency < 1) {
            $concurrency = 1;
        }
        if ($concurrency > 8) {
            $concurrency = 8;
        }

        $pathFor = static function (string $extension, string $prompt) use ($domain): string {
            $path =
                '/ns-api/v2/domains/' .
                rawurlencode($domain) .
                '/users/' .
                rawurlencode($extension) .
                '/autoattendants';

            if (trim($prompt) !== '') {
                $path .= '/' . rawurlencode(trim($prompt));
            }

            return $path;
        };

        $results = [];

        /*
         * Server fallback is handled by draining a pending list once per
         * server: everything still unresolved after server A is retried
         * against server B, mirroring the serial method's loop order.
         */
        $pending = $prompts;

        foreach (array_keys(PBX_SERVERS) as $server) {

            if ($pending === []) {
                break;
            }

            $extensions = array_keys($pending);

            foreach (array_chunk($extensions, $concurrency) as $chunk) {

                if (function_exists('set_time_limit')) {
                    set_time_limit(60);
                }

                $jobs = [];
                foreach ($chunk as $extension) {
                    $jobs[] = [
                        'id' => (string)$extension,
                        'server' => $server,
                        'path' => $pathFor(
                            (string)$extension,
                            (string)$pending[$extension]
                        ),
                        'query' => [],
                    ];
                }

                $batch = $this->requestMulti($jobs);

                /*
                 * A 401 refreshes the token once and the whole chunk is
                 * replayed; transient failures are retried once after a
                 * short pause. Same policy as request()/the CDR pager.
                 */
                $retry = [];
                $refreshed = false;

                foreach ($jobs as $job) {
                    $id = $job['id'];
                    $parsed = $batch[$id] ?? [
                        'ok' => false,
                        'transient' => true,
                        'status' => 0,
                        'error' => 'missing',
                        'data' => null,
                    ];

                    if (!empty($parsed['ok'])) {
                        continue;
                    }

                    if (
                        (int)($parsed['status'] ?? 0) === 401
                        && !$refreshed
                        && function_exists('refreshPbxToken')
                        && refreshPbxToken()
                    ) {
                        $refreshed = true;
                        $retry[] = $job;
                        continue;
                    }

                    if (!empty($parsed['transient'])) {
                        $retry[] = $job;
                    }
                }

                if ($retry !== []) {
                    sleep(1);
                    foreach ($this->requestMulti($retry) as $id => $parsed) {
                        $batch[$id] = $parsed;
                    }
                }

                foreach ($batch as $id => $parsed) {

                    if (empty($parsed['ok']) || !is_array($parsed['data'])) {
                        appLog(
                            'AA API ERROR ' . $server .
                            ' ' . $pathFor((string)$id, (string)($pending[$id] ?? '')) .
                            ': HTTP ' . ($parsed['status'] ?? 0) .
                            ' ' . ($parsed['error'] ?? '')
                        );
                        continue;
                    }

                    $results[(string)$id] = $parsed['data'];

                    /* Resolved — do not retry on the next server. */
                    unset($pending[$id]);
                }
            }
        }

        return $results;
    }


    public function autoAttendantList(string $domain): array
    {
        $path =
            '/ns-api/v2/domains/' .
            rawurlencode($domain) .
            '/autoattendants';

        foreach (array_keys(PBX_SERVERS) as $server) {

            try {

                $response = $this->request($server, $path);

                if (is_array($response)) {
                    return $response;
                }

            } catch (Throwable $e) {

                appLog(
                    'AA LIST API ERROR ' .
                    $server . ' ' . $path . ': ' .
                    $e->getMessage()
                );
            }
        }

        return [];
    }

    /**
     * @return list<array>
     */
    public function callqueues(string $domain): array
    {
        $memoKey = 'callqueues:' . $domain;
        $cached = $this->memoGet($memoKey);
        if (is_array($cached)) {
            return $cached;
        }

        $all = [];
        foreach (['nms1'] as $server) {
            try {
                $rows = $this->paged(
                    $server,
                    '/ns-api/v2/domains/' . rawurlencode($domain) . '/callqueues',
                    [],
                    static function ($response): array {
                        if (!is_array($response)) {
                            return [];
                        }
                        if (isset($response['callqueue'])) {
                            return [$response];
                        }
                        if (isset($response['data']) && is_array($response['data'])) {
                            return $response['data'];
                        }
                        return $response;
                    }
                );
                foreach ($rows as $row) {
                    if (!is_array($row)) {
                        continue;
                    }
                    $id = trim((string)($row['callqueue'] ?? ''));
                    if ($id === '') {
                        continue;
                    }
                    $all[$id] = $row;
                }
            } catch (Throwable $e) {
                appLog('Call queues ' . $server . ': ' . $e->getMessage());
            }
        }

        return $this->memoSet($memoKey, array_values($all));
    }

    /**
     * @return list<array>
     */
    public function callqueueAgents(string $domain, string $queue): array
    {
        $queue = trim($queue);
        if ($queue === '') {
            return [];
        }

        $memoKey = 'callqueue-agents:' . $domain . ':' . $queue;
        $cached = $this->memoGet($memoKey);
        if (is_array($cached)) {
            return $cached;
        }

        $path = '/ns-api/v2/domains/' . rawurlencode($domain)
            . '/callqueues/' . rawurlencode($queue) . '/agents';

        foreach (array_keys(PBX_SERVERS) as $server) {
            try {
                $response = $this->request($server, $path);
                $rows = [];
                if (is_array($response)) {
                    if (isset($response['callqueue-agent-id'])) {
                        $rows = [$response];
                    } elseif (isset($response['data']) && is_array($response['data'])) {
                        $rows = $response['data'];
                    } else {
                        $rows = $response;
                    }
                }
                $out = [];
                foreach ($rows as $row) {
                    if (is_array($row)) {
                        $out[] = $row;
                    }
                }
                return $this->memoSet($memoKey, $out);
            } catch (Throwable $e) {
                appLog('Call queue agents ' . $server . ' ' . $path . ': ' . $e->getMessage());
            }
        }

        return $this->memoSet($memoKey, []);
    }

    /**
     * Sky / NetSapiens cradle timeline for one logical call.
     *
     * @return list<array>
     */
    public function cradle(string $origCallId, string $termCallId, string $start10, string $end10): array
    {
        $origCallId = trim($origCallId);
        $termCallId = trim($termCallId);
        $start10 = preg_replace('/\D+/', '', $start10) ?? '';
        $end10 = preg_replace('/\D+/', '', $end10) ?? '';
        if ($origCallId === '' || $termCallId === '' || strlen($start10) < 10 || strlen($end10) < 10) {
            return [];
        }
        $start10 = substr($start10, 0, 10);
        $end10 = substr($end10, 0, 10);

        $path = '/portal/callhistory/cradle/'
            . $origCallId . '/' . $termCallId . '/' . $start10 . '/' . $end10;

        foreach (array_keys(PBX_SERVERS) as $server) {
            try {
                $response = $this->request($server, $path);
                if (is_array($response) && $response !== []) {
                    if (isset($response[0]) || array_is_list($response)) {
                        return $response;
                    }
                    if (isset($response['data']) && is_array($response['data'])) {
                        return $response['data'];
                    }
                    if (isset($response['events']) && is_array($response['events'])) {
                        return $response['events'];
                    }
                }
            } catch (Throwable $e) {
                appLog('Cradle ' . $server . ' ' . $path . ': ' . $e->getMessage());
            }
        }

        return [];
    }

    /** Fetch one call-intelligence job from the CDR's PBX server. */
    public function transcription(string $server, string $domain, string $jobId, string $month, string $callId): array
    {
        if (!isset(PBX_SERVERS[$server]) || !preg_match('/^\d+$/', $jobId)
            || !preg_match('/^\d{4}(0[1-9]|1[0-2])$/', $month) || $callId === '') {
            throw new InvalidArgumentException('Invalid transcription reference');
        }
        return $this->request($server, '/ns-api/v2/domains/' . rawurlencode($domain) . '/transcriptions', [
            'id' => $jobId, 'date' => $month, 'callid' => $callId,
        ]);
    }

    /**
     * GET that returns [] on 404 instead of throwing.
     */
    private function requestOptional(string $server, string $path, array $query = []): array
    {
        $curl = $this->newCurl($server, $path, $query);
        $this->rateLimit($server);
        $raw = curl_exec($curl);
        $parsed = $this->decodeCurl($curl, $raw);
        curl_close($curl);
        if ((int)($parsed['status'] ?? 0) === 404) {
            return [];
        }
        if (!$parsed['ok']) {
            appLog(
                "PBX {$server} {$path}: HTTP {$parsed['status']} {$parsed['error']}"
            );
            return [];
        }
        return is_array($parsed['data']) ? $parsed['data'] : [];
    }

    public function recording(string $domain, string $extension, string $callId): array
    {
        $domain = trim($domain);
        $extension = trim($extension);
        $callId = trim($callId);
        if ($domain === '' || $callId === '') {
            return [];
        }

        $paths = [];
        if ($extension !== '') {
            $paths[] = '/ns-api/v2/domains/' . rawurlencode($domain)
                . '/users/' . rawurlencode($extension)
                . '/recordings/' . rawurlencode($callId);
        }
        $paths[] = '/ns-api/v2/domains/' . rawurlencode($domain)
            . '/recordings/' . rawurlencode($callId);

        foreach (array_keys(PBX_SERVERS) as $server) {
            foreach ($paths as $path) {
                $response = $this->requestOptional($server, $path);
			
                if (!is_array($response) || $response === []) {
                    continue;
                }
                if (isset($response['file-access-url']) || isset($response['call-id'])) {
                    return $response;
                }
                if (isset($response[0]) && is_array($response[0])) {
                    return $response[0];
                }
                return $response;
            }
        }
        return [];
    }

    /**
     * Download a recording file (Bearer). $url may be absolute or relative.
     *
     * @return array{ok:bool,status:int,contentType:string,body:string}
     */
    /**
     * SEC-2: fetch a recording only from a configured PBX host, and only
     * follow redirects to hosts that pass the same policy (see
     * includes/security.php). The bearer token is attached exclusively to
     * allowlisted hosts, so a tampered `src` can no longer send it to a third
     * party.
     */
    public function download(string $url): array
    {
        $candidate = html_entity_decode(trim($url), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        if ($candidate === '') {
            return ['ok' => false, 'status' => 0, 'contentType' => '', 'body' => ''];
        }
        if (preg_match('#^[a-z][a-z0-9+.\-]*://#i', $candidate) !== 1) {
            /* A relative URL is resolved against the configured PBX base, never
             * against anything the caller supplied. */
            foreach (array_keys(PBX_SERVERS) as $server) {
                $base = rtrim((string)PBX_SERVERS[$server], '/');
                if ($base !== '') {
                    $candidate = $base . '/' . ltrim($candidate, '/');
                }
                break;
            }
        }

        $validated = pbxRecordingUrl($candidate);
        if ($validated === null) {
            appLog('Recording download refused (not an allowed PBX URL): ' . substr($candidate, 0, 200));
            return ['ok' => false, 'status' => 0, 'contentType' => '', 'body' => ''];
        }

        return $this->fetchUrl($validated, true);
    }

    /**
     * Fallback for a URL the PBX handed us that is NOT on the PBX allowlist
     * (object storage / CDN). The token is never attached, the host has to
     * resolve to public addresses only, and https is required.
     */
    public function downloadPublic(string $url): array
    {
        $candidate = html_entity_decode(trim($url), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $validated = pbxPublicRecordingUrl($candidate);
        if ($validated === null) {
            appLog('Recording download refused (not a public URL): ' . substr($candidate, 0, 200));
            return ['ok' => false, 'status' => 0, 'contentType' => '', 'body' => ''];
        }

        return $this->fetchUrl($validated, false);
    }

    /**
     * GET a validated URL, following at most three redirects. Each hop is
     * re-validated; the token is dropped the moment a hop leaves the allowlist
     * and the request is refused outright if the hop is neither a PBX host nor
     * a public one.
     *
     * @return array{ok: bool, status: int, contentType: string, body: string}
     */
    private function fetchUrl(string $url, bool $allowToken): array
    {
        $token = $allowToken ? $this->bearerToken() : '';

        for ($hop = 0; $hop < 3; $hop++) {
            $curl = curl_init($url);
            if ($curl === false) {
                return ['ok' => false, 'status' => 0, 'contentType' => '', 'body' => ''];
            }
            $headers = ['Accept: */*'];
            if ($token !== '') {
                $headers[] = 'Authorization: Bearer ' . $token;
            }
            curl_setopt_array($curl, [
                CURLOPT_RETURNTRANSFER => true,
                /* Redirects are handled here so every hop is validated. */
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_CONNECTTIMEOUT => 5,
                CURLOPT_TIMEOUT => 60,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_ENCODING => '',
            ]);
            $body = curl_exec($curl);
            $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            $type = (string)curl_getinfo($curl, CURLINFO_CONTENT_TYPE);
            $location = (string)curl_getinfo($curl, CURLINFO_REDIRECT_URL);
            curl_close($curl);

            $ok = is_string($body) && $body !== '' && $status >= 200 && $status < 400;
            if (!$ok && $status >= 300 && $status < 400 && $location !== '') {
                $next = pbxResolveUrl($url, $location);
                $pbxNext = $next === '' ? null : pbxRecordingUrl($next);
                if ($pbxNext !== null) {
                    $url = $pbxNext;
                    continue;
                }
                $publicNext = $next === '' ? null : pbxPublicRecordingUrl($next);
                if ($publicNext !== null) {
                    $url = $publicNext;
                    $token = '';
                    continue;
                }
                appLog('Recording redirect refused: ' . substr($next, 0, 200));
                return ['ok' => false, 'status' => $status, 'contentType' => $type, 'body' => ''];
            }

            return [
                'ok' => $ok,
                'status' => $status,
                'contentType' => $type !== '' ? $type : 'audio/mpeg',
                'body' => is_string($body) ? $body : '',
            ];
        }

        appLog('Recording download aborted: too many redirects');
        return ['ok' => false, 'status' => 0, 'contentType' => '', 'body' => ''];
    }

    /**
     * GET prefilled-trace-api as stored, plus type=cradle_to_grave.
     */
    /**
     * GET the SIP flow for a call. The caller can hand us the trace URL the
     * PBX stored on the CDR, but only its QUERY is reused and only for the
     * parameters this application issues (SEC-3): the path is always the
     * canonical /ns-api/v2/sipflow, so a caller cannot steer the request at
     * another PBX endpoint.
     */
    public function sipflowCradle(
        string $startTime,
        string $endTime,
        string $callids,
        string $servers = '',
        string $traceApi = ''
    ): array {
        $pathAndQuery = pbxSipflowPath($traceApi, $startTime, $endTime, $callids, $servers);

        appLog('SIPFlow GET ' . $pathAndQuery);

        /* PBX_SIP_TOKEN is only sent when a deployment configures it; an empty
         * value keeps the historical request unchanged. */
        $sipToken = defined('PBX_SIP_TOKEN') ? trim((string)PBX_SIP_TOKEN) : '';

        foreach (array_keys(PBX_SERVERS) as $server) {
            try {
                $url = rtrim((string)PBX_SERVERS[$server], '/') . $pathAndQuery;
                $curl = curl_init($url);
                if ($curl === false) {
                    continue;
                }
                curl_setopt_array($curl, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_CONNECTTIMEOUT => 5,
                    CURLOPT_TIMEOUT => 60,
                    CURLOPT_HTTPHEADER => [
                        'Accept: application/json',
                        'Authorization: Bearer ' . $sipToken,
                    ],
                    CURLOPT_ENCODING => '',
                ]);
                $this->rateLimit($server);
                $rawBody = curl_exec($curl);
                $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
                $errno = curl_errno($curl);
                $error = curl_error($curl);
                curl_close($curl);
                if ($errno !== 0 || $status >= 400 || !is_string($rawBody) || $rawBody === '') {
                    appLog('SIPFlow ' . $server . ': HTTP ' . $status . ' errno=' . $errno . ' ' . $error);
                    continue;
                }
                $data = json_decode($rawBody, true, 512, JSON_INVALID_UTF8_IGNORE);
                if (!is_array($data)) {
                    appLog('SIPFlow ' . $server . ': JSON decode failed ' . substr($rawBody, 0, 180));
                    continue;
                }
                appLog('SIPFlow ' . $server . ': HTTP ' . $status . ' items=' . count($data));
                if ($data !== []) {
                    return $data;
                }
            } catch (Throwable $e) {
                appLog('SIPFlow ' . $server . ': ' . $e->getMessage());
            }
        }
        return [];
    }
}
