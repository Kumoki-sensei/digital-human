#Requires -Version 5.1
<#
.SYNOPSIS
    Digital human dev helper: prepare env + sync deps + launch backend.
    数字人项目开发辅助脚本：环境准备 + 依赖同步 + 启动后端。

.DESCRIPTION
    Run it from anywhere (the script cd's to its own parent = project root):
        pwsh -NoProfile -Command "& '.\scripts\dev.ps1'"
        pwsh -NoProfile -Command "& '.\scripts\dev.ps1' -Check"
        pwsh -NoProfile -Command "& '.\scripts\dev.ps1' -Port 8010 -Open"

    NOTE - the runnable code below is deliberately ASCII-only (no Chinese in strings).
    Windows PowerShell 5.1 on a zh-CN box reads .ps1 as GBK, so a UTF-8 file without
    BOM gets mangled and dies with a bogus "string is missing the terminator" parse
    error. ASCII code runs on both 5.1 and 7.x no matter how the file is saved.
    Prefer pwsh 7 when available (native UTF-8 console).

    Steps performed before launch:
      1. verify uv is on PATH (prints install hints and exits 1 if missing)
      2. point $env:UV_CACHE_DIR at <root>\.uvcache (uv's C: default is refused here)
      3. copy .env.example -> .env when .env is missing, and tell you to fill keys
      4. uv sync (skip with -SkipSync)
      5. warn (do not block) when Cubism Core / Live2D models are missing
      6. launch `uv run python -m backend --host --port [--reload]` and print URLs

.PARAMETER Port
    Backend port. Default 8000.

.PARAMETER Reload
    Pass --reload to uvicorn (auto restart on code change). Default on.
    Accepts any of: -Reload 0 | -Reload false | -Reload:$false | -Reload off
    (a plain string is accepted and normalised, because cmd.exe strips the `$`
    when a .bat forwards the argument - see the note in the param block).

.PARAMETER Check
    Only run tools/check_env.py (environment self-check); do not start the server.

.PARAMETER Open
    Open http://127.0.0.1:<Port>/ in the default browser a few seconds after launch.

.PARAMETER BindHost
    Bind address. Default 127.0.0.1. (Named BindHost because $Host is a read-only
    PowerShell automatic variable - `param([string]$Host)` is a hard error.)

.PARAMETER SkipSync
    Skip uv sync (deps already installed).

.PARAMETER Extras
    Extra optional dependency groups for uv sync, e.g. -Extras local-asr,local-tts.

.EXAMPLE
    pwsh -NoProfile -Command "& '.\scripts\dev.ps1' -Check"

.EXAMPLE
    pwsh -NoProfile -Command "& '.\scripts\dev.ps1' -Port 8010 -Open"
#>

[CmdletBinding()]
param(
    [int]$Port = 8000,
    # NOTE: keep this as [bool] and keep the param block ASCII-only.
    # Adding a Chinese comment inside param() breaks parameter binding under
    # Windows PowerShell 5.1 (the file has no BOM, so it is read as GBK and the
    # parameter name stops being recognised: "A parameter cannot be found").
    # Prose belongs in the comment-based help above, or outside this block.
    [bool]$Reload = $true,
    [switch]$Check,
    [switch]$Open,
    [string]$BindHost = '127.0.0.1',
    [switch]$SkipSync,
    [string[]]$Extras = @()
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------
function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host ('=' * 74) -ForegroundColor DarkGray
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host ('=' * 74) -ForegroundColor DarkGray
}

function Write-Ok([string]$Text)   { Write-Host "  [OK]   $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "  [WARN] $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "  [FAIL] $Text" -ForegroundColor Red }
function Write-Dim([string]$Text)  { Write-Host "         $Text" -ForegroundColor Gray }

Write-Head 'Digital Human dev launcher'

# ---------------------------------------------------------------------------
# locate project root (this script lives in <root>\scripts\)
# ---------------------------------------------------------------------------
$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
    $ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$ProjectRoot = Split-Path -Parent $ScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'pyproject.toml'))) {
    Write-Fail "pyproject.toml not found; put this script in <project root>\scripts\. Guessed root: $ProjectRoot"
    exit 1
}
Set-Location -LiteralPath $ProjectRoot
Write-Dim "project root: $ProjectRoot"

