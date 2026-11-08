"""End-to-end server test with a fake YOLO (no torch needed). Run: python tests/test_server.py"""
import os, sys, time, types
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import numpy as np, cv2

class _T(list):
    def tolist(self): return list(self)
class _Box:
    def __init__(s, cls, conf, xyxy): s.cls, s.conf, s.xyxy = [cls], [conf], [_T(xyxy)]
class _Res: boxes = [_Box(3, .9, (200, 100, 320, 440)),        # Person
                     _Box(5, .8, (205, 190, 315, 330))]         # Vest, no hard hat
class FakeYOLO:
    names = {0: "Gloves", 1: "Hard_hat", 2: "Mask", 3: "Person", 4: "Safety_boots", 5: "Vest"}
    def __init__(s, *_): pass
    def predict(s, *a, **k): return [_Res()]
sys.modules["ultralytics"] = types.SimpleNamespace(YOLO=FakeYOLO)

from fastapi.testclient import TestClient
import main

jpg = cv2.imencode(".jpg", np.full((480, 640, 3), 90, np.uint8))[1].tobytes()
with TestClient(main.app) as c:
    assert c.get("/api/health").json()["ok"]
    for _ in range(4):
        assert c.post("/ingest", content=jpg).json()["ok"]; time.sleep(0.4)
    assert c.post("/ingest", content=b"garbage").status_code == 400
    s = c.get("/api/stats").json()
    assert s["workers"] == 1 and s["violations"] == 1 and s["compliant"] == 0, s
    ev = c.get("/api/events").json()
    assert len(ev) == 1 and ev[0]["item"] == "hardhat", ev          # one alert, not one per frame
    img = cv2.imdecode(np.frombuffer(c.get("/snapshot.jpg").content, np.uint8), 1)
    assert img.shape == (480, 640, 3)
    with c.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "history"
        assert ws.receive_json()["type"] == "stats"
    assert c.post("/api/source", json={"mode": "video", "path": "missing.mp4"}).status_code == 200
    time.sleep(0.5); assert "Cannot open" in c.get("/api/stats").json()["source_error"]
    assert c.post("/api/source", json={"mode": "browser"}).json()["source"] == "browser"
    assert c.post("/ingest", content=jpg).json().get("ok")
    assert c.post("/api/source", json={"mode": "bogus"}).status_code == 400
    assert c.post("/api/source", json={"mode": "esp32"}).json()["source"] == "esp32"
    print("SERVER TEST PASSED", s)
