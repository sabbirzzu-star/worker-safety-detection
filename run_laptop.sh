#!/bin/sh
# Laptop-camera test mode: no ESP32 needed.
cd "$(dirname "$0")"
(cd backend && pip install -r requirements.txt && SOURCE=browser uvicorn main:app --host 0.0.0.0 --port 8000) &
cd frontend && { [ -d node_modules ] || npm install; } && npm run dev
