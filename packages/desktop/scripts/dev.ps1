$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = (Resolve-Path "$ScriptDir\..").Path
$AppDir = (Resolve-Path "$DesktopDir\..\app").Path
$RootDir = (Resolve-Path "$DesktopDir\..\..").Path

# Build the Electron main process
npm run build:main

# Get a random available port for Metro
$env:EXPO_PORT = (npx get-port-cli).Trim()

# Set EXPO_DEV_URL in the environment so Electron inherits it
$env:EXPO_DEV_URL = "http://localhost:$($env:EXPO_PORT)"

# Allow any origin in dev so Electron on random ports works.
# SECURITY: wildcard CORS is unsafe in production — only acceptable here because
# the daemon binds to localhost and this script is never used for production.
$env:PASEO_CORS_ORIGINS = "*"

Write-Host @"
======================================================
  Paseo Desktop Dev (Windows)
======================================================
  Metro:     http://localhost:$($env:EXPO_PORT)
======================================================
"@

# Launch Metro + Electron together, kill both on exit
& "$RootDir\node_modules\.bin\concurrently" `
    --kill-others `
    --names "metro,electron" `
    --prefix-colors "magenta,cyan" `
    "cd `"$AppDir`" && npx expo start --port $($env:EXPO_PORT)" `
    "npx wait-on tcp:$($env:EXPO_PORT) && npx electron `"$DesktopDir`""
