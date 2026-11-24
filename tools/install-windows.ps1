# Interactive deployment into an existing IIS/PHP installation. Windows PowerShell 5.1.
# Secrets are read without echo and are never passed to child processes.
param([switch]$LibraryOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$utf8 = [System.Text.UTF8Encoding]::new($false)
$values = @{}

function Ask([string]$label, [string]$default = '') {
    while ($true) {
        $prompt = if ($default) { "$label [$default]" } else { $label }
        $value = Read-Host $prompt
        if (-not $value -and $default) { $value = $default }
        $value = $value.Trim()
        if ($value -and $value -notmatch '[\x00-\x1f\x7f]') { return $value }
        Write-Host 'A value without control characters is required.'
    }
}
function Ask-Optional([string]$label) {
    while ($true) {
        $value = Read-Host $label
        if ($value -notmatch '[\x00-\x1f\x7f]') { return $value.Trim() }
        Write-Host 'Control characters are not allowed.'
    }
}
function Ask-Secret([string]$label, [bool]$required = $true) {
    while ($true) {
        $secret = Read-Host $label -AsSecureString
        $pointer = [IntPtr]::Zero
        try {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
            $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        } finally {
            if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
            $secret.Dispose()
        }
        if (($value -or -not $required) -and $value -notmatch '[\x00-\x1f\x7f]') { return $value }
        Write-Host 'A value without control characters is required.'
    }
}
function Confirm([string]$label) { return ((Read-Host "$label [y/N]") -match '^(?i:y|yes)$') }
function Php-Quote([string]$value) { return "'" + $value.Replace('\', '\\').Replace("'", "\'") + "'" }
function Required-Https([string]$label, [bool]$optional = $false) {
    while ($true) {
        $value = if ($optional) { Ask-Optional $label } else { Ask $label }
        if ($optional -and -not $value) { return '' }
        $uri = $null
        if ([Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -eq 'https' -and
            $uri.Host -and -not $uri.UserInfo -and -not $uri.Query -and -not $uri.Fragment -and $value -notmatch '[\s\\]') {
            return $value.TrimEnd('/')
        }
        Write-Host 'Enter an HTTPS base URL without credentials, query, fragment, whitespace or backslashes.'
    }
}
function Number([string]$label, [int]$default, [int]$min, [int]$max) {
    while ($true) {
        $inputValue = Ask $label ([string]$default)
        $number = 0
        if ([int]::TryParse($inputValue, [ref]$number) -and $number -ge $min -and $number -le $max) { return $number }
        Write-Host "Enter a whole number from $min to $max."
    }
}
function Run-Robocopy([string]$from, [string]$to, [string[]]$extra = @()) {
    if (-not (Test-Path -LiteralPath $from -PathType Container)) { throw "Missing distribution folder: $from" }
    if (-not (Test-Path -LiteralPath $to)) { [void](New-Item -ItemType Directory -Path $to -Force) }
    & robocopy.exe $from $to /E /COPY:DAT /DCOPY:DAT /XJ /R:2 /W:1 /NFL /NDL /NJH /NJS /NP @extra | Out-Host
    if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy exit $LASTEXITCODE); installation is incomplete." }
}
function Set-Access([string]$path, [string[]]$rules, [bool]$private = $false) {
    $arguments = @($path)
    if ($private) { $arguments += @('/inheritance:r') }
    $arguments += @('/grant:r') + $rules
    & icacls.exe @arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Could not set required permissions on $path." }
}
function Child-Element([xml]$doc, [System.Xml.XmlElement]$parent, [string]$name) {
    $child = $parent.SelectSingleNode($name)
    if ($null -eq $child) { $child = $doc.CreateElement($name); [void]$parent.AppendChild($child) }
    if ($child -isnot [System.Xml.XmlElement] -or $child.NamespaceURI) { throw "Unsupported web.config element $name." }
    return $child
}
function Protect-Iis([string]$destination) {
    $path = Join-Path $destination 'web.config'
    $doc = New-Object System.Xml.XmlDocument
    $doc.PreserveWhitespace = $true
    if (Test-Path -LiteralPath $path) { $doc.Load($path) }
    else { $doc.LoadXml('<?xml version="1.0" encoding="utf-8"?><configuration/>') }
    $root = $doc.DocumentElement
    if ($null -eq $root -or $root.LocalName -ne 'configuration' -or $root.NamespaceURI) { throw 'Unsupported existing web.config; configure IIS protection manually.' }
    $server = Child-Element $doc $root 'system.webServer'
    $security = Child-Element $doc $server 'security'
    $filter = Child-Element $doc $security 'requestFiltering'
    $hidden = Child-Element $doc $filter 'hiddenSegments'
    foreach ($segment in @('includes', 'cache', 'logs', 'tools')) {
        # Normalize local rules so an existing later <remove> cannot undo an <add>.
        foreach ($node in @($hidden.ChildNodes)) {
            if ($node -is [System.Xml.XmlElement] -and $node.LocalName -in @('add', 'remove') -and $node.GetAttribute('segment') -ieq $segment) { [void]$hidden.RemoveChild($node) }
        }
        # Avoid duplicate collection keys when a parent IIS config already hides the segment.
        $remove = $doc.CreateElement('remove'); $remove.SetAttribute('segment', $segment); [void]$hidden.AppendChild($remove)
        $add = $doc.CreateElement('add'); $add.SetAttribute('segment', $segment); [void]$hidden.AppendChild($add)
    }
    $temp = "$path.install-$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $settings = New-Object System.Xml.XmlWriterSettings
        $settings.Encoding = $utf8; $settings.Indent = $false
        $writer = [System.Xml.XmlWriter]::Create($temp, $settings)
        try { $doc.Save($writer) } finally { $writer.Dispose() }
        Move-Item -LiteralPath $temp -Destination $path -Force
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}
function Private-Backup([string]$config) {
    $folder = Join-Path (Join-Path $env:ProgramData 'CallScope-Installer-Backups') ([Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $folder -Force)
    Set-Access $folder @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F') $true
    $backup = Join-Path $folder 'config.local.php'
    Copy-Item -LiteralPath $config -Destination $backup
    Set-Access $backup @('*S-1-5-18:F', '*S-1-5-32-544:F') $true
    Write-Host "Previous configuration backed up in protected directory: $folder"
}
function Xml-Escape([string]$value) { return [Security.SecurityElement]::Escape($value) }
function New-MonitorTaskXml([string]$php, [string]$destination, [string]$script, [int]$minutes, [string]$start) {
    $command = Xml-Escape $php
    $argument = Xml-Escape ('"' + $script + '"')
    $working = Xml-Escape $destination
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>CallScope automatic keyword alerts</Description></RegistrationInfo>
  <Triggers><TimeTrigger><Enabled>true</Enabled><StartBoundary>$start</StartBoundary><Repetition><Interval>PT${minutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger></Triggers>
  <Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings>
  <Actions Context="System"><Exec><Command>$command</Command><Arguments>$argument</Arguments><WorkingDirectory>$working</WorkingDirectory></Exec></Actions>
</Task>
"@
    return $xml
}
function Register-MonitorTask([string]$php, [string]$destination, [string]$name, [int]$minutes) {
    $script = Join-Path $destination 'tools\intelligence-monitor.php'
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'The scheduled worker is missing.' }
    & schtasks.exe /Query /TN $name 2>$null | Out-Null
    $replaceTask = $false
    if ($LASTEXITCODE -eq 0) {
        if (-not (Confirm "Task '$name' already exists. Replace it?")) { throw 'Task replacement cancelled; no task changes were made.' }
        $replaceTask = $true
    }
    $start = (Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
    $xml = New-MonitorTaskXml $php $destination $script $minutes $start
    $temp = Join-Path $env:TEMP ("callscope-task-$([Guid]::NewGuid().ToString('N')).xml")
    try {
        [IO.File]::WriteAllText($temp, $xml, [Text.Encoding]::Unicode)
        $taskArgs = @('/Create', '/TN', $name, '/XML', $temp, '/RU', 'SYSTEM')
        if ($replaceTask) { $taskArgs += '/F' }
        & schtasks.exe @taskArgs | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the scheduled task.' }
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}
function New-InstallerConfig([hashtable]$values) {
    $servers = "'nms1' => " + (Php-Quote $values.primary)
    if ($values.secondary) { $servers += ", 'nms2' => " + (Php-Quote $values.secondary) }
    $lines = @('<?php', 'declare(strict_types=1);', '', ("define('PBX_SERVERS', [" + $servers + ']);'))
    foreach ($pair in @(@('PBX_CLIENT_ID','clientId'), @('PBX_CLIENT_SECRET','clientSecret'), @('INTELLIGENCE_MONITOR_API_KEY','monitorKey'), @('INTELLIGENCE_SMTP_HOST','smtpHost'), @('INTELLIGENCE_SMTP_USERNAME','smtpUser'), @('INTELLIGENCE_SMTP_PASSWORD','smtpPassword'), @('INTELLIGENCE_SMTP_FROM','smtpFrom'))) {
        $lines += "define('$($pair[0])', " + (Php-Quote $values[$pair[1]]) + ');'
    }
    $lines += "define('INTELLIGENCE_SMTP_PORT', $($values.smtpPort));"
    if ($values.sipToken) { $lines += "define('PBX_SIP_TOKEN', " + (Php-Quote $values.sipToken) + ');' }
    return (($lines -join "`n") + "`n")
}
function Test-IisProtection([string]$destination, [string]$base) {
    $uri = $null
    if (-not [Uri]::TryCreate($base, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'The application URL must be an absolute HTTP(S) URL without credentials, query or fragment.' }
    $base = $base.TrimEnd('/')
    # Prove that the supplied URL maps to this folder before accepting 404s.
    foreach ($segment in @('', 'includes', 'cache', 'logs', 'tools')) {
        $name = 'callscope-install-check-' + [Guid]::NewGuid().ToString('N') + '.txt'
        $folder = if ($segment) { Join-Path $destination $segment } else { $destination }
        $file = Join-Path $folder $name
        $url = if ($segment) { "$base/$segment/$name" } else { "$base/$name" }
        try {
            [IO.File]::WriteAllText($file, 'CallScope installation access check', $utf8)
            $request = [Net.WebRequest]::Create($url)
            $request.Method = if ($segment) { 'HEAD' } else { 'GET' }; $request.AllowAutoRedirect = $false; $request.Timeout = 15000
            $response = $null
            try { $response = $request.GetResponse() }
            catch [Net.WebException] {
                if ($null -eq $_.Exception.Response) { throw "Unable to verify IIS protection for $segment; check the application URL and server." }
                $response = $_.Exception.Response
            }
            try {
                $status = [int]$response.StatusCode
                if (-not $segment -and $status -eq 200) {
                    $reader = [IO.StreamReader]::new($response.GetResponseStream())
                    try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
                    if ($body -cne 'CallScope installation access check') { throw 'The application URL did not serve the expected test file; verify the IIS application path.' }
                }
            } finally { $response.Dispose() }
            if (-not $segment -and $status -ne 200) { throw "The application URL did not serve the test file (HTTP $status); verify the IIS application path before checking protection." }
            if ($segment -and $status -ne 403 -and $status -ne 404) { throw "IIS protection check for $segment returned HTTP $status, not 403/404. Do not use the application until access is blocked." }
            if ($segment) { Write-Host "IIS access check: $segment returned HTTP $status." }
        } finally { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }
    }
}
function Test-AssetIntegrity([string]$directory) {
    $manifest = Get-Content -LiteralPath (Join-Path $directory 'assets\build-manifest.json') -Raw | ConvertFrom-Json
    $vendor = Get-Content -LiteralPath (Join-Path $directory 'assets\vendor\VENDOR.json') -Raw | ConvertFrom-Json
    $entries = @($manifest.js, $manifest.css) + @($vendor.files)
    foreach ($entry in $entries) {
        $relative = if ($entry.PSObject.Properties.Name -contains 'file') { [string]$entry.file } else { [string]$entry.target }
        if ($relative -notmatch '^assets/(js|css|vendor)/[a-zA-Z0-9._/-]+$' -or $relative.Contains('..')) { throw 'Invalid asset path in manifest.' }
        $file = Join-Path $directory ($relative.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing asset: $relative" }
        $stream = [IO.File]::OpenRead($file)
        $algorithm = [Security.Cryptography.SHA384]::Create()
        try { $hash = [Convert]::ToBase64String($algorithm.ComputeHash($stream)) }
        finally { $algorithm.Dispose(); $stream.Dispose() }
        if ($hash -cne [string]$entry.sha384 -or (Get-Item -LiteralPath $file).Length -ne [long]$entry.bytes) { throw "Asset integrity failed: $relative" }
    }
    Write-Host "Verified $($entries.Count) bundled assets."
}

if ($LibraryOnly) { return }

try {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run install.bat as Administrator.' }
    foreach ($required in @('index.php', 'portal.php', 'assets\build-manifest.json', 'assets\vendor\VENDOR.json', 'tools\intelligence-monitor.php', 'tools\install-check.php')) {
        if (-not (Test-Path -LiteralPath (Join-Path $source $required) -PathType Leaf)) { throw "The distribution is incomplete: $required is missing." }
    }
    Write-Host 'CallScope installer: deploy to an existing IIS site with an existing PHP installation.'
    Write-Host 'This does not install IIS/PHP or create an IIS site, application, binding or certificate.'
    Write-Host 'Passwords are not echoed; administrative recording or transcription may still capture input.'
    $destination = [IO.Path]::GetFullPath((Ask 'Destination folder under your existing IIS site' 'C:\inetpub\wwwroot\callscope')).TrimEnd('\')
    if ($destination -notmatch '^[A-Za-z]:\\' -or $destination -eq [IO.Path]::GetPathRoot($destination).TrimEnd('\')) { throw 'Choose a local, non-root destination folder.' }
    if ($destination -ieq $source -or $destination.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The destination must be separate from and not contain the installer source.' }
    if ((Test-Path -LiteralPath $destination) -and (Get-ChildItem -LiteralPath $destination -Force | Select-Object -First 1)) {
        Write-Host 'The destination is not empty. Existing app files may be overwritten; cache and logs are not deleted.'
        if (-not (Confirm 'Continue with this destination?')) { throw 'Installation cancelled.' }
    }
    $php = [IO.Path]::GetFullPath((Ask 'Full path to the PHP CLI executable' 'C:\php\php.exe'))
    if ($php -notmatch '^[A-Za-z]:\\' -or -not (Test-Path -LiteralPath $php -PathType Leaf)) { throw 'The PHP CLI must be an existing local file.' }
    & $php (Join-Path $source 'tools\install-check.php') | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'PHP CLI prerequisite check failed.' }
    $iisIdentity = Ask 'IIS application pool identity (for example IIS AppPool\CallScope)'
    try { $sid = ([Security.Principal.NTAccount]::new($iisIdentity)).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'The IIS identity could not be resolved. Create/identify the application pool first.' }
    $taskName = Ask 'Windows scheduled task name' 'CallScope Intelligence Monitor'
    if ($taskName -match '[\\/:*?"<>|]' -or $taskName.Length -gt 180) { throw 'Use a simple task name without path separators or special characters.' }
    $interval = Number 'Task interval in minutes' 5 1 1439
    $config = Join-Path $destination 'includes\config.local.php'
    $replaceConfig = -not (Test-Path -LiteralPath $config -PathType Leaf)
    if (-not $replaceConfig) {
        Write-Host 'An existing configuration was found. Replacing it will replace all custom constants, not just the prompted settings.'
        Write-Host 'Custom cache/log paths may stop being used; restore needed settings from the protected backup after installation.'
        $replaceConfig = Confirm 'Back it up and replace it with newly entered settings?'
    }
    $values = @{}
    if ($replaceConfig) {
        $values.primary = Required-Https 'Primary PBX HTTPS base URL (nms1)'
        $values.secondary = Required-Https 'Secondary PBX HTTPS base URL (nms2), or press Enter to skip' $true
        $values.clientId = Ask 'PBX OAuth client ID'
        $values.clientSecret = Ask-Secret 'PBX OAuth client secret'
        $values.monitorKey = Ask-Secret 'Dedicated PBX monitor API key'
        do { $values.smtpHost = Ask 'SMTP server hostname'; if ($values.smtpHost -notmatch '^[a-zA-Z0-9.-]+$') { Write-Host 'Enter a hostname only, without scheme or port.' } } while ($values.smtpHost -notmatch '^[a-zA-Z0-9.-]+$')
        $values.smtpPort = Number 'SMTP STARTTLS port' 587 1 65535
        $values.smtpUser = Ask 'SMTP username'
        $values.smtpPassword = Ask-Secret 'SMTP password'
        do {
            $values.smtpFrom = Ask 'SMTP From email address'
            try { $mail = [System.Net.Mail.MailAddress]::new($values.smtpFrom); $validMail = $mail.Address -ceq $values.smtpFrom } catch { $validMail = $false }
            if (-not $validMail) { Write-Host 'Enter one valid email address without a display name.' }
        } while (-not $validMail)
        $values.sipToken = Ask-Secret 'Optional SIP-flow token (press Enter to skip)' $false
        Write-Host 'The transcription lookup month timezone is intentionally not guessed; configure it after confirming PBX semantics if required.'
    }
    Write-Host 'Checking distribution assets before copying...'
    Test-AssetIntegrity $source
    [void](New-Item -ItemType Directory -Path $destination -Force)
    # Grant only the chosen app identity read/execute, and Local System full access.
    # Existing explicit ACLs are otherwise left in place.
    Set-Access $destination @("*${sid}:(OI)(CI)RX", '*S-1-5-18:(OI)(CI)F')
    # Apply the IIS request-filter rule before copying any secret or runtime data.
    Protect-Iis $destination
    Run-Robocopy (Join-Path $source 'api') (Join-Path $destination 'api')
    Run-Robocopy (Join-Path $source 'includes') (Join-Path $destination 'includes') @('/XF', 'config.local.php')
    Run-Robocopy (Join-Path $source 'assets') (Join-Path $destination 'assets')
    foreach ($file in @('index.php', 'portal.php', 'README.md')) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $destination $file) -Force }
    [void](New-Item -ItemType Directory -Path (Join-Path $destination 'tools') -Force)
    foreach ($file in @('intelligence-monitor.php', 'install-check.php')) { Copy-Item -LiteralPath (Join-Path $source "tools\$file") -Destination (Join-Path $destination "tools\$file") -Force }
    Test-AssetIntegrity $destination
    foreach ($name in @('cache', 'logs')) {
        $directory = Join-Path $destination $name
        [void](New-Item -ItemType Directory -Path $directory -Force)
        Set-Access $directory @("*${sid}:(OI)(CI)M", '*S-1-5-18:(OI)(CI)F')
    }
    $appUrl = Ask-Optional 'Application base URL for IIS protection checks (or Enter to verify manually)'
    if ($appUrl) { Test-IisProtection $destination $appUrl }
    else { Write-Host 'WARNING: IIS protection was not verified; do not expose this app until you verify blocked paths.' -ForegroundColor Yellow }
    if ($replaceConfig) {
        if (Test-Path -LiteralPath $config -PathType Leaf) { Private-Backup $config }
        $configText = New-InstallerConfig $values
        $tempConfig = Join-Path (Split-Path -Parent $config) ('.config-install-' + [Guid]::NewGuid().ToString('N') + '.php')
        try {
            [IO.File]::WriteAllText($tempConfig, $configText, $utf8)
            Set-Access $tempConfig @('*S-1-5-18:F', '*S-1-5-32-544:F', "*${sid}:R") $true
            & $php -l $tempConfig | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'The generated PHP configuration failed syntax validation.' }
            Move-Item -LiteralPath $tempConfig -Destination $config -Force
        } finally { if (Test-Path -LiteralPath $tempConfig) { Remove-Item -LiteralPath $tempConfig -Force } }
    } else {
        Write-Host 'Existing configuration preserved. Custom cache/log locations and their permissions must be verified manually.'
        & $php -l $config | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'The existing configuration failed PHP syntax validation.' }
    }
    Register-MonitorTask $php $destination $taskName $interval
    Write-Host ''
    Write-Host "Deployed to: $destination"
    Write-Host "Scheduled task: $taskName, every $interval minutes, Local System."
    Write-Host 'IMPORTANT: verify IIS request filtering is enabled and the application URL works over HTTPS.'
    Write-Host 'From an unauthenticated browser, confirm /includes/config.local.php and files in /cache, /logs and /tools cannot be accessed (403/404).'
    Write-Host 'Check the IIS PHP handler and app-pool identity, and check permissions for any external cache/log paths.'
    Write-Host 'In Topics & summaries > Keyword Watch, save phrases and recipients and enable alerts for each domain.'
    Write-Host 'Run the task manually, check its result and application logs, then verify PBX and SMTP delivery with a real call.'
    Write-Host 'The installer does not verify live PBX credentials, SMTP delivery, recording access or the PBX month/time-window semantics.'
} catch {
    Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($null -ne $values) { $values.Clear() }
}
