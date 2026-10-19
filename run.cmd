@echo off
rem Same tasks as start.ps1, in a form Windows will always run.
rem
rem PowerShell refuses to execute .ps1 files when the execution policy is
rem Restricted, which is the default on a plain Windows install and cannot be
rem worked around from inside the script. A .cmd is not a "script" by that
rem definition, so this runs regardless of the policy.
rem
rem   run.cmd                 start the board and the scraper together
rem   run.cmd worker          start the scraper only (the board is on Vercel)
rem   run.cmd funnel          publish the board on a permanent https URL (Tailscale)
rem   run.cmd tunnel          publish it on a throwaway URL instead (cloudflared)
rem   run.cmd scrape          run one scrape and exit
rem   run.cmd login-check     verify the stored cookies still authenticate
rem   run.cmd smoke           run every query against the configured database
rem   run.cmd last-login      backfill clients.last_login_at      (add --apply)
rem   run.cmd my-bids         rebuild my proposal state           (add --apply)
rem   run.cmd clean-tests     remove accounts left by the suites
rem   run.cmd reset           empty the database (needs --scope, see the script)
rem   run.cmd proposals       count every proposal from the Workana inbox
rem   run.cmd migrate         copy the local SQLite corpus into Postgres (add --apply)
rem   run.cmd backup          copy the database to data\backups (add --keep=N)
rem
rem Settings go in data\local.env, one NAME=value per line, for example
rem
rem   DATABASE_URL=postgresql://user:password@host/db?sslmode=require
rem
rem Every task reads it, so a connection string is written down once instead of
rem being retyped into each shell. data\ is gitignored, so it never reaches the
rem repository. A variable already set in the shell wins over the file.
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

rem A tunnel is not a Node task: cloudflared connects out to Cloudflare and
rem forwards requests to the board on loopback, so nothing has to be opened on
rem the router and the board never binds a public address.
rem Set before the block below: everything inside parentheses is expanded when
rem the block is read, so a variable set in it would still look empty here.
if "%PORT%"=="" set "PORT=4300"

set "SCRIPT="
set "ROLEARG="
if /i "%TASK%"=="start"       set "SCRIPT=src\server.js"
if /i "%TASK%"=="worker"      (set "SCRIPT=src\server.js" & set "ROLEARG= --role=worker")
if /i "%TASK%"=="scrape"      set "SCRIPT=src\cli\scrape.js"
if /i "%TASK%"=="login-check" set "SCRIPT=src\cli\login-check.js"
if /i "%TASK%"=="verify"      set "SCRIPT=scripts\verify.mjs"
if /i "%TASK%"=="smoke"       set "SCRIPT=scripts\smoke.mjs"
if /i "%TASK%"=="last-login"  set "SCRIPT=scripts\backfill-last-login.mjs"
if /i "%TASK%"=="my-bids"     set "SCRIPT=scripts\refresh-my-bids.mjs"
if /i "%TASK%"=="clean-tests" set "SCRIPT=scripts\clean-test-accounts.mjs"
if /i "%TASK%"=="reset"       set "SCRIPT=scripts\reset-database.mjs"
if /i "%TASK%"=="proposals"   set "SCRIPT=scripts\sync-proposals.mjs"
if /i "%TASK%"=="migrate"     set "SCRIPT=scripts\migrate-to-postgres.mjs"
if /i "%TASK%"=="backup"      set "SCRIPT=scripts\backup.mjs"
if /i "%TASK%"=="tunnel"      set "SCRIPT=scripts\tunnel.mjs"
if /i "%TASK%"=="funnel"      set "SCRIPT=scripts\funnel.mjs"

if "%SCRIPT%"=="" (
  echo Unknown task "%TASK%".
  echo Tasks: start, worker, funnel, tunnel, scrape, login-check, verify, smoke,
  echo        last-login, my-bids, clean-tests, reset, proposals, migrate, backup
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
"%NODE%" --env-file-if-exists="%ROOT%data\local.env" "%ROOT%%SCRIPT%"%ROLEARG%%ARGS%
exit /b %ERRORLEVEL%
