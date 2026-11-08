"""IISMS inference server: ESP32-CAM JPEG ingest -> YOLO11n -> compliance -> MJPEG + WebSocket."""
from __future__ import annotations
import asyncio, os, sys, threading, time
from collections import deque

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from compliance import Config, SafetyTracker, assess_frame

# ---------- configuration (override with environment variables) ----------
MODEL_PATH = os.getenv("MODEL_PATH", os.path.join(os.path.dirname(__file__), "best.pt"))
IMGSZ = int(os.getenv("IMGSZ", "640"))
CONF_PERSON = float(os.getenv("CONF_PERSON", "0.50"))
CONF_PPE = float(os.getenv("CONF_PPE", "0.40"))
DEVICE = os.getenv("DEVICE", "cpu")
VIDEO_PATH = os.getenv("VIDEO_PATH", "sample.mp4")
WEBCAM_INDEX = int(os.getenv("WEBCAM_INDEX", "0"))
LOCAL_FPS = float(os.getenv("LOCAL_FPS", "6"))          # pace for webcam / video fallback
INITIAL_SOURCE = os.getenv("SOURCE", "esp32")
REQUIRE_HAT = os.getenv("REQUIRE_HARDHAT", "1") == "1"
REQUIRE_VEST = os.getenv("REQUIRE_VEST", "1") == "1"
SHOW_OTHER_PPE = os.getenv("SHOW_OTHER_PPE", "1") == "1"  # draw gloves/mask/boots (informational)

HAT_NAMES = {"hard_hat", "hardhat", "helmet", "hard-hat"}
VEST_NAMES = {"vest", "safety_vest", "safety-vest"}
COLORS = {"ok": (80, 200, 120), "violation": (60, 60, 235), "pending": (40, 190, 245)}  # BGR
LABEL = {"hardhat": "NO HARDHAT", "vest": "NO VEST"}


