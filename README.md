# IISMS: Intelligent Industrial Safety Monitoring System

ESP32-CAM -> FastAPI + YOLO11n (`best.pt`) -> Next.js dashboard.

```
firmware/esp32_cam/esp32_cam.ino   Arduino sketch (VGA JPEG every 400 ms -> POST /ingest)
backend/                           FastAPI server, compliance logic, tests, best.pt
frontend/                          Next.js + Tailwind dashboard
```

## Your model
`best.pt` has **6 classes**: `Gloves, Hard_hat, Mask, Person, Safety_boots, Vest` (YOLO11n, imgsz 640).
Hard hat and vest are enforced. Gloves/mask/boots are drawn as thin grey boxes only (`SHOW_OTHER_PPE=0` hides them).

## Laptop-camera test mode (no ESP32 needed)
Double-click **`run_laptop.bat`** (Windows) or run **`./run_laptop.sh`** (Mac/Linux). It starts the backend
with `SOURCE=browser`, starts the dashboard, and opens http://localhost:3000. Allow camera access when Chrome asks.
Use the **Camera** dropdown to pick the laptop camera or a phone (cameras are listed by name).

- Stand 1.5-3 m from the camera so your head and torso are both visible (the person box must be seen).
- Test it: wear a cap/helmet and a vest -> green. Take the hat off -> "CHECKING", then red with an alert after ~2 frames.
- **Phone as camera:** connect it to the laptop as a webcam, then press **Refresh** in the dashboard.
  Options: Windows Phone Link ("Use as connected camera", appears as *Windows Virtual Camera*), DroidCam, Iriun Webcam, or Camo.
  Put the phone in landscape and prop it up.
- Open the dashboard at `http://localhost:3000` (browsers only allow cameras on localhost or HTTPS).
- Camera not opening? Close Zoom/Teams/browser tabs using it, or pick another camera in the dropdown.
- Slow? Set `IMGSZ=416` and `LOCAL_FPS=4`. Have an NVIDIA GPU? Set `DEVICE=0`.
- Later, with the ESP32: start normally (`SOURCE=esp32`) or click "ESP32-CAM" on the dashboard.

## Run it with the ESP32 (3 terminals)
**1. Backend** (Python 3.10+)
```
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```
**2. Dashboard** (Node 18+)
```
cd frontend
npm install
npm run dev          # http://localhost:3000
```
**3. Camera**: edit `WIFI_SSID`, `WIFI_PASS`, `SERVER_URL` (your PC's LAN IP) in the `.ino`, then flash
(board "AI Thinker ESP32-CAM", partition "Huge APP"). Find your PC IP with `ipconfig` / `ip a`;
allow port 8000 through the firewall.

**No hardware yet?** Use the dashboard's *Webcam* or *Video file* button (video path: env `VIDEO_PATH`,
default `backend/sample.mp4`), or run `python simulate_esp32.py clip.mp4`, which behaves exactly like the ESP32.

## How compliance works (`backend/compliance.py`)
- Person kept at conf >= 0.50, hard hat/vest at >= 0.40 (`CONF_PERSON`, `CONF_PPE`).
- Hard hat counts if >= 50% of the **hat's own box** lies in the head zone (top 30% of the person box, plus 10% above).
  Vest counts if >= 40% of the vest box lies in the torso zone (20%-80% of height).
  I used overlap over the item area instead of IoU: a hat is small next to a head zone, so IoU >= 0.35 would reject correctly worn hats.
- Each hat/vest is credited to **one** person only (best overlap), so a hat on a bench or on a neighbour doesn't count.
- A lightweight tracker gives each worker a stable ID. A violation needs **2 bad frames out of the last 3**
  (shown amber "CHECKING" first, then red). One missed detection at 2-3 FPS will not raise an alert.
- Each worker+item alerts at most once per 30 s (`cooldown_s` in `Config`).

## Settings (environment variables)
`MODEL_PATH, IMGSZ, CONF_PERSON, CONF_PPE, DEVICE (cpu / 0), VIDEO_PATH, WEBCAM_INDEX, LOCAL_FPS, SOURCE (esp32|webcam|video), REQUIRE_HARDHAT, REQUIRE_VEST`
Example (PowerShell): `$env:CONF_PPE="0.3"; uvicorn main:app --host 0.0.0.0 --port 8000`

## API
`POST /ingest` (raw JPEG) · `GET /stream` (MJPEG) · `GET /snapshot.jpg` · `WS /ws` · `GET /api/stats` ·
`GET|DELETE /api/events` · `POST /api/source {"mode":"esp32|webcam|video"}` · `GET /api/health`

## Tests
```
cd backend
python -m pytest tests/test_compliance.py     # logic: 7 tests
python tests/test_server.py                   # whole server with a fake YOLO
```

## Before demo day
1. Run on a real laptop and read the **"Frame to annotated"** figure on the dashboard. That is your true latency. Quote that, not a datasheet number.
2. Capture 200+ frames from your own ESP32-CAM in the demo room and check detections. If hats/vests are missed, lower `CONF_PPE` to 0.3, or fine-tune further with those frames added.
3. Use a good 5V/2A supply and cable (weak power = random ESP32 reboots). Use a phone hotspot or your own router.
4. Rehearse switching to Webcam/Video while the ESP32 is unplugged.
