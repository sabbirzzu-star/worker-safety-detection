# IISMS: Intelligent Industrial Safety Monitoring System

IISMS is a low-cost, real-time PPE monitoring prototype for industrial workspaces. An
ESP32-S3-CAM captures JPEG snapshots, a FastAPI service runs YOLO11n inference
and geometric compliance checks, and a Next.js dashboard shows the annotated stream,
worker metrics, and live violation alerts.

The system is intentionally designed for a reliable academic demonstration: inference
is in memory, events are volatile, and there is no database, authentication layer, or
multi-user administration.

## Architecture

```text
ESP32-S3-CAM (640x480 JPEG, captured every 200 ms)
        |
        | POST /ingest over local Wi-Fi
        v
FastAPI + OpenCV + YOLO11n (backend/best.pt)
        |
        | MJPEG /stream + WebSocket /ws
        v
Next.js dashboard (http://localhost:3000)
```

Repository layout:

```text
backend/
  best.pt                 Trained YOLO model
  main.py                 FastAPI app, inference engine, streaming API
  compliance.py           Spatial PPE checks and temporal worker tracking
  requirements.txt        Python dependencies
  simulate_esp32.py       Sends a local video as ESP32-style JPEG requests
  tests/                   Compliance and server tests
firmware/esp32_cam/
  esp32_cam.ino           ESP32-S3-CAM JPEG uploader firmware
frontend/
  app/page.tsx            Dashboard and browser-camera uploader
  app/globals.css         Dashboard styling
run_laptop.bat            Windows laptop-camera launcher
run_laptop.sh             macOS/Linux laptop-camera launcher
```

## Detection model

`backend/best.pt` contains six classes trained for PPE detection:

```text
Gloves, Hard_hat, Mask, Person, Safety_boots, Vest
```

Hard hats and vests are the enforced requirements. Gloves, masks, and safety boots are
informational detections and can be drawn as grey boxes with `SHOW_OTHER_PPE=1`.

## Requirements

- Python 3.10 or newer
- Node.js 18 or newer and npm
- Arduino IDE or PlatformIO for the ESP32-CAM firmware
- ESP32-S3-CAM with a compatible camera sensor for hardware mode
- A computer and camera on the same local network for ESP32 mode

The backend runs YOLO on the CPU by default. An NVIDIA-compatible PyTorch setup may use
`DEVICE=0`, but CPU and GPU latency should be measured from the dashboard rather than
assumed from model specifications.

## Quick start: laptop camera

This mode needs no ESP32. From the repository root:

**Windows:** double-click `run_laptop.bat`.

**macOS/Linux:**

```bash
./run_laptop.sh
```

The launcher installs missing dependencies, starts the backend in `browser` mode, starts
the dashboard, and opens `http://localhost:3000`. Allow browser camera permission, then
choose a camera in the dashboard. Browser camera access requires `localhost` or HTTPS.

For a useful test scene, stand far enough away that both the head and torso are visible.
With a hard hat and vest, the worker box should become green. Removing required PPE first
shows `CHECKING`, then becomes a red violation after the temporal rule is satisfied.

### Phone as a camera

Connect the phone as a webcam using Windows Phone Link, DroidCam, Iriun, or Camo. Put it
in landscape orientation, choose `Camera` in the dashboard, and press `Refresh` if it is
not listed. Close Zoom, Teams, or other applications that may already own the camera.

## Run manually with the ESP32-CAM

Start the backend in one terminal:

```bash
cd backend
python -m pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Start the dashboard in another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000` and select `ESP32-CAM` as the source.

### Flash the firmware

1. Open `firmware/esp32_cam/esp32_cam.ino`.
2. Set `WIFI_SSID` and `WIFI_PASS` to the same network used by the computer.
3. Set `SERVER_URL` to the computer's LAN address, for example
   `http://192.168.1.100:8000/ingest`. Do not use `localhost` or `127.0.0.1`;
   those addresses refer to the ESP32 itself.
4. Select the exact ESP32-S3-CAM board definition for your hardware, enable PSRAM
   when available, and choose a partition with enough application space.
5. Flash the board and open the serial monitor at 115200 baud. It should print the
   board IP and `Frame sent ... HTTP 200` for successful uploads.
6. Start the backend with `SOURCE=esp32`, start the dashboard, and select `ESP32-CAM`
   as the source.
7. Allow inbound TCP port 8000 through the computer firewall if required.

The firmware captures locally at up to 5 FPS and sends raw JPEG bodies to
`POST /ingest`. Capture and upload run independently: the uploader always sends
the newest completed JPEG and drops stale frames when the network is slower than
the camera. For an internet deployment,
use the HTTPS endpoint exposed by the reverse proxy, for example
`https://api.example.com/ingest`. The uploader reuses the HTTPS connection and
uses bounded timeouts so a slow WAN request cannot build an unbounded camera
buffer. It does not change the camera sensor settings when switching from local
HTTP to HTTPS.

The firmware currently uses `setInsecure()` for TLS because the server CA
certificate is not bundled in the sketch. Use a CA certificate or certificate
bundle before treating the endpoint as production-secure.

The firmware captures VGA JPEG frames approximately every 200 ms, which is up to
5 FPS locally. It uploads the newest available frame without waiting for older
frames, reconnects Wi-Fi when necessary, and keeps camera timing independent of
WAN latency. Use a stable 5V supply; weak power can cause resets.

## Fallback sources

The dashboard can switch between `ESP32-CAM`, browser `Camera`, and `Video file`. A video
file is looped continuously. Configure its path with `VIDEO_PATH`; the default is
`sample.mp4` relative to the backend working directory. You can also simulate the ESP32
request pattern directly:

