<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/auth.php';
requireMethod('POST');
$input = readJsonBody();
/*
 * SEC-5 FIX: client credentials come ONLY from server configuration
 * (environment variables preferred, constants as a guarded fallback).
 * They are never accepted from the request body — a credential supplied
 * by the browser is a public credential. The defined() guards prevent a
 * PHP 8 fatal ("Undefined constant") when the env var is empty and the
 * constant is not defined (mirrors the pattern in auth.php).
 */
$clientId = trim((string)(getenv('PBX_CLIENT_ID') ?: (defined('PBX_CLIENT_ID') ? PBX_CLIENT_ID : '')));
$clientSecret = (string)(getenv('PBX_CLIENT_SECRET') ?: (defined('PBX_CLIENT_SECRET') ? PBX_CLIENT_SECRET : ''));
$username = trim((string)($input['username'] ?? '')); $password = (string)($input['password'] ?? '');
if (!$clientId || !$clientSecret || !$username || !$password) jsonResponse(['error' => 'All credentials are required.'], 422);
$ch = curl_init(PBX_SERVERS['nms1'] . '/ns-api/v2/tokens');
curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30, CURLOPT_HTTPHEADER => ['Accept: application/json', 'Content-Type: application/json'], CURLOPT_POSTFIELDS => json_encode(['grant_type'=>'password','client_id'=>$clientId,'client_secret'=>$clientSecret,'username'=>$username,'password'=>$password])]);
$raw = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
if ($raw === false || $status >= 400) { appLog("Login failed for {$username}: HTTP {$status}"); jsonResponse(['error' => 'Sign-in failed. Check your credentials.'], 401); }
$token = json_decode($raw, true);
if (empty($token['access_token']) || empty($token['domain'])) jsonResponse(['error' => 'PBX returned an invalid token response.'], 502);
$extension = explode('@', (string)($token['login'] ?? $username))[0];
/*
 * SEC-4 FIX: rotate the session ID after successful authentication.
 * Without this, an attacker-planted call_reporting cookie (same-origin)
 * lets them adopt the victim's pre-login session ID and take over the
 * account once the victim signs in.
 */
if (session_status() === PHP_SESSION_ACTIVE) {
    session_regenerate_id(true);
}
$_SESSION['last_activity'] = time();
storePbxToken(is_array($token) ? $token : [], $clientId);
$_SESSION['user'] = ['username' => $token['username'] ?? $username, 'displayName' => $token['displayName'] ?? $username, 'domain' => $token['domain'], 'department' => $token['department'] ?? '', 'site' => $token['site'] ?? '', 'extension' => $extension, 'role' => normalizedRole((string)($token['scope'] ?? 'Basic User'))];
jsonResponse(['user' => $_SESSION['user'], 'expiresIn' => (int)($token['expires_in'] ?? 3600)]);