class Engine:
    def __init__(self):
        from ultralytics import YOLO
        self.model = YOLO(MODEL_PATH)
        self.names = {int(k): str(v).lower() for k, v in self.model.names.items()}
        self.tracker = SafetyTracker(Config(require_hat=REQUIRE_HAT, require_vest=REQUIRE_VEST))
        self.model.predict(np.zeros((IMGSZ, IMGSZ, 3), np.uint8), imgsz=IMGSZ, device=DEVICE, verbose=False)  # warm-up

        self.lock = threading.Lock()
        self.pending = None
        self.wake = threading.Event()
        self.jpeg = self._placeholder("Waiting for video source...")
        self.frame_id = 0
        self.version = 0
        self.events: deque = deque(maxlen=200)
        self._event_id = 0
        self.stats = dict(workers=0, compliant=0, violations=0, pending=0, fps=0.0, latency_ms=0.0,
                          frames=0, last_input_age=None)
        self.last_input = 0.0
        self._t_prev = None
        self.source = "esp32"
        self._gen = 0
        self.source_error = None
        self.set_source(INITIAL_SOURCE)
        threading.Thread(target=self._loop, daemon=True).start()

    # ----- sources -----
    def set_source(self, mode: str, path: str | None = None):
        if mode not in ("esp32", "browser", "webcam", "video"):
            raise ValueError("mode must be esp32, browser, webcam or video")
        self._gen += 1
        self.source, self.source_error = mode, None
        self.tracker = SafetyTracker(self.tracker.cfg)
        if mode in ("webcam", "video"):
            gen = self._gen
            threading.Thread(target=self._feed_local, args=(mode, path or VIDEO_PATH, gen), daemon=True).start()

    def _feed_local(self, mode, path, gen):
        if mode == "webcam":
            # DirectShow opens faster and more reliably on Windows laptops
            cap = cv2.VideoCapture(WEBCAM_INDEX, cv2.CAP_DSHOW) if sys.platform == "win32" else cv2.VideoCapture(WEBCAM_INDEX)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)      # always the newest frame, no lag
        else:
            cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            self.source_error = (f"Cannot open webcam {WEBCAM_INDEX}. Close other apps using the camera "
                                 f"or set WEBCAM_INDEX=1" if mode == "webcam" else f"Cannot open {path}")
            self.jpeg = self._placeholder(self.source_error[:60])
            return
        period = 1.0 / LOCAL_FPS
        fails = 0
        while gen == self._gen:
            t0 = time.perf_counter()
            ok, frame = cap.read()
            if not ok:
                if mode == "video":
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)   # loop the clip
                    continue
                fails += 1
                if fails > 30:                             # camera warm-up can drop a few frames
                    self.source_error = "Webcam stopped delivering frames"
                    break
                time.sleep(0.1)
                continue
            fails = 0
            self.submit(frame)
            time.sleep(max(0.0, period - (time.perf_counter() - t0)))
        cap.release()

    def submit(self, frame):
        """Latest-frame-wins: if inference is still busy, the older pending frame is dropped."""
        self.last_input = time.time()
        with self.lock:
            self.pending = (frame, time.perf_counter())
        self.wake.set()

    # ----- inference loop -----
    def _loop(self):
        while True:
            self.wake.wait(timeout=1.0)
            self.wake.clear()
            with self.lock:
                item, self.pending = self.pending, None
            if item is None:
                continue
            try:
                self._process(*item)
            except Exception as e:  # keep the server alive on a bad frame
                print("process error:", repr(e))

    def _process(self, frame, t_recv):
        res = self.model.predict(frame, imgsz=IMGSZ, conf=min(CONF_PERSON, CONF_PPE), device=DEVICE, verbose=False)[0]
        persons, hats, vests, others = [], [], [], []
        for b in res.boxes:
            name = self.names.get(int(b.cls[0]), "")
            conf = float(b.conf[0])
            d = (*b.xyxy[0].tolist(), conf)
            if name == "person" and conf >= CONF_PERSON:
                persons.append(d)
            elif name in HAT_NAMES and conf >= CONF_PPE:
                hats.append(d)
            elif name in VEST_NAMES and conf >= CONF_PPE:
                vests.append(d)
            elif conf >= CONF_PPE:
                others.append((name, d))
        now = time.time()
        workers, alerts = self.tracker.update(assess_frame(persons, hats, vests, self.tracker.cfg), now)
        out = self._draw(frame, workers, hats, vests, others)
        ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 80])
        latency = (time.perf_counter() - t_recv) * 1000
        with self.lock:
            if ok:
                self.jpeg = buf.tobytes()
                self.frame_id += 1
            for a in alerts:
                self._event_id += 1
                self.events.append({"id": self._event_id, "ts": now, "worker": a["track_id"], "item": a["item"],
                                    "message": f"Worker #{a['track_id']}: {LABEL[a['item']].lower()}"})
            s = self.stats
            s["workers"] = len(workers)
            s["compliant"] = sum(w.status == "ok" for w in workers)
            s["violations"] = sum(w.status == "violation" for w in workers)
            s["pending"] = sum(w.status == "pending" for w in workers)
            s["latency_ms"] = round(0.8 * s["latency_ms"] + 0.2 * latency, 1) if s["frames"] else round(latency, 1)
            if self._t_prev:
                inst = 1.0 / max(1e-3, time.perf_counter() - self._t_prev)
                s["fps"] = round(0.8 * s["fps"] + 0.2 * inst, 1) if s["fps"] else round(inst, 1)
            self._t_prev = time.perf_counter()
            s["frames"] += 1
            self.version += 1

    def _draw(self, frame, workers, hats, vests, others):
        img = frame.copy()
        for d in hats + vests:
            cv2.rectangle(img, (int(d[0]), int(d[1])), (int(d[2]), int(d[3])), (230, 180, 60), 1)
        if SHOW_OTHER_PPE:
            for name, d in others:
                cv2.rectangle(img, (int(d[0]), int(d[1])), (int(d[2]), int(d[3])), (150, 150, 150), 1)
        for w in workers:
            c = COLORS[w.status]
            x1, y1, x2, y2 = map(int, w.box[:4])
            cv2.rectangle(img, (x1, y1), (x2, y2), c, 2)
            text = f"#{w.id} " + ("OK" if w.status == "ok" else "CHECKING" if w.status == "pending"
                                  else ", ".join(LABEL[m] for m in w.missing))
            (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
            ty = y1 - 6 if y1 > th + 10 else y1 + th + 8
            cv2.rectangle(img, (x1, ty - th - 4), (x1 + tw + 6, ty + 4), c, -1)
            cv2.putText(img, text, (x1 + 3, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        return img

    @staticmethod
    def _placeholder(msg):
        img = np.full((480, 640, 3), 24, np.uint8)
        cv2.putText(img, msg, (30, 245), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (200, 200, 200), 1, cv2.LINE_AA)
        return cv2.imencode(".jpg", img)[1].tobytes()

    def snapshot(self):
        with self.lock:
            s = dict(self.stats)
        s["source"] = self.source
        s["source_error"] = self.source_error
        s["last_input_age"] = round(time.time() - self.last_input, 1) if self.last_input else None
        return s


app = FastAPI(title="IISMS")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
engine: Engine | None = None


@app.on_event("startup")
def _startup():
    global engine
    engine = Engine()


@app.post("/ingest")
async def ingest(request: Request):
    """ESP32-CAM (or the dashboard's browser camera) posts one raw JPEG per request."""
    data = await request.body()
    if engine.source not in ("esp32", "browser"):
        return {"ignored": True}
    frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR) if 0 < len(data) < 2_000_000 else None
    if frame is None:
        raise HTTPException(400, "bad JPEG")
    engine.submit(frame)
    return {"ok": True}


async def _mjpeg():
    last = -1
    while True:
        if engine.frame_id != last or last == -1:
            last = engine.frame_id
            jpg = engine.jpeg
            yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n"
        await asyncio.sleep(0.04)


@app.get("/stream")
async def stream():
    return StreamingResponse(_mjpeg(), media_type="multipart/x-mixed-replace; boundary=frame",
                             headers={"Cache-Control": "no-store"})


@app.get("/snapshot.jpg")
def snapshot():
    return Response(engine.jpeg, media_type="image/jpeg")


class SourceReq(BaseModel):
    mode: str
    path: str | None = None


@app.post("/api/source")
def set_source(req: SourceReq):
    try:
        engine.set_source(req.mode, req.path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return engine.snapshot()


@app.get("/api/stats")
def get_stats():
    return engine.snapshot()


@app.get("/api/events")
def get_events():
    return list(engine.events)


@app.delete("/api/events")
def clear_events():
    engine.events.clear()
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True, "classes": engine.names}


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    last_ver, last_ev = -1, 0
    try:
        await sock.send_json({"type": "history", "events": list(engine.events)})
        last_ev = engine._event_id
        while True:
            new = [e for e in list(engine.events) if e["id"] > last_ev]
            if new:
                last_ev = new[-1]["id"]
                await sock.send_json({"type": "violations", "events": new})
            await sock.send_json({"type": "stats", **engine.snapshot()})
            await asyncio.sleep(0.25)
    except (WebSocketDisconnect, RuntimeError):
        pass
