# IISMS

## Intelligent Industrial Safety Monitoring System

IISMS is a real-time PPE monitoring system for industrial work areas. It captures
JPEG frames from an ESP32-S3 camera (or a laptop/browser camera), runs person and
PPE detection with YOLO, applies spatial and temporal compliance rules, and
publishes an annotated live view with operational metrics and violation alerts.

The project is designed for a reliable prototype and academic demonstration. It
does not currently provide authentication, a database, persistent event storage,
multi-tenant administration, or production-grade TLS certificate validation.

## System architecture

```text
┌──────────────────────┐       raw JPEG POST        ┌──────────────────────────┐
│ ESP32-S3-CAM          │ ─────────────────────────► │ FastAPI inference server │
│ capture + uploader    │       /ingest             │ OpenCV + YOLO + tracker  │
└──────────────────────┘                            └─────────────┬────────────┘
                                                                  │
                                      MJPEG /stream              │ WebSocket /ws
                                                                  │ REST /api/*
                                                                  ▼
                                                      ┌─────────────────────────┐
                                                      │ Next.js monitoring UI   │
                                                      │ desktop + mobile layout │
                                                      └─────────────────────────┘
```

### Runtime flow

1. The ESP32 camera captures a JPEG approximately every 200 ms, up to 5 FPS.
2. A dedicated FreeRTOS uploader task sends the newest completed JPEG to
   `POST /ingest`. Capture does not wait for the previous network request.
3. FastAPI decodes the JPEG and places it in a single latest-frame inference slot.
   If inference is busy, an older pending frame is replaced by the newer frame.
4. YOLO detects people, hard hats, vests, and informational PPE classes.
5. The compliance module assigns PPE to people by geometric containment and
   smooths results across frames with a lightweight IoU tracker.
6. FastAPI encodes the annotated frame as JPEG and exposes it as an MJPEG stream.
7. The dashboard renders the stream and receives statistics and new violation
   events over WebSocket.

This is intentionally a latest-frame-wins design. It prefers a current view over
processing a backlog of stale frames, which keeps WAN deployments responsive.

## Repository layout

```text
.
├── backend/
│   ├── best.pt                 YOLO model weights
│   ├── main.py                 FastAPI app, sources, inference, stream, API
│   ├── compliance.py           PPE geometry, tracking, smoothing, alerts
│   ├── requirements.txt        Python dependencies
│   ├── simulate_esp32.py       Sends image/video frames as JPEG POST requests
│   └── tests/
│       ├── test_compliance.py  Pure compliance and tracking tests
│       └── test_server.py      End-to-end FastAPI test with a fake YOLO model
├── firmware/
│   └── ESP32_S3_CAM_Test/
│       ├── platformio.ini      PlatformIO ESP32-S3 environment
│       └── src/main.cpp        Active ESP32-S3 capture/uploader firmware
├── frontend/
│   ├── app/page.tsx            Dashboard and browser-camera uploader
│   ├── app/globals.css         Dashboard styles and responsive feed rules
│   ├── app/layout.tsx          Page metadata and root layout
│   └── package.json            Next.js scripts and dependencies
├── .github/workflows/deploy.yml
│                               SSH-triggered VPS deployment on main pushes
├── run_laptop.bat              Windows quick launcher
└── run_laptop.sh               macOS/Linux quick launcher
```

Generated directories such as `frontend/node_modules`, `frontend/.next`, Python
virtual environments, and PlatformIO build output should not be committed.

## Requirements

- Python 3.10 or newer
- Node.js 18 or newer and npm
- A machine with enough memory to load the YOLO weights
- PlatformIO Core/IDE for hardware mode
- ESP32-S3-CAM compatible with the pin map in `firmware/ESP32_S3_CAM_Test/src/main.cpp`
- A network path from the ESP32 to the FastAPI server

The backend defaults to CPU inference. A compatible Ultralytics/PyTorch GPU
installation can be selected with `DEVICE=0`; measure actual latency and accuracy
before changing production settings.

## Quick start: laptop/browser camera

This mode does not require an ESP32. From the repository root:

### Windows

```powershell
.\run_laptop.bat
```

The launcher installs backend/frontend dependencies when needed, starts FastAPI
with `SOURCE=browser`, starts Next.js, and opens `http://localhost:3000`.

### macOS/Linux

```bash
chmod +x run_laptop.sh
./run_laptop.sh
```

Allow camera permission in the browser, select **Camera** in the dashboard, and
choose the required camera. Browser camera access requires `localhost` or HTTPS.
To use a phone as a webcam, connect it with a supported webcam bridge such as
Phone Link, DroidCam, Iriun, or Camo, then press **Refresh** in the dashboard.

## Manual local startup

Use separate terminals from the repository root.

### Backend

