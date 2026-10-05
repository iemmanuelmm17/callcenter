<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/auth.php';
$user=currentUser(); if($user['role']!=='office_manager') jsonResponse(['error'=>'Not authorized'],403); $file=LOG_DIR.'/audit-'.gmdate('Y-m').'.jsonl'; $rows=[]; if(is_file($file)) foreach(array_reverse(file($file, FILE_IGNORE_NEW_LINES|FILE_SKIP_EMPTY_LINES)) as $line){$value=json_decode($line,true);if($value)$rows[]=$value;} jsonResponse(['data'=>array_slice($rows,0,500)]);
