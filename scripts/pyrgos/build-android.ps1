# Local Android build for Pyrgos Paseo: no EAS cloud, no signing secrets. Twin of build-android.sh.
# Usage: scripts/pyrgos/build-android.ps1 [debug|production|both]   (default: both)
# Env (all optional): JAVA_HOME (JDK 17-21), ANDROID_HOME, PYRGOS_APK_OUT, PYRGOS_ABIS ("all" = every ABI),
#   EXPO_PUBLIC_LOCAL_DAEMON.
param([ValidateSet('debug', 'production', 'both')][string]$Target = 'both')
$ErrorActionPreference = 'Stop'

function Run($exe, [string[]]$a) {
  & $exe @a
  if ($LASTEXITCODE -ne 0) { throw "$exe failed ($LASTEXITCODE)" }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$app = Join-Path $root 'packages/app'
$out = if ($env:PYRGOS_APK_OUT) { $env:PYRGOS_APK_OUT } else { Join-Path $root 'artifacts/pyrgos' }

$javaOk = $env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME/bin/java*") -and ((& "$env:JAVA_HOME/bin/java" -version 2>&1 | Out-String) -match 'version "(17|18|19|20|21)\.')
if (-not $javaOk) { throw 'Set JAVA_HOME to a JDK 17-21 (see docs/pyrgos/BUILD.md).' }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
if (-not (Test-Path (Join-Path $env:ANDROID_HOME 'platforms'))) { throw "Android SDK not found at $env:ANDROID_HOME (see docs/pyrgos/BUILD.md)." }
$sep = [IO.Path]::PathSeparator
$env:PATH = "$env:JAVA_HOME/bin$sep$env:ANDROID_HOME/platform-tools$sep$env:PATH"

$abis = if ($env:PYRGOS_ABIS) { $env:PYRGOS_ABIS } else { 'arm64-v8a' }
if ($abis -eq 'all') { $abis = 'armeabi-v7a,arm64-v8a,x86,x86_64' }

# Debug keystore for release signing: generated once, never committed, not a secret.
$ks = if ($env:PYRGOS_DEBUG_KEYSTORE) { $env:PYRGOS_DEBUG_KEYSTORE } else { Join-Path $HOME '.android/debug.keystore' }
if (-not (Test-Path $ks)) {
  New-Item -ItemType Directory -Force (Split-Path $ks) | Out-Null
  Run 'keytool' @('-genkeypair', '-keystore', $ks, '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey',
    '-dname', 'CN=Android Debug,O=Android,C=US', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000')
}

New-Item -ItemType Directory -Force $out | Out-Null
$out = (Resolve-Path $out).Path
Push-Location $root
# npm blocks these native-asset postinstalls (allowScripts); run them explicitly.
Push-Location (Join-Path $app 'node_modules/react-native-enriched-markdown'); Run 'node' @('postinstall.mjs'); Pop-Location
Push-Location (Join-Path $app 'node_modules/@shopify/react-native-skia'); Run 'node' @('scripts/install-libs.js'); Pop-Location
Run 'npm' @('run', 'build:app-deps')
Set-Location $app
$env:APP_VARIANT = 'production'
Run 'npx' @('expo', 'prebuild', '--platform', 'android', '--no-install')
Set-Location (Join-Path $app 'android')
Copy-Item $ks 'app/debug.keystore' -Force

$gradle = if ($IsWindows -or $env:OS -eq 'Windows_NT') { '.\gradlew.bat' } else { './gradlew' }
$ga = @('--no-daemon', '--max-workers=2', '-Dorg.gradle.parallel=false', "-PreactNativeArchitectures=$abis")
if ($Target -in 'debug', 'both') {
  Run $gradle (@('assembleDebug') + $ga)
  Copy-Item 'app/build/outputs/apk/debug/app-debug.apk' (Join-Path $out 'pyrgos-paseo-debug.apk') -Force
}
if ($Target -in 'production', 'both') {
  Remove-Item -Recurse -Force 'app/build/generated/assets' -ErrorAction SilentlyContinue
  Run $gradle (@('assembleRelease') + $ga)
  Copy-Item 'app/build/outputs/apk/release/app-release.apk' (Join-Path $out 'pyrgos-paseo-production.apk') -Force
}
Pop-Location
Write-Output "APKs in ${out}:"
Get-ChildItem (Join-Path $out '*.apk') | Select-Object Name, Length
$aapt2 = Get-ChildItem (Join-Path $env:ANDROID_HOME 'build-tools/*/aapt2*') -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1
if ($aapt2) {
  foreach ($apk in Get-ChildItem (Join-Path $out '*.apk')) { & $aapt2.FullName dump badging $apk.FullName | Select-String -Pattern '^package:|sdkVersion' }
}
