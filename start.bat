@echo off
rem Start the offline workspace. Uses Node 24 from fnm when available (system Node 18 is too old).
set "FNM_NODE=%APPDATA%\fnm\node-versions\v24.22.0\installation"
if exist "%FNM_NODE%\node.exe" set "PATH=%FNM_NODE%;%PATH%"
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist dist call npm run build
call npx vite preview --port 5183 --strictPort --open
