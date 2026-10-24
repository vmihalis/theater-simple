param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$nodePath = Join-Path $appRoot 'runtime\node.exe'
$serviceUrl = 'http://127.0.0.1:43120'
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Extract All from the ZIP first, then open Start Theater.cmd in the extracted folder.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'This package needs 64-bit Windows.' }
$serverPath = Join-Path $appRoot 'server.mjs'
$appVersion = (Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json).version
function Get-TheaterState { try { Invoke-RestMethod -Uri ($serviceUrl + '/api/state') -TimeoutSec 2 } catch { $null } }
function Get-ServerPath([string]$commandLine) {
    $match = [regex]::Match($commandLine, '(?i)(?:"([^\"]+\\server\.mjs)"|(?:^|\s)([^\s\"]+\\server\.mjs)(?=\s|$))')
    if (-not $match.Success) { return $null }
    $candidate = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    if ($candidate -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)') { return $null }
    return [IO.Path]::GetFullPath($candidate)
}
function Test-OldDesktopProcess($process, [string]$oldRoot) {
    $expected = Join-Path $oldRoot 'runtime\electron\electron.exe'
    return $process.ExecutablePath -and $process.ExecutablePath -ieq $expected
}
$state = Get-TheaterState
if ($state -and $state.app -ne 'theater-simple') { throw 'Another application uses port 43120. Close it before starting Theater Simple.' }
if ($state) {
    # A server left running by another Theater Simple folder would serve that copy's older screens. Only one copy may run.
    $listener = Get-NetTCPConnection -LocalPort 43120 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $owner = if ($listener) { Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" } else { $null }
    $otherServerPath = if ($owner -and $owner.CommandLine) { Get-ServerPath $owner.CommandLine } else { $null }
    if (-not ($otherServerPath -and $otherServerPath -ieq $serverPath)) {
        $otherRoot = if ($otherServerPath) { [IO.Path]::GetDirectoryName($otherServerPath) } else { $null }
        $otherNode = if ($otherRoot) { Join-Path $otherRoot 'runtime\node.exe' } else { $null }
        if (-not ($owner -and $owner.Name -eq 'node.exe' -and $otherNode -and $owner.ExecutablePath -ieq $otherNode)) { throw 'Another copy of Theater Simple is running. Run Stop Theater.cmd in that copy''s folder, then open Start Theater.cmd again.' }
        $otherVersion = if ($state.version) { $state.version } else { 'an older version' }
        Write-Output "Closing Theater Simple $otherVersion running from another folder, so this copy ($appVersion) can start."
        Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object { Test-OldDesktopProcess $_ $otherRoot } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Id $owner.ProcessId -Force
        for ($attempt=0; $attempt -lt 40 -and (Get-TheaterState); $attempt++) { Start-Sleep -Milliseconds 250 }
        if (Get-TheaterState) { throw 'The other Theater Simple copy did not stop. Run Stop Theater.cmd in its folder, then try again.' }
        $state = $null
    }
}
if (-not $state) {
    $process = Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $appRoot 'runtime\server.log') -RedirectStandardError (Join-Path $appRoot 'runtime\server-error.log')
    $process.Id | Set-Content -LiteralPath (Join-Path $appRoot 'runtime\server.pid')
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        try { $state = Invoke-RestMethod -Uri ($serviceUrl + '/api/state') -TimeoutSec 1; break } catch { }
    }
    if (-not $state -or $state.app -ne 'theater-simple') { throw 'The control service did not start. See runtime\server-error.log.' }
}
if (-not $NoBrowser) {
    $desktopRuntime = Join-Path $appRoot 'runtime\electron\electron.exe'
    $desktopFolder = Join-Path $appRoot 'desktop'
    if (Test-Path -LiteralPath $desktopRuntime) {
        Start-Process -FilePath $desktopRuntime -ArgumentList @('"' + $desktopFolder + '"') -WorkingDirectory $appRoot
    } else {
    $edgeCandidates = @((Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'), (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'))
    $edgePath = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($edgePath) { Start-Process -FilePath $edgePath -ArgumentList @('--new-window',$serviceUrl) }
    else { Start-Process $serviceUrl }
    }
}
Write-Output "Theater Simple is ready at $serviceUrl"
