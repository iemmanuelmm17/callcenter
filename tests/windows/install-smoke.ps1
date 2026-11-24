# Run on Windows with: powershell -NoProfile -ExecutionPolicy Bypass -File tests\windows\install-smoke.ps1 -Php C:\php\php.exe
# Pure installer checks only: no IIS changes, ACL changes, or scheduled task registration.
param([Parameter(Mandatory = $true)][string]$Php)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $root 'tools\install-windows.ps1') -LibraryOnly
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
$temp = Join-Path $env:TEMP ('callscope-installer-test-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $temp)
try {
    Test-AssetIntegrity $root
    $values = @{ primary='https://pbx.example'; secondary='https://pbx2.example'; clientId='client'; clientSecret="secret'\`$%&"; monitorKey='key\value'; smtpHost='mail.example'; smtpPort=587; smtpUser='user'; smtpPassword="pa'ss\word"; smtpFrom='sender@example.com'; sipToken='sip\token' }
    $config = Join-Path $temp 'config.local.php'
    [IO.File]::WriteAllText($config, (New-InstallerConfig $values), [Text.UTF8Encoding]::new($false))
    $bytes = [IO.File]::ReadAllBytes($config)
    Assert ($bytes[0] -eq 0x3c -and $bytes[1] -eq 0x3f -and $bytes[2] -eq 0x70 -and $bytes[3] -eq 0x68) 'Config must be UTF-8 without BOM.'
    & $Php -l $config | Out-Host
    Assert ($LASTEXITCODE -eq 0) 'Generated configuration failed PHP lint.'
    $reader = Join-Path $temp 'read-config.php'
    [IO.File]::WriteAllText($reader, '<?php require $argv[1]; echo json_encode([PBX_CLIENT_SECRET, INTELLIGENCE_MONITOR_API_KEY, INTELLIGENCE_SMTP_PASSWORD, PBX_SIP_TOKEN, PBX_SERVERS]);', [Text.UTF8Encoding]::new($false))
    $out = (& $Php $reader $config | Out-String) | ConvertFrom-Json
    Assert ($LASTEXITCODE -eq 0 -and $out[0] -ceq $values.clientSecret -and $out[1] -ceq $values.monitorKey -and $out[2] -ceq $values.smtpPassword -and $out[3] -ceq $values.sipToken) 'PHP values did not round-trip.'
    Assert ($out[4].nms1 -ceq $values.primary -and $out[4].nms2 -ceq $values.secondary) 'PBX servers did not round-trip.'
    $xml = [xml](New-MonitorTaskXml 'C:\PHP Tools\php.exe' 'C:\Call & Scope' 'C:\Call & Scope\tools\intelligence-monitor.php' 5 '2026-11-17T12:00:00')
    Assert ($xml.Task.Principals.Principal.UserId -eq 'S-1-5-18') 'Task does not use Local System.'
    Assert ($xml.Task.Triggers.TimeTrigger.Repetition.Interval -eq 'PT5M') 'Task interval is incorrect.'
    Assert ($xml.Task.Settings.MultipleInstancesPolicy -eq 'IgnoreNew') 'Task permits overlapping instances.'
    Assert ($xml.Task.Actions.Exec.Command -eq 'C:\PHP Tools\php.exe') 'Task executable path changed.'
    Assert ($xml.Task.Actions.Exec.Arguments -eq '"C:\Call & Scope\tools\intelligence-monitor.php"') 'Task argument was not correctly escaped.'
    $original = '<configuration><system.webServer><security><requestFiltering><hiddenSegments><add segment="includes"/><remove segment="includes"/></hiddenSegments></requestFiltering></security><httpProtocol><customHeaders><add name="X-Test" value="keep"/></customHeaders></httpProtocol></system.webServer></configuration>'
    [IO.File]::WriteAllText((Join-Path $temp 'web.config'), $original, [Text.UTF8Encoding]::new($false))
    Protect-Iis $temp
    Protect-Iis $temp
    $web = New-Object System.Xml.XmlDocument; $web.Load((Join-Path $temp 'web.config'))
    Assert ($web.SelectSingleNode('/configuration/system.webServer/httpProtocol/customHeaders/add').GetAttribute('value') -eq 'keep') 'Existing IIS settings were lost.'
    foreach ($name in @('includes','cache','logs','tools')) {
        $rules = @($web.SelectNodes('/configuration/system.webServer/security/requestFiltering/hiddenSegments/add') | Where-Object { $_.GetAttribute('segment') -eq $name })
        Assert ($rules.Count -eq 1) "Missing or duplicate IIS rule for $name."
    }
    Write-Host 'WINDOWS INSTALLER SMOKE OK (no IIS or scheduler changes were made)'
} finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -Recurse } }
