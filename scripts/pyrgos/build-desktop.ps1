# Desktop installer build for Pyrgos Paseo (Electron). Run on the Windows PC; twin of build-desktop.sh.
# Usage: scripts/pyrgos/build-desktop.ps1
# Output: packages/desktop/release/ (installer + latest*.yml). Copy it out of git; it is gitignored.
$ErrorActionPreference = 'Stop'
function Run($exe, [string[]]$a) { & $exe @a; if ($LASTEXITCODE -ne 0) { throw "$exe failed ($LASTEXITCODE)" } }
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $root
try {
  Run 'npm' @('ci')
  Run 'npm' @('run', 'build:desktop')
  Get-ChildItem packages/desktop/release | Select-Object Name, Length
} finally { Pop-Location }
