@echo off
rem Start Slate (the app plus sign-in and device-to-device sync) on this computer.
rem Uses Node 24 from fnm when available (system Node 18 is too old).
set "FNM_NODE=%APPDATA%\fnm\node-versions\v24.22.0\installation"
if exist "%FNM_NODE%\node.exe" set "PATH=%FNM_NODE%;%PATH%"
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist dist call npm run build
start "" http://localhost:5183
node server\slate-server.mjs
