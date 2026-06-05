$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = (Resolve-Path "$ScriptDir\..").Path
$AppDir = (Resolve-Path "$DesktopDir\..\app").Path
$RootDir = (Resolve-Path "$DesktopDir\..\..").Path

# Build the Electron main process
npm run build:main

# Prefer Metro's stable default port so dev browser storage keeps the same
# localhost origin across restarts. Fall back only when earlier ports are busy.
$PreviousNoColor = $env:NO_COLOR
$PreviousForceColor = $env:FORCE_COLOR
try {
    $env:NO_COLOR = "1"
    $env:FORCE_COLOR = "0"
    $env:EXPO_PORT = (npx get-port-cli 8081 8082 8083 8084 8085).Trim()
} finally {
    if ($null -eq $PreviousNoColor) {
        Remove-Item Env:\NO_COLOR -ErrorAction SilentlyContinue
    } else {
        $env:NO_COLOR = $PreviousNoColor
    }
    if ($null -eq $PreviousForceColor) {
        Remove-Item Env:\FORCE_COLOR -ErrorAction SilentlyContinue
    } else {
        $env:FORCE_COLOR = $PreviousForceColor
    }
}

# Set EXPO_DEV_URL in the environment so Electron inherits it
$env:EXPO_DEV_URL = "http://localhost:$($env:EXPO_PORT)"

$RemoteDebuggingPort = if ($env:PASEO_ELECTRON_REMOTE_DEBUGGING_PORT) {
    $env:PASEO_ELECTRON_REMOTE_DEBUGGING_PORT
} else {
    "9223"
}
$ExistingElectronFlags = if ($env:PASEO_ELECTRON_FLAGS) {
    "$($env:PASEO_ELECTRON_FLAGS) "
} else {
    ""
}
$env:PASEO_ELECTRON_FLAGS = "$($ExistingElectronFlags)--remote-debugging-port=$RemoteDebuggingPort"

# Allow any origin in dev so Electron on random ports works.
# SECURITY: wildcard CORS is unsafe in production — only acceptable here because
# the daemon binds to localhost and this script is never used for production.
$env:PASEO_CORS_ORIGINS = "*"

# Fully isolate the dev instance from a production Paseo install so `npm run dev`
# works while the installed app is open. Without this the dev build loses the
# Electron single-instance lock to the installed app and quits, and ends up
# pointed at the production daemon, whose CORS allowlist rejects the Metro origin.
# PASEO_HOME defaults to a script-managed dev home. If you override it (to point
# dev at real data), we DON'T touch your config.json — only the managed home gets
# its daemon config seeded below, so we never rewrite a production config.
$DevStateDir = "$DesktopDir\.dev"
if (-not $env:PASEO_HOME) {
    $env:PASEO_HOME = "$DevStateDir\paseo-home"
    $PaseoHomeManaged = $true
} else {
    $PaseoHomeManaged = $false
}
if (-not $env:PASEO_ELECTRON_USER_DATA_DIR) { $env:PASEO_ELECTRON_USER_DATA_DIR = "$DevStateDir\user-data" }
New-Item -ItemType Directory -Force -Path $env:PASEO_HOME, $env:PASEO_ELECTRON_USER_DATA_DIR | Out-Null

$DevDaemonPort = if ($env:PASEO_DEV_DAEMON_PORT) { $env:PASEO_DEV_DAEMON_PORT } else { "6788" }
if (-not $env:PASEO_LISTEN) { $env:PASEO_LISTEN = "127.0.0.1:$DevDaemonPort" }

# Seed the isolated daemon config. The desktop daemon-manager decides whether a
# daemon is already running by reading `daemon.listen` from this config.json
# (it does NOT honor the PASEO_LISTEN env var) and probing that address. Without
# this it reads the default 6767, finds a production daemon there, and connects
# the dev app to prod — whose CORS allowlist then rejects the Metro origin. Pin
# the dev port + wildcard CORS in the file so the dev app starts its OWN daemon.
# ONLY seed the script-managed home: never rewrite a user-supplied PASEO_HOME
# (that could clobber a production config.json with the dev port + wildcard CORS).
if ($PaseoHomeManaged) {
    node -e '
const fs = require("fs");
const [path, port] = [process.argv[1], process.argv[2]];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
cfg.version = cfg.version || 1;
cfg.daemon = cfg.daemon || {};
cfg.daemon.listen = `127.0.0.1:${port}`;
cfg.daemon.cors = cfg.daemon.cors || {};
cfg.daemon.cors.allowedOrigins = ["*"];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
' "$($env:PASEO_HOME)/config.json" $DevDaemonPort
} else {
    Write-Host "  (custom PASEO_HOME - leaving its config.json untouched)"
}

Write-Host @"
======================================================
  Paseo Desktop Dev (Windows)
======================================================
  Metro:      http://localhost:$($env:EXPO_PORT)
  CDP:        http://127.0.0.1:$RemoteDebuggingPort
  Daemon:     $($env:PASEO_LISTEN) (isolated)
  PASEO_HOME: $($env:PASEO_HOME)
  userData:   $($env:PASEO_ELECTRON_USER_DATA_DIR)
======================================================
"@

# Launch Metro + Electron together, kill both on exit
& "$RootDir\node_modules\.bin\concurrently" `
    --kill-others `
    --names "metro,electron" `
    --prefix-colors "magenta,cyan" `
    "cd `"$AppDir`" && `$env:PASEO_WEB_PLATFORM = `"electron`"; npx expo start --port $($env:EXPO_PORT)" `
    "npx wait-on tcp:$($env:EXPO_PORT) && npx electron `"$DesktopDir`""