# ---------------------------------------------------------------------------
# 1. uv
# ---------------------------------------------------------------------------
$uvCmd = Get-Command uv -ErrorAction SilentlyContinue
if ($null -eq $uvCmd) {
    Write-Fail 'uv is not on PATH. There is no usable `python` on this machine'
    Write-Dim '(`python` points at the Windows Store stub), so uv is mandatory.'
    Write-Host ''
    Write-Host '  Install uv (pick one, then reopen the terminal):' -ForegroundColor Yellow
    Write-Host '    powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
    Write-Host '    winget install --id astral-sh.uv -e'
    Write-Host ''
    exit 1
}
Write-Ok "uv: $($uvCmd.Source)"

# ---------------------------------------------------------------------------
# 2. uv cache inside the project (uv's default C: cache is refused on this box)
# ---------------------------------------------------------------------------
$CacheDir = Join-Path $ProjectRoot '.uvcache'
if (-not (Test-Path -LiteralPath $CacheDir)) {
    New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
}
if ([string]::IsNullOrWhiteSpace($env:UV_CACHE_DIR) -or $env:UV_CACHE_DIR -ne $CacheDir) {
    $env:UV_CACHE_DIR = $CacheDir
}
Write-Ok "UV_CACHE_DIR = $env:UV_CACHE_DIR"

if (-not [string]::IsNullOrWhiteSpace($env:UV_PYTHON_INSTALL_DIR)) {
    Write-Dim "UV_PYTHON_INSTALL_DIR = $($env:UV_PYTHON_INSTALL_DIR)"
}

# uv is invoked via the call operator with array splatting on purpose:
# `& $uvExe @args` passes each element as its own argument. (A helper function
# with [Parameter(ValueFromRemainingArguments)] does NOT survive array splatting
# on Windows PowerShell 5.1 - it collapses the array into one string.)
$uvExe = $uvCmd.Source

# ---------------------------------------------------------------------------
# 3. .env
# ---------------------------------------------------------------------------
$EnvFile = Join-Path $ProjectRoot '.env'
$EnvExample = Join-Path $ProjectRoot '.env.example'
if (Test-Path -LiteralPath $EnvFile) {
    Write-Ok '.env exists (your settings are left untouched)'
} elseif (Test-Path -LiteralPath $EnvExample) {
    Copy-Item -LiteralPath $EnvExample -Destination $EnvFile -Force
    Write-Note 'created .env from .env.example -> now fill in your API keys'
    Write-Dim '.env is git-ignored and never committed; do not put real keys in any tracked file.'
} else {
    Write-Note 'neither .env nor .env.example exists; built-in defaults will be used (echo mode)'
}

# ---------------------------------------------------------------------------
# 4. dependency sync
# ---------------------------------------------------------------------------
if ($SkipSync) {
    Write-Note 'skipping uv sync (-SkipSync)'
} else {
    Write-Host '  [..]   uv sync: installing dependencies (first run is slow)...' -ForegroundColor Cyan
    $syncArgs = @('sync')
    foreach ($extra in $Extras) {
        if (-not [string]::IsNullOrWhiteSpace($extra)) {
            $syncArgs += '--extra'
            $syncArgs += $extra.Trim()
        }
    }
    & $uvExe @syncArgs
    $syncCode = $LASTEXITCODE
    if ($syncCode -ne 0) {
        Write-Fail "uv sync failed (exit $syncCode). Usual causes: no network/proxy, or cache dir not writable."
        Write-Dim "retry with: `$env:UV_CACHE_DIR='$CacheDir'; uv sync"
        exit 1
    }
    Write-Ok 'dependencies synced'
}

