<?php
declare(strict_types=1);

/**
 * The one definition of the drill-down metric vocabulary.
 *
 * Three things used to hand-maintain this list, and they drifted:
 *
 *   - api/calls.php's metric filter accepted any string, and its final
 *     `return $type === $metric` turned an unknown metric into a plausible
 *     empty list — "No calls found." instead of "that request was wrong".
 *     `handled` and `voicemail` were names no call type can ever equal.
 *   - the modal's `metricLabels` map held a second copy of the labels, with
 *     its own special cases for the title.
 *   - nothing told a new endpoint which ids exist.
 *
 * Now: every id is declared here once, api/calls.php rejects anything else
 * with 422, and api/filters.php serves this catalog (id => label/title) so the
 * front end never keeps a second copy.
 *
 * `label` is the chip / KPI wording, `title` the drill-down dialog's wording
 * where it differs (they are deliberately not the same English: the dialog
 * says "All calls" as a title is "All call details", the KPI says "All calls").
 *
 * Every id below must be handled by the metric filter in api/calls.php.
 */
function callMetricCatalog(): array
{
    return [
        'total' => [
            'label' => 'All calls',
            'title' => 'All',
        ],
        'incoming' => [
            'label' => 'Inbound + missed',
            'title' => 'Inbound + missed',
        ],
        'offered' => [
            'label' => 'Offered',
            'title' => 'Inbound + missed',
        ],
        'inbound' => [
            'label' => 'Inbound',
            'title' => 'Inbound',
        ],
        'outbound' => [
            'label' => 'Outbound',
            'title' => 'Outbound',
        ],
        'missed' => [
            'label' => 'Missed',
            'title' => 'Missed',
        ],
        'onnet' => [
            'label' => 'On-net',
            'title' => 'On-net',
        ],
        'answered' => [
            'label' => 'Answered',
            'title' => 'Answered',
        ],
        'abandoned' => [
            'label' => 'Abandoned',
            'title' => 'Abandoned',
        ],
        'sla' => [
            'label' => 'Within SLA',
            'title' => 'Answered within SLA',
        ],
        'sla_missed' => [
            'label' => 'SLA missed',
            'title' => 'SLA missed (ring over target)',
        ],
        'missed_abandon' => [
            'label' => 'Abandoned',
            'title' => 'Abandoned',
        ],
        'missed_noanswer' => [
            'label' => 'Missed — no answer',
            'title' => 'Missed — no answer',
        ],
        'missed_voicemail' => [
            'label' => 'Missed — voicemail',
            'title' => 'Missed — voicemail',
        ],
        'missed_no_abandon' => [
            'label' => 'Missed (not abandoned)',
            'title' => 'Missed (not abandoned)',
        ],
        'queue_abandoned' => [
            'label' => 'Abandoned in queue',
            'title' => 'Abandoned in queue',
        ],
        'queue_offered' => [
            'label' => 'Offered to queue',
            'title' => 'Offered to queue',
        ],
    ];
}

/** Is this a metric api/calls.php can filter by? */
function isKnownCallMetric(string $metric): bool
{
    return array_key_exists($metric, callMetricCatalog());
}
