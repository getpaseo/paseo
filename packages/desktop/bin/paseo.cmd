@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "RESOURCES_DIR=%SCRIPT_DIR%.."
set "APP_EXECUTABLE=%RESOURCES_DIR%\..\Paseo.exe"
if not exist "%APP_EXECUTABLE%" (
  echo Bundled Paseo executable not found at %APP_EXECUTABLE% 1>&2
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
set "PASEO_NODE_ENV=production"
"%APP_EXECUTABLE%" --disable-warning=DEP0040 "%RESOURCES_DIR%\app.asar.unpacked\dist\daemon\node-entrypoint-runner.js" node-script "%RESOURCES_DIR%\app.asar\node_modules\@getpaseo\cli\dist\index.js" %*
exit /b %errorlevel%
