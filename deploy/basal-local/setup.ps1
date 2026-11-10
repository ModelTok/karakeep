# Installs the native (no Docker) Basal server that Karakeep's recommendation engine talks to, and keeps it running.
#
#   .\setup.ps1                      install or repair, register the scheduled task, start the servers
#   .\setup.ps1 -NoTask              do not register the scheduled task
#   .\setup.ps1 -BaseDir D:\basal    install somewhere else (default: %USERPROFILE%\basal-local)
#
# Safe to run again: anything already installed is verified (checksums) and left alone, an existing API key is kept.
# What it installs (all under BaseDir, nothing system-wide, no administrator rights needed):
#   - llama.cpp, Windows CPU build (pinned release, SHA-256 checked)            llama.cpp\
#   - the basal-2.0-mini Q8_0 GGUF model from Hugging Face (SHA-256 checked)    models\basal-2.0-mini-GGUF\
#   - a Python 3.12 environment with Basal 2.5.3 and CPU PyTorch (via uv)       venv\
#   - api-keys.json (only a SHA-256 digest) and, in deploy\.env, the matching BASAL_API_KEY
#   - supervisor.ps1 and the scheduled task "Karakeep Basal server" (at logon and every 5 minutes)
# Requires: Windows 10/11 x64 and uv (winget install astral-sh.uv). No GPU needed.

param(
    [string]$BaseDir = (Join-Path $env:USERPROFILE 'basal-local'),
    [string]$EnvFile = (Join-Path (Split-Path -Parent $PSScriptRoot) '.env'),
    [switch]$NoTask
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Pinned, verified artefacts. If a download no longer matches, the script stops rather than run unknown code.
$llamaTag = 'b12109'
$llamaZip = "llama-$llamaTag-bin-win-cpu-x64.zip"
$llamaSha = '3486d0092a14dfec4ceae090649cfff4930c73242f01f318aac508b92de58e5d'
$modelRepo = 'Remek/basal-2.0-mini-GGUF'
$modelFile = 'basal-2.0-mini-Q8_0.gguf'
$modelSha = '4a0be62273fa1fbab6e680f94a6144ad339f4a35620e14fa653d7491a2a7e28e'
$modelSmallFiles = 'basal.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja', 'generation_config.json', 'CALIBRATION.json', 'CALIBRATION.llamacpp.json'
$basalTar = 'https://github.com/rkinas/basal/archive/refs/tags/v2.5.3.tar.gz'

function Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Sha256([string]$path) { (Get-FileHash $path -Algorithm SHA256).Hash.ToLower() }

function Download([string]$url, [string]$dest) {
    Invoke-WebRequest $url -OutFile $dest -UseBasicParsing -TimeoutSec 1800
}

$llamaDir = Join-Path $BaseDir 'llama.cpp'
$modelDir = Join-Path $BaseDir 'models\basal-2.0-mini-GGUF'
$venvDir = Join-Path $BaseDir 'venv'
$venvPy = Join-Path $venvDir 'Scripts\python.exe'
New-Item -ItemType Directory -Force -Path $BaseDir, $llamaDir, $modelDir, (Join-Path $BaseDir 'logs') | Out-Null

# 1. llama.cpp (CPU build)
Step "llama.cpp $llamaTag (CPU build)"
if (Test-Path (Join-Path $llamaDir 'llama-server.exe')) {
    Write-Host '    already installed'
} else {
    $zip = Join-Path $BaseDir $llamaZip
    Download "https://github.com/ggml-org/llama.cpp/releases/download/$llamaTag/$llamaZip" $zip
    if ((Sha256 $zip) -ne $llamaSha) { Remove-Item $zip; throw "llama.cpp download does not match the pinned SHA-256; not installing it" }
    Expand-Archive $zip -DestinationPath $llamaDir -Force
    Remove-Item $zip
    Write-Host '    installed (checksum verified)'
}

# 2. the model
Step "model $modelRepo / $modelFile"
$modelPath = Join-Path $modelDir $modelFile
if ((Test-Path $modelPath) -and ((Sha256 $modelPath) -eq $modelSha)) {
    Write-Host '    already downloaded (checksum verified)'
} else {
    Download "https://huggingface.co/$modelRepo/resolve/main/$modelFile" $modelPath
    if ((Sha256 $modelPath) -ne $modelSha) { Remove-Item $modelPath; throw "model download does not match the pinned SHA-256; removed it" }
    Write-Host '    downloaded (checksum verified)'
}
foreach ($f in $modelSmallFiles) {
    $p = Join-Path $modelDir $f
    if (-not (Test-Path $p)) { Download "https://huggingface.co/$modelRepo/resolve/main/$f" $p }
}

# 3. Python environment with Basal (PyTorch is only used for prompt handling, so the CPU build is enough)
Step 'Python environment with Basal 2.5.3'
if (Test-Path (Join-Path $venvDir 'Scripts\basal-serve.exe')) {
    Write-Host '    already installed'
} else {
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uv) { throw 'uv is required: winget install astral-sh.uv' }
    # uv reports progress on stderr, which Windows PowerShell 5.1 turns into a terminating error under 'Stop':
    # relax that for the uv calls and check their exit codes instead.
    function Invoke-Uv {
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { & $uv.Source @args 2>&1 | ForEach-Object { "    $_" } | Write-Host } finally { $ErrorActionPreference = $prev }
        if ($LASTEXITCODE -ne 0) { throw "uv $($args -join ' ') failed (exit code $LASTEXITCODE)" }
    }
    if (Test-Path $venvDir) { Remove-Item $venvDir -Recurse -Force }   # an earlier attempt that did not finish
    Invoke-Uv venv --python 3.12 $venvDir
    Invoke-Uv pip install --python $venvPy torch==2.11.0 --index-url https://download.pytorch.org/whl/cpu
    Invoke-Uv pip install --python $venvPy "basal @ $basalTar"
    if (-not (Test-Path (Join-Path $venvDir 'Scripts\basal-serve.exe'))) { throw 'Basal did not install' }
    Write-Host '    installed'
}

