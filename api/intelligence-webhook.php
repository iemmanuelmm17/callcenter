<?php
declare(strict_types=1);
/* The former webhook is no longer used. Remove old subscriptions in the PBX. */
http_response_code(410);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
echo '{"error":"CDR event receiver is no longer active"}';