```bash
cd backend
python simulate_esp32.py path/to/clip.mp4
```

The `browser` source is used by the dashboard camera uploader. The backend also accepts
`webcam` as a local OpenCV source when started with `SOURCE=webcam`.

## Compliance logic

The implementation in `backend/compliance.py` deliberately uses containment rather than
ordinary IoU for PPE placement:

1. Person detections require confidence `>= 0.50`; PPE detections require `>= 0.40`.
2. A hard hat is valid when at least 50% of the hat's own box lies in the person's head
   zone, spanning the top 30% of the person box plus 10% above it.
3. A vest is valid when at least 40% of the vest's own box lies in the torso zone, from
   20% to 80% of the person's height.
4. Each hat and vest is assigned to only one person using the best overlap, so an item on
   a bench or worn by a nearby worker cannot satisfy another worker.
5. A lightweight IoU tracker keeps worker IDs stable between frames.
6. A violation is confirmed by 2 bad frames within the latest 3 frames. The intermediate
   state is `CHECKING`, reducing alerts from one missed detection.
7. The same worker and PPE item alert at most once every 30 seconds.

The dashboard reports the measured `Frame to annotated` latency, processing FPS, worker
count, compliant count, and confirmed violation count.

## Configuration

Set these environment variables before starting the backend:

| Variable          | Default                                          | Purpose                                                  |
| ----------------- | ------------------------------------------------ | -------------------------------------------------------- |
| `MODEL_PATH`      | `backend/best.pt` when run from the project root | YOLO weights path                                        |
| `IMGSZ`           | `416`                                            | Inference image size; use `640` for maximum detail       |
| `CONF_PERSON`     | `0.50`                                           | Person confidence threshold                              |
| `CONF_PPE`        | `0.40`                                           | Hat, vest, and other PPE threshold                       |
| `DEVICE`          | `cpu`                                            | Ultralytics device, such as `cpu` or `0`                 |
| `SOURCE`          | `esp32`                                          | Initial source: `esp32`, `browser`, `webcam`, or `video` |
| `VIDEO_PATH`      | `sample.mp4`                                     | Local video fallback path                                |
| `WEBCAM_INDEX`    | `0`                                              | OpenCV webcam index                                      |
| `LOCAL_FPS`       | `6`                                              | Local webcam/video submission rate                       |
| `REQUIRE_HARDHAT` | `1`                                              | Require a hard hat when set to `1`                       |
| `REQUIRE_VEST`    | `1`                                              | Require a vest when set to `1`                           |
| `SHOW_OTHER_PPE`  | `1`                                              | Draw gloves, masks, and boots when set to `1`            |
| `JPEG_QUALITY`    | `80`                                             | Annotated stream JPEG quality                           |

PowerShell example:

```powershell
$env:CONF_PPE="0.30"
$env:IMGSZ="416"
$env:LOCAL_FPS="4"
uvicorn main:app --host 0.0.0.0 --port 8000
```

## API

| Method   | Route           | Description                                                 |
| -------- | --------------- | ----------------------------------------------------------- | ------- | ------ | --------------------------------------- |
| `POST`   | `/ingest`       | Accept one raw JPEG request body from ESP32 or browser mode |
| `GET`    | `/stream`       | Annotated MJPEG stream for the dashboard                    |
| `GET`    | `/snapshot.jpg` | Latest annotated JPEG                                       |
| `GET`    | `/api/stats`    | Current metrics, source, latency, FPS, and source errors    |
| `GET`    | `/api/events`   | In-memory violation history                                 |
| `DELETE` | `/api/events`   | Clear the current violation history                         |
| `POST`   | `/api/source`   | Change source with `{"mode":"esp32                          | browser | webcam | video"}`; video accepts optional `path` |
| `GET`    | `/api/health`   | Server health and loaded model class names                  |
| `WS`     | `/ws`           | Sends event history, new violations, and stats updates      |

Events and metrics are stored only in process memory. Restarting the backend clears them.

## Tests

Run the pure compliance tests:

```bash
cd backend
python -m pytest tests/test_compliance.py
```

Run the end-to-end server test. It injects a fake YOLO implementation, so it does not
need to load the real model:

```bash
python tests/test_server.py
```

The tests cover spatial hat/vest assignment, bench-item rejection, stable worker IDs,
temporal violation confirmation, alert cooldown behavior, JPEG ingestion, MJPEG snapshots,
WebSocket messages, source switching, and invalid input handling.

## Scope and limitations

Included: multi-class PPE detection, geometric worker-item association, green/red
bounding boxes, live incident logging, browser-camera support, video fallback, and ESP32
snapshot ingestion.

Intentionally excluded: persistent SQL/NoSQL storage, accounts, authentication, user
roles, facial recognition, biometric records, and production-grade fleet management.

This is a proof-of-concept safety aid, not a certified replacement for workplace safety
inspections. Lighting, camera angle, occlusion, model confidence, Wi-Fi quality, and
training-data coverage can affect results.

## Demo checklist

1. Install backend and frontend dependencies before the presentation.
2. Verify the dashboard's measured latency and FPS with the actual demonstration machine.
3. Test the fallback `Camera` or `Video file` source before connecting the ESP32.
4. Capture representative frames from the target room and tune `CONF_PPE` only after
   checking the resulting false positives and false negatives.
5. Confirm the ESP32 has stable power, correct Wi-Fi credentials, the computer's LAN IP,
   and access to backend port 8000.