```powershell
cd C:\Users\mdsha\Desktop\iisms\backend
python -m pip install -r requirements.txt
$env:SOURCE="browser"
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

### Frontend

```powershell
cd C:\Users\mdsha\Desktop\iisms\frontend
npm install
npm run dev
```

Open <http://localhost:3000>.

For ESP32 mode, start the backend with `$env:SOURCE="esp32"` instead. The
dashboard can then select **ESP32-CAM**. `SOURCE` controls which incoming/local
source is accepted; changing the dashboard source calls `POST /api/source`.

### Production-style frontend

```powershell
cd C:\Users\mdsha\Desktop\iisms\frontend
npm run build
npm run start
```

By default, the browser connects to `http://<dashboard-host>:8000`. Set
`NEXT_PUBLIC_API_URL` when the API is on another host:

```powershell
$env:NEXT_PUBLIC_API_URL="https://api.example.com"
npm run build
npm run start
```

## ESP32-S3 hardware setup

The active firmware is [firmware/ESP32_S3_CAM_Test/src/main.cpp](firmware/ESP32_S3_CAM_Test/src/main.cpp).
Its PlatformIO environment is `esp32-s3-devkitc-1`.

Before flashing, edit the local firmware copy and set:

```cpp
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL = "http://192.168.0.2:8000/ingest";
```

Use the FastAPI server's LAN address, not `localhost` or `127.0.0.1`; those
addresses point back to the ESP32. For a deployed reverse proxy, use the HTTPS
ingest URL instead:

```cpp
const char* SERVER_URL = "https://api.example.com/ingest";
```

The server and board must be able to reach each other, and the server firewall
must allow the API port. The firmware's camera pin map, frame size, JPEG quality,
Wi-Fi behavior, and upload buffers are defined in `main.cpp`.

### Build, flash, and monitor

From `firmware/ESP32_S3_CAM_Test`:

```powershell
pio run
pio run --target upload
pio device monitor --baud 115200
```

If more than one board is connected, add the port:

```powershell
pio run --target upload --upload-port COM3
pio device monitor --port COM3 --baud 115200
```

Expected startup output includes the Wi-Fi address, `Camera initialized.`,
the uploader buffer count, and messages such as:

```text
Frame sent: 3500 bytes, HTTPS 200
```

An HTTP 2xx response means FastAPI accepted the JPEG. Repeated skipped-frame
messages indicate uploader buffer pressure; they do not by themselves mean the
camera sensor failed. The uploader keeps the newest frame and discards stale
frames when the network or inference server is slower than capture.

The firmware uses two large PSRAM buffers when PSRAM is available. Without PSRAM
it falls back to two 64 KB buffers when memory permits and reduces capture to
QVGA. It reconnects Wi-Fi after a disconnect and uses bounded HTTPS timeouts.

### Firmware security note

The current firmware calls `WiFiClientSecure::setInsecure()`. This permits
deployment without embedding a CA certificate, but it does not authenticate the
server certificate. Configure a trusted CA certificate or certificate bundle
before using the HTTPS endpoint in a security-sensitive production environment.

Never commit real Wi-Fi credentials, private keys, or deployment secrets.

## Alternative input sources

The backend supports four source modes:

| Mode | Description |
| --- | --- |
| `esp32` | Accepts JPEG uploads from the ESP32 or another HTTP client |
| `browser` | Accepts JPEG frames uploaded by the dashboard browser camera |
| `webcam` | Opens local OpenCV webcam index `WEBCAM_INDEX` |
| `video` | Loops a local video file from `VIDEO_PATH` |

The dashboard exposes ESP32, browser camera, and video-file controls. The
`webcam` source is available through the API/configuration path.

To simulate an ESP32 sender without hardware:

```powershell
cd C:\Users\mdsha\Desktop\iisms\backend
python simulate_esp32.py path\to\clip.mp4 http://localhost:8000
```

The simulator accepts an image, video path, or numeric webcam index. It posts
JPEG data to `/ingest` at approximately 2.5 FPS.

## Backend API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/ingest` | Accept one raw JPEG request body |
| `GET` | `/stream` | Annotated multipart MJPEG stream |
| `GET` | `/snapshot.jpg` | Latest annotated JPEG |
| `GET` | `/api/health` | Health check and loaded model classes |
| `GET` | `/api/stats` | Current source, FPS, latency, worker, and frame metrics |
| `POST` | `/api/source` | Change source; JSON is `{"mode":"esp32"}` or includes `path` |
| `GET` | `/api/events` | Current in-memory violation events |
| `DELETE` | `/api/events` | Clear in-memory events |
| `WS` | `/ws` | History, violation notifications, and stats every 250 ms |

`/ingest` accepts only a raw JPEG body with `Content-Type: image/jpeg`. Frames
larger than 2 MB or invalid JPEG data receive HTTP 400. Uploads are ignored
when the active source is neither `esp32` nor `browser`.

Example request:

```powershell
curl.exe -X POST http://localhost:8000/ingest `
  -H "Content-Type: image/jpeg" `
  --data-binary "@frame.jpg"
```

## Detection and compliance rules

The bundled model contains these classes:

```text
Gloves, Hard_hat, Mask, Person, Safety_boots, Vest
```

Hard hats and vests are enforced requirements. Gloves, masks, and safety boots
are informational detections and can be drawn when `SHOW_OTHER_PPE=1`.

The compliance pipeline:

1. Person detections require confidence `>= 0.50`; PPE detections require
   confidence `>= 0.40`.
