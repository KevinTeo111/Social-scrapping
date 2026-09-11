@echo off
rem Same tasks as start.ps1, in a form Windows will always run.
rem
rem PowerShell refuses to execute .ps1 files when the execution policy is
rem Restricted, which is the default on a plain Windows install and cannot be
rem worked around from inside the script. A .cmd is not a "script" by that
rem definition, so this runs regardless of the policy.
rem
rem   run.cmd                 start the web server
rem   run.cmd scrape          run one scrape and exit
rem   run.cmd login-check     verify the stored cookies still authenticate
rem   run.cmd smoke           run every query against the configured database
rem   run.cmd last-login      backfill clients.last_login_at      (add --apply)
rem   run.cmd my-bids         rebuild my proposal state           (add --apply)
rem   run.cmd clean-tests     remove accounts left by the suites
rem   run.cmd reset           empty the database (needs --scope, see the script)
rem
rem Set DATABASE_URL to work against Postgres instead of the local file.
rem my-bids also needs APP_SECRET: it decrypts a stored Workana session in
rem order to drive the browser.

setlocal
set "ROOT=%~dp0"
set "NODEDIR=%ROOT%.tools\node-v24.20.0-win-x64"
set "NODE=%NODEDIR%\node.exe"

if not exist "%NODE%" (
  echo Local Node runtime not found in %NODEDIR%
  echo Either install Node 22.5+ system-wide, or re-download the portable build.
  exit /b 1
)
set "PATH=%NODEDIR%;%PATH%"

set "TASK=%~1"
if "%TASK%"=="" set "TASK=start"

set "SCRIPT="
if /i "%TASK%"=="start"       set "SCRIPT=src\server.js"
if /i "%TASK%"=="scrape"      set "SCRIPT=src\cli\scrape.js"
if /i "%TASK%"=="login-check" set "SCRIPT=src\cli\login-check.js"
if /i "%TASK%"=="verify"      set "SCRIPT=scripts\verify.mjs"
if /i "%TASK%"=="smoke"       set "SCRIPT=scripts\smoke.mjs"
if /i "%TASK%"=="last-login"  set "SCRIPT=scripts\backfill-last-login.mjs"
if /i "%TASK%"=="my-bids"     set "SCRIPT=scripts\refresh-my-bids.mjs"
if /i "%TASK%"=="clean-tests" set "SCRIPT=scripts\clean-test-accounts.mjs"
if /i "%TASK%"=="reset"       set "SCRIPT=scripts\reset-database.mjs"

if "%SCRIPT%"=="" (
  echo Unknown task "%TASK%".
  echo Tasks: start, scrape, login-check, verify, smoke, last-login, my-bids, clean-tests
  exit /b 1
)

rem Everything after the task name belongs to the script.
set "ARGS="
if not "%~1"=="" shift
:collect
if "%~1"=="" goto run
set ARGS=%ARGS% "%~1"
shift
goto collect

:run
if /i "%TASK%"=="start" (
  echo.
  echo   Starting Workana job board on http://127.0.0.1:4300
  echo.
)
"%NODE%" "%ROOT%%SCRIPT%"%ARGS%
exit /b %ERRORLEVEL%
