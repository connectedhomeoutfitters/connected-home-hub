@echo off
REM Refreshes the CHO Hub test DB from production (see scripts/sync-prod-to-test.js).
REM Wired to a Windows scheduled task ("CHO Hub prod-to-test sync"); also runnable by
REM double-click. Appends output to %USERPROFILE%\cho-hub-sync.log.
REM Ensure ssh + node resolve regardless of the caller's PATH.
set "PATH=C:\Windows\System32\OpenSSH;C:\Program Files\nodejs;%PATH%"
cd /d N:\choHubProject
echo ---------------------------------------------- >> "%USERPROFILE%\cho-hub-sync.log"
node scripts\sync-prod-to-test.js >> "%USERPROFILE%\cho-hub-sync.log" 2>&1