2. A hard hat is credited when at least 50% of its own box is inside the
   person's head zone: the top 30% of the person plus 10% above it.
3. A vest is credited when at least 40% of its own box is inside the torso zone:
   20% through 80% of the person height.
4. Each hat and vest can be assigned to only one person, preventing nearby or
   background PPE from satisfying the wrong worker.
5. Worker IDs are maintained with IoU matching and missing tracks survive for
   a small frame window.
6. A missing item becomes a confirmed violation after 2 bad frames in the
   latest 3-frame history. Before confirmation, the worker is `CHECKING`.
7. The same worker/item alert is rate-limited to once every 30 seconds.

Events are held in memory with a maximum of 200 entries and are lost when the
backend restarts.

## Backend configuration

Set environment variables before starting Uvicorn:

| Variable | Default | Description |
| --- | --- | --- |
| `MODEL_PATH` | `backend/best.pt` when run from the project root | YOLO weights |
| `IMGSZ` | `416` | Inference size; `640` favors detail over speed |
| `CONF_PERSON` | `0.50` | Person confidence threshold |
| `CONF_PPE` | `0.40` | PPE confidence threshold |
| `DEVICE` | `cpu` | Ultralytics device, for example `0` for GPU |
| `SOURCE` | `esp32` | Initial source mode |
| `VIDEO_PATH` | `sample.mp4` | Default local video source |
| `WEBCAM_INDEX` | `0` | OpenCV webcam index |
| `LOCAL_FPS` | `6` | Local webcam/video submission pace |
| `REQUIRE_HARDHAT` | `1` | Require hard hat when set to `1` |
| `REQUIRE_VEST` | `1` | Require vest when set to `1` |
| `SHOW_OTHER_PPE` | `1` | Draw gloves/masks/boots when set to `1` |
| `JPEG_QUALITY` | `80` | Annotated output JPEG quality |

Windows example:

```powershell
cd C:\Users\mdsha\Desktop\iisms\backend
$env:SOURCE="esp32"
$env:IMGSZ="416"
$env:JPEG_QUALITY="80"
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Use `IMGSZ=640` when detection detail is more important than CPU throughput.
Use the dashboard's measured `fps` and `latency_ms` values to evaluate changes.

## Deployment

The GitHub Actions workflow at `.github/workflows/deploy.yml` runs for pushes to
`main`. It connects to the configured Hostinger VPS over SSH and executes:

```text
/usr/local/bin/deploy-worker-safety.sh
```

Configure these repository secrets before relying on automatic deployment:

- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_KEY_B64`

The workflow assumes the VPS already has the deployment script, application
dependencies, model weights, reverse proxy, and process manager configured.
The repository workflow itself does not provision those services.

For a public deployment:

1. Run FastAPI behind a process manager and reverse proxy.
2. Serve the dashboard from a stable origin.
3. Configure `NEXT_PUBLIC_API_URL` to the public API origin.
4. Proxy WebSocket upgrades for `/ws` and streaming responses for `/stream`.
5. Expose `/ingest` only over HTTPS and configure the ESP32 endpoint accordingly.
6. Add authentication/rate limiting before exposing the API to the public internet.
7. Replace `setInsecure()` with certificate validation in the firmware.

## Validation

### Backend server regression test

This test injects a fake YOLO implementation, so it does not require Torch or
the model to run:

```powershell
cd C:\Users\mdsha\Desktop\iisms\backend
python tests\test_server.py
```

### Compliance tests

With `pytest` installed:

```powershell
cd C:\Users\mdsha\Desktop\iisms\backend
python -m pytest tests\test_compliance.py
```

### Frontend production build

```powershell
cd C:\Users\mdsha\Desktop\iisms\frontend
npm run build
```

## Troubleshooting

### The dashboard shows “Waiting for camera”

- Confirm the backend is running with `SOURCE=esp32`.
- Confirm the ESP32 `SERVER_URL` uses the server LAN/public address.
- Confirm the board and server can reach each other.
- Check serial output for `HTTPS 200` or `HTTP 200`.
- Check `GET /api/stats`; `last_input_age` should remain low.
- Allow the API port through the server firewall.

### Frames are accepted but the view is slow

HTTP 200 confirms upload acceptance, not completed inference. Check `fps`,
`latency_ms`, and `dropped_inputs` in `/api/stats`. The system intentionally
drops stale frames under load. Lower `IMGSZ`, reduce `JPEG_QUALITY`, improve
network latency, or use a GPU before increasing the camera capture rate.

### The ESP32 prints no application logs

- Monitor at 115200 baud.
- Verify the selected PlatformIO upload port.
- Press the board reset button after opening the monitor.
- Confirm the board's USB/serial mode exposes the application UART.
- Check power and camera wiring.

### The browser camera does not open

Use `http://localhost:3000` or HTTPS, allow camera permission, close other
applications using the camera, and press **Refresh** in the camera selector.

### Port 3000 or 8000 is already in use

Stop the existing development server or choose another port. Do not start a
second copy on the same port.

## License and operational status

No license file is currently included. Treat the repository as an internal
prototype until licensing, authentication, data retention, and production
security requirements are defined.
