<?php
declare(strict_types=1);

/**
 * Extracted from includes/reporting.php — includes/reporting/cradle.php.
 *
 * Every function here is loaded by the facade (includes/reporting.php), which
 * is what the endpoints and the other includes require; nothing else changed.
 * The split is deliberately mechanical: same code, same order, same guards.
 */

if (!function_exists('cradleExtractExt')) {
    function cradleExtractExt(string $value): string
    {
        $value = trim($value);
        if ($value === '') {
            return '';
        }
        $value = preg_replace('/^(?:sip:|tel:)/i', '', $value) ?? $value;
        if (str_contains($value, '@')) {
            $value = explode('@', $value, 2)[0];
        }
        $value = trim($value, "<> \t\"'");
        if (preg_match('/(\d+[a-zA-Z]?)\s*$/', $value, $m)) {
            return $m[1];
        }
        return $value;
    }
}

if (!function_exists('cradleUnix10')) {
    function cradleUnix10(string $value): string
    {
        $dt = parseEasternDateTime($value);
        if (!$dt instanceof DateTimeImmutable) {
            return '';
        }
        return substr((string)((int)$dt->getTimestamp() * 1000), 0, 10);
    }
}

if (!function_exists('cradleKeyFromCdr')) {
    function cradleKeyFromCdr(array $row): array
    {
        $orig = trim((string)($row['call-orig-call-id'] ?? $row['call-parent-call-id'] ?? ''));
        $term = trim((string)($row['call-term-call-id'] ?? ''));
        $startSrc = (string)($row['call-batch-answer-datetime'] ?? $row['call-batch-start-datetime'] ?? $row['call-start-datetime'] ?? '');
        $endSrc = (string)($row['call-disconnect-datetime'] ?? '');
        return [
            'orig' => $orig,
            'term' => $term,
            'start' => cradleUnix10($startSrc),
            'end' => cradleUnix10($endSrc),
        ];
    }
}

if (!function_exists('cradlePortalPath')) {
    function cradlePortalPath(array $key): string
    {
        $orig = (string)($key['orig'] ?? '');
        $term = (string)($key['term'] ?? '');
        $start = (string)($key['start'] ?? '');
        $end = (string)($key['end'] ?? '');
        if ($orig === '' || $term === '' || $start === '' || $end === '') {
            return '';
        }
        return '/portal/callhistory/cradle/' . $orig . '/' . $term . '/' . $start . '/' . $end;
    }
}

if (!function_exists('cradleHopsFromEvents')) {
    function cradleHopsFromEvents(array $events): array
    {
        $hops = [];
        $seen = [];
        $lastAgent = null;
        foreach ($events as $event) {
            if (!is_array($event)) {
                continue;
            }
            $str = trim((string)($event['str'] ?? ''));
            $classes = ' ' . strtolower((string)($event['classes'] ?? '')) . ' ';
            $data = is_array($event['data'] ?? null) ? $event['data'] : [];
            $type = strtolower((string)($data['type'] ?? ''));
            $isQueue = str_contains($classes, ' ctg-queue ')
                || $type === 'system-queue'
                || (bool)preg_match('/connected to callqueue/i', $str);
            if ($isQueue) {
                $ext = cradleExtractExt((string)($data['at'] ?? ''));
                if ($ext === '' && preg_match('/\((\d+[a-zA-Z]?)\)\s*$/', $str, $m)) {
                    $ext = $m[1];
                }
                if ($ext === '' || isset($seen['q:' . $ext])) {
                    continue;
                }
                $seen['q:' . $ext] = true;
                $name = trim((string)($data['name'] ?? ''));
                $label = 'Queue ' . $ext;
                if ($name !== '' && $name !== $ext && !str_starts_with($name, $ext . '@')) {
                    $label .= ' · ' . $name;
                }
                $hops[] = [
                    'kind' => 'queue',
                    'id' => $ext,
                    'label' => $label,
                    'name' => $name,
                    'at' => (string)($data['at'] ?? ''),
                ];
                continue;
            }
            $isAnswer = str_contains($classes, ' ctg-answer ')
                || (bool)preg_match('/call answered by/i', $str);
            if ($isAnswer) {
                $ext = cradleExtractExt((string)($data['from'] ?? $data['aor'] ?? ''));
                if ($ext === '' && preg_match('/\((\d+[a-zA-Z]?)\)\s*$/', $str, $m)) {
                    $ext = $m[1];
                }
                $name = trim((string)($data['from_name'] ?? ''));
                if ($name === '' && preg_match('/call answered by\s+(.+?)\s*\(/i', $str, $m)) {
                    $name = trim($m[1]);
                }
                if ($ext !== '') {
                    $lastAgent = [
                        'kind' => 'agent',
                        'id' => $ext,
                        'label' => 'Agent ' . ($name !== '' ? $name . ' (' . $ext . ')' : $ext),
                        'name' => $name,
                    ];
                }
            }
        }
        if (is_array($lastAgent)) {
            $hops[] = $lastAgent;
        }
        return $hops;
    }
}
