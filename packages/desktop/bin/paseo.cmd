@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "RESOURCES_DIR=%SCRIPT_DIR%.."
set "APP_EXECUTABLE=%RESOURCES_DIR%\..\Paseo.exe"
if not exist "%APP_EXECUTABLE%" (
  echo Bundled Paseo executable not found at %APP_EXECUTABLE% 1>&2
  exit /b 1
)

set "FIRST_ARG=%~1"
if "%FIRST_ARG%"=="." goto :open_project
if "%FIRST_ARG%"==".." goto :open_project
if "%FIRST_ARG:~0,2%"==".\" goto :open_project
if "%FIRST_ARG:~0,2%"=="./" goto :open_project
if "%FIRST_ARG:~0,3%"=="..\" goto :open_project
if "%FIRST_ARG:~0,3%"=="../" goto :open_project
if "%FIRST_ARG:~0,1%"=="\" goto :open_project
if "%FIRST_ARG:~0,1%"=="/" goto :open_project
if "%FIRST_ARG:~1,2%"==":\" goto :open_project
if "%FIRST_ARG:~1,2%"==":/" goto :open_project
goto :cli_mode

:open_project
for %%I in ("%~1") do set "RESOLVED_PATH=%%~fI"
if not exist "%RESOLVED_PATH%" (
  echo Path does not exist: %RESOLVED_PATH% 1>&2
  exit /b 1
)
if not exist "%RESOLVED_PATH%\NUL" (
  echo Not a directory: %RESOLVED_PATH% 1>&2
  exit /b 1
)
"%APP_EXECUTABLE%" --open-project "%RESOLVED_PATH%"
exit /b %errorlevel%

:cli_mode
set "ELECTRON_RUN_AS_NODE=1"
"%APP_EXECUTABLE%" "%RESOURCES_DIR%\app.asar\dist\daemon\node-entrypoint-runner.js" bare "%RESOURCES_DIR%\app.asar\node_modules\@getpaseo\cli\dist\index.js" %*
exit /b %errorlevel%
