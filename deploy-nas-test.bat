@echo off
:: ============================================================
:: CHO Hub -> NAS TEST Deploy
:: Syncs N:\choHubProject (source) to W:\choHubProject (NAS test
:: instance) via gulp. PM2 there runs in watch mode (see
:: ecosystem.nas-test.config.js) so it picks up the change and
:: restarts on its own -- no flag file or Task Scheduler needed.
:: Requires: nginx conf + PM2 process already set up on the NAS
:: (one-time, see nginx/www.chohub.conf).
:: ============================================================
set NAS_HOST=masinet.synology.me
set SRC=N:\choHubProject

echo.
echo  Syncing files to W:\choHubProject via gulp...
cd /d "%SRC%"
call npx gulp build
if %ERRORLEVEL% neq 0 (
    echo  ERROR: gulp build failed. Aborting.
    pause & exit /b 1
)
echo  Sync complete -- PM2 watch mode will restart cho-hub-test automatically.
echo.
echo  https://%NAS_HOST%/choHubProject
echo.
pause