# ---------------------------------------------------------------------------
# 5. self-check / asset hints
# ---------------------------------------------------------------------------
if ($Check) {
    Write-Head 'environment self-check only (-Check); server not started'
    $checkArgs = @('run', 'python', 'tools/check_env.py')
    & $uvExe @checkArgs
    $checkCode = $LASTEXITCODE
    if ($checkCode -eq 0) {
        Write-Ok 'all required checks passed; drop -Check to start the backend'
    } else {
        Write-Note "self-check reported problems (exit $checkCode); see the suggestion list above"
    }
    exit $checkCode
}

$coreFile = Join-Path $ProjectRoot 'assets\cubism\live2dcubismcore.min.js'
if (Test-Path -LiteralPath $coreFile) {
    Write-Ok 'Cubism Core is in place'
} else {
    Write-Note 'missing assets\cubism\live2dcubismcore.min.js (proprietary, you must fetch it)'
    Write-Dim 'uv run python tools/fetch_cubism.py --yes-i-agree-to-the-live2d-license'
}

$modelDir = Join-Path $ProjectRoot 'assets\models'
$hasModel = $false
if (Test-Path -LiteralPath $modelDir) {
    $found = @(Get-ChildItem -LiteralPath $modelDir -Recurse -Filter '*.model3.json' -File -ErrorAction SilentlyContinue)
    if ($found.Count -gt 0) {
        $hasModel = $true
        Write-Ok "found $($found.Count) Live2D model(s)"
    }
}
if (-not $hasModel) {
    Write-Note 'no *.model3.json under assets\models\ (page shows no avatar; backend still starts)'
    Write-Dim 'uv run python tools/fetch_sample_model.py'
}

# ---------------------------------------------------------------------------
# 6. port pre-check (socket connect; no netstat parsing)
# ---------------------------------------------------------------------------
$portBusy = $false
try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect($BindHost, $Port, $null, $null)
    $connected = $async.AsyncWaitHandle.WaitOne(300, $false)
    if ($connected -and $client.Connected) { $portBusy = $true }
    $client.Close()
} catch {
    $portBusy = $false
}
if ($portBusy) {
    Write-Fail "$BindHost`:$Port is already in use. Try another port: .\scripts\dev.ps1 -Port 8010"
    Write-Dim "who owns it: Get-NetTCPConnection -LocalPort $Port | Select-Object OwningProcess"
    exit 1
}
Write-Ok "port $Port is free"

# ---------------------------------------------------------------------------
# 7. launch backend
# ---------------------------------------------------------------------------
Write-Head "starting backend on http://$BindHost`:$Port/"
Write-Host '  page:    ' -NoNewline; Write-Host "http://$BindHost`:$Port/" -ForegroundColor Green
Write-Host '  api doc: ' -NoNewline; Write-Host "http://$BindHost`:$Port/docs" -ForegroundColor Green
Write-Host '  health:  ' -NoNewline; Write-Host "http://$BindHost`:$Port/api/health" -ForegroundColor Green
Write-Host '  stop:    Ctrl + C' -ForegroundColor DarkGray
Write-Host ''

if ($Open) {
    Start-Job -ScriptBlock {
        param($Url)
        Start-Sleep -Seconds 3
        try {
            Start-Process $Url | Out-Null
        } catch {
            cmd /c start "" $Url | Out-Null
        }
    } -ArgumentList "http://$BindHost`:$Port/" | Out-Null
    Write-Dim 'browser will open 3s after launch (background job)'
}

$backendArgs = @('run', 'python', '-m', 'backend', '--host', $BindHost, '--port', "$Port")
if ($Reload) { $backendArgs += '--reload' }

Write-Dim "running: uv $($backendArgs -join ' ')"
Write-Host ''

& $uvExe @backendArgs
$backendCode = $LASTEXITCODE

Write-Host ''
if ($backendCode -ne 0) {
    Write-Fail "backend exited with code $backendCode"
    Write-Dim 'debug order: 1) uv run python tools/check_env.py  2) read the traceback above'
} else {
    Write-Ok 'backend exited cleanly'
}
exit $backendCode