# 4. API key: the server stores only a SHA-256 digest; Karakeep gets the secret through deploy\.env
Step 'API key'
$keysFile = Join-Path $BaseDir 'api-keys.json'
$sha = [System.Security.Cryptography.SHA256]::Create()
function Digest([string]$secret) { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($secret))) -replace '-', '').ToLower() }
$envText = if (Test-Path $EnvFile) { Get-Content $EnvFile -Raw } else { $null }
$envSecret = $null
if ($envText -match '(?m)^BASAL_API_KEY=(\S+)') { $envSecret = $Matches[1] }
if ($envSecret -and (Test-Path $keysFile) -and ((Get-Content $keysFile -Raw | ConvertFrom-Json).keys[0].sha256 -eq (Digest $envSecret))) {
    Write-Host '    key in place and matching deploy\.env'
} else {
    if (-not (Test-Path $EnvFile)) { throw "Cannot find ${EnvFile} - copy deploy\.env.example to deploy\.env first (or pass -EnvFile)" }
    if ($envSecret) {
        $secret = $envSecret   # reuse the one Karakeep already has
    } else {
        $bytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $secret = ([BitConverter]::ToString($bytes) -replace '-', '').ToLower()
        $block = "`r`n# --- Recommendations (see deploy/basal-local/README.md) ---`r`nBASAL_URL=http://host.docker.internal:8000`r`nBASAL_API_KEY=$secret`r`n"
        [IO.File]::AppendAllText($EnvFile, $block)
    }
    $json = '{"keys": [{"name": "karakeep", "sha256": "' + (Digest $secret) + '", "admin": false}]}'
    [IO.File]::WriteAllText($keysFile, $json, (New-Object Text.UTF8Encoding($false)))
    Write-Host '    key written (the secret is in deploy\.env, only its digest is on the server side)'
}

# 5. supervisor + scheduled task
Step 'supervisor and scheduled task'
Copy-Item (Join-Path $PSScriptRoot 'supervisor.ps1') (Join-Path $BaseDir 'supervisor.ps1') -Force
if (-not $NoTask) {
    $name = 'Karakeep Basal server'
    $arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $BaseDir 'supervisor.ps1')`""
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
    $triggers = @(
        (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
    )
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force `
        -Description "Keeps Karakeep's local Basal servers (llama.cpp + basal-serve, on the CPU) running. Script and log: $BaseDir. Pause with Disable-ScheduledTask." | Out-Null
    Write-Host "    registered '$name' (at logon, then every 5 minutes)"
} else {
    Write-Host '    task not registered (-NoTask)'
}

# 6. start now
Step 'starting the servers'
& (Join-Path $BaseDir 'supervisor.ps1')
$ok = $false
try { $ok = ((Invoke-WebRequest 'http://127.0.0.1:8000/health' -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200) } catch { }
if ($ok) { Write-Host '    basal-serve is healthy on 127.0.0.1:8000' -ForegroundColor Green } else { Write-Host "    not healthy: see $BaseDir\logs" -ForegroundColor Red; exit 1 }
Write-Host "`nNext: set BASAL_URL / BASAL_API_KEY in deploy\.env (done above if it was missing), then 'docker compose up -d web'."
