param(
    [string] $JobPath = ""
)

$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$jobPath = if ($JobPath) { $JobPath } else { Join-Path $scriptDir "midx_writer_job.txt" }
$pyHelper = Join-Path $scriptDir "midx_python_writer.py"
$fallbackDebugPath = Join-Path (Split-Path -Parent $jobPath) "midx_writer_job.debug.log"
$debugPath = $fallbackDebugPath

if (Test-Path -LiteralPath $jobPath) {
    Get-Content -LiteralPath $jobPath -Encoding UTF8 | ForEach-Object {
        if ($_ -like "debug_path=*") {
            $value = $_.Substring("debug_path=".Length)
            if ($value) {
                $script:debugPath = $value
            }
        }
    }
}

function Write-HelperLog {
    param([string] $Message)
    Write-Output $Message
    if ($script:debugPath) {
        try {
            Add-Content -LiteralPath $script:debugPath -Value $Message -Encoding UTF8
        } catch {
        }
    }
}

function Get-ExistingCommand {
    param([string[]] $Candidates)
    foreach ($candidate in $Candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command -and $command.Source) {
            return $command.Source
        }
    }
    return $null
}

Write-HelperLog "POWERSHELL_HELPER_PATH=$($MyInvocation.MyCommand.Path)"
Write-HelperLog "POWERSHELL_VERSION=$($PSVersionTable.PSVersion)"
Write-HelperLog "POWERSHELL_SCRIPT_DIR=$scriptDir"
Write-HelperLog "POWERSHELL_CWD=$((Get-Location).Path)"
Write-HelperLog "POWERSHELL_JOB_PATH=$jobPath"
Write-HelperLog "POWERSHELL_PY_HELPER=$pyHelper"

$pyLauncher = Get-ExistingCommand @("C:\Windows\py.exe", "py.exe", "py")
if ($pyLauncher) {
    Write-HelperLog "POWERSHELL_PYTHON=$pyLauncher -3 -u"
    & $pyLauncher -3 -u $pyHelper $jobPath
    $status = $LASTEXITCODE
    Write-HelperLog "POWERSHELL_EXIT=$status"
    exit $status
}

$python = Get-ExistingCommand @(
    "C:\Python314\python.exe",
    "C:\Python313\python.exe",
    "C:\Python312\python.exe",
    "C:\Python311\python.exe",
    "C:\Python310\python.exe",
    "python.exe",
    "python",
    "python3.exe",
    "python3"
)
if ($python) {
    Write-HelperLog "POWERSHELL_PYTHON=$python -u"
    & $python -u $pyHelper $jobPath
    $status = $LASTEXITCODE
    Write-HelperLog "POWERSHELL_EXIT=$status"
    exit $status
}

Write-HelperLog "ERROR_TYPE=PythonNotFound"
Write-HelperLog "ERROR: py/python/python3 was not found"
exit 127
