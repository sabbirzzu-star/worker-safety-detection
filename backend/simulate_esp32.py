"""Pretend to be the ESP32-CAM: POST frames from an image/video/webcam to /ingest at ~2.5 FPS.
Usage: python simulate_esp32.py [image.jpg | video.mp4 | 0] [http://localhost:8000]"""
import sys, time, cv2, requests
src = sys.argv[1] if len(sys.argv) > 1 else "0"
url = (sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8000") + "/ingest"
img = None if src.isdigit() or src.endswith((".mp4", ".avi", ".mov")) else cv2.imread(src)
cap = None if img is not None else cv2.VideoCapture(int(src) if src.isdigit() else src)
while True:
    if img is not None: frame = img
    else:
        ok, frame = cap.read()
        if not ok:
            if src.isdigit(): break
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0); continue
    frame = cv2.resize(frame, (640, 480))
    requests.post(url, data=cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])[1].tobytes(),
                  headers={"Content-Type": "image/jpeg"}, timeout=3)
    time.sleep(0.4)
