@echo off
REM Laptop-camera test mode: no ESP32 needed. Opens backend + dashboard.
cd /d "%~dp0backend"
pip install -r requirements.txt
start "IISMS backend" cmd /k "set SOURCE=browser&& uvicorn main:app --host 0.0.0.0 --port 8000"
cd /d "%~dp0frontend"
if not exist node_modules call npm install
start "IISMS dashboard" cmd /k "npm run dev"
timeout /t 8 >nul
start http://localhost:3000
