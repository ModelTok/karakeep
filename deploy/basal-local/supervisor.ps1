# Basal server supervisor (native Windows, CPU, no Docker).
#
# Keeps two local servers running for Karakeep's recommendation engine:
#   llama-server (llama.cpp, CPU build)  127.0.0.1:8080   runs the Basal model
#   basal-serve  (Basal 2.5.x)           127.0.0.1:8000   the typed-decision API Karakeep talks to
# Both listen on loopback only. Karakeep (in Docker) reaches basal-serve through host.docker.internal:8000,
# with an API key (api-keys.json holds only its SHA-256).
#
# Run by the scheduled task "Karakeep Basal server" at logon and every 5 minutes. Idempotent: healthy servers
# are left alone and a dead one is started.
#
#   .\supervisor.ps1              check, and start whatever is not healthy
#   .\supervisor.ps1 -Restart     restart both
#   .\supervisor.ps1 -Stop        stop both
#   .\supervisor.ps1 -DryRun      log what would be done, change nothing
# Pause the automatic checks:  Disable-ScheduledTask -TaskName 'Karakeep Basal server'

param(
    [switch]$Restart,
    [switch]$Stop,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $base 'logs'
$log = Join-Path $logDir 'supervisor.log'
$llamaExe = Join-Path $base 'llama.cpp\llama-server.exe'
$basalExe = Join-Path $base 'venv\Scripts\basal-serve.exe'
$modelDir = Join-Path $base 'models\basal-2.0-mini-GGUF'
$gguf = Join-Path $modelDir 'basal-2.0-mini-Q8_0.gguf'
$keysFile = Join-Path $base 'api-keys.json'
$llamaUrl = 'http://127.0.0.1:8080'
$basalUrl = 'http://127.0.0.1:8000'
$startTimeoutSec = 120
# Two thirds of the logical processors, leaving the rest for the machine. Measured on a 12-core / 24-thread PC for
# 52 articles: 8 threads 95 s, 12 threads 69 s, 16 threads 64 s.
$threads = [Math]::Max(1, [int][Math]::Round([Environment]::ProcessorCount * 2 / 3))

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log([string]$message) {
    $prefix = if ($DryRun) { '[dry-run] ' } else { '' }
    Add-Content -Path $log -Value ('{0}  {1}{2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $prefix, $message)
    if ((Get-Item $log).Length -gt 262144) { Set-Content -Path $log -Value (Get-Content $log -Tail 1500) }
}

function Test-Healthy([string]$url) {
    try { return ((Invoke-WebRequest "$url/health" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) } catch { return $false }
}

function Stop-Tree([string]$pattern, [string]$what) {
    $procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern -and $_.ProcessId -ne $PID }
    foreach ($p in $procs) {
        if ($DryRun) { Write-Log "would stop $what (pid $($p.ProcessId))"; continue }
        # Killing a parent's tree also ends its children, so a pid listed earlier may already be gone.
        if (-not (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue)) { continue }
        try { & taskkill.exe /PID $p.ProcessId /T /F 2>&1 | Out-Null } catch { }
    }
}

function Stop-Llama { Stop-Tree ([regex]::Escape($llamaExe)) 'llama-server' }
function Stop-Basal { Stop-Tree ([regex]::Escape($basalExe)) 'basal-serve' }

function Wait-Healthy([string]$url) {
    for ($i = 0; $i -lt $startTimeoutSec; $i++) {
        if (Test-Healthy $url) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Start-Llama {
    if ($DryRun) { Write-Log 'would start llama-server'; return $true }
    Start-Process -FilePath $llamaExe -WindowStyle Hidden `
        -ArgumentList @('-m', $gguf, '-c', '8192', '--host', '127.0.0.1', '--port', '8080', '-np', '1', '--threads', $threads) `
        -RedirectStandardOutput (Join-Path $logDir 'llama-out.log') -RedirectStandardError (Join-Path $logDir 'llama-err.log') | Out-Null
    $ok = Wait-Healthy $llamaUrl
    Write-Log ("llama-server (CPU, {0} threads): {1}" -f $threads, $(if ($ok) { 'healthy' } else { "NOT healthy after ${startTimeoutSec}s" }))
    return $ok
}

function Start-Basal {
    if ($DryRun) { Write-Log 'would start basal-serve'; return $true }
    $args = @('--model', $modelDir, '--mode', 'llamacpp', '--llamacpp-url', $llamaUrl, '--host', '127.0.0.1', '--port', '8000',
              '--calibration', (Join-Path $modelDir 'CALIBRATION.llamacpp.json'))
    if (Test-Path $keysFile) { $args += @('--api-keys', $keysFile) }
    Start-Process -FilePath $basalExe -WindowStyle Hidden -ArgumentList $args `
        -RedirectStandardOutput (Join-Path $logDir 'basal-out.log') -RedirectStandardError (Join-Path $logDir 'basal-err.log') | Out-Null
    $ok = Wait-Healthy $basalUrl
    Write-Log ("basal-serve{0}: {1}" -f $(if (Test-Path $keysFile) { ' (API key required)' } else { ' (NO API key file)' }), $(if ($ok) { 'healthy' } else { "NOT healthy after ${startTimeoutSec}s" }))
    return $ok
}

try {
    if ($Stop) {
        Write-Log 'stopping both servers'
        Stop-Basal; Stop-Llama
        exit 0
    }
    if ($Restart) {
        Write-Log 'restart requested'
        Stop-Basal; Stop-Llama
    }

    $llamaOk = (-not $Restart) -and (Test-Healthy $llamaUrl)
    $basalOk = (-not $Restart) -and (Test-Healthy $basalUrl)
    if ($llamaOk -and $basalOk) { exit 0 }

    if (-not $llamaOk) {
        Stop-Llama
        if (-not (Start-Llama)) { Write-Log 'llama-server could not be started'; exit 1 }
    }
    if (-not $basalOk) {
        Stop-Basal
        if (-not (Start-Basal)) { Write-Log 'basal-serve could not be started'; exit 1 }
    }
}
catch {
    Write-Log ('supervisor error: ' + $_.Exception.Message)
    exit 1
}
