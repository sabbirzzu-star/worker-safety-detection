"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type Stats = {
  workers: number; compliant: number; violations: number; pending: number;
  fps: number; latency_ms: number; frames: number;
  source: "esp32" | "browser" | "webcam" | "video"; source_error: string | null; last_input_age: number | null;
};
type Incident = { id: number; ts: number; worker: number; item: "hardhat" | "vest"; message: string };

const SOURCES: { id: Stats["source"]; label: string }[] = [
  { id: "esp32", label: "ESP32-CAM" },
  { id: "browser", label: "Camera" },
  { id: "video", label: "Video file" },
];
const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour12: false });

export default function Dashboard() {
  const [api, setApi] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [log, setLog] = useState<Incident[]>([]);
  const [toasts, setToasts] = useState<Incident[]>([]);
  const [online, setOnline] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setApi(process.env.NEXT_PUBLIC_API_URL || `http://${window.location.hostname}:8000`);
  }, []);

  const pushToasts = useCallback((evs: Incident[]) => {
    setToasts((t) => [...evs, ...t].slice(0, 4));
    evs.forEach((e) => setTimeout(() => setToasts((t) => t.filter((x) => x.id !== e.id)), 6000));
  }, []);

  useEffect(() => {
    if (!api) return;
    let stop = false, retry = 0, timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(api.replace(/^http/, "ws") + "/ws");
      wsRef.current = ws;
      ws.onopen = () => { retry = 0; setOnline(true); };
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.type === "stats") setStats(d);
        else if (d.type === "history") setLog([...d.events].reverse());
        else if (d.type === "violations") { setLog((l) => [...[...d.events].reverse(), ...l].slice(0, 100)); pushToasts([...d.events].reverse()); }
      };
      ws.onclose = () => { setOnline(false); if (!stop) timer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry++)); };
    };
    connect();
    return () => { stop = true; clearTimeout(timer); wsRef.current?.close(); };
  }, [api, pushToasts]);

  const setSource = (mode: string) =>
    fetch(`${api}/api/source`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) })
      .then((r) => r.json()).then(setStats).catch(() => {});
  const clearLog = () => fetch(`${api}/api/events`, { method: "DELETE" }).then(() => setLog([])).catch(() => {});

  const noSignal = stats?.source === "esp32" && (stats.last_input_age === null || stats.last_input_age > 5);
  const bad = (stats?.violations ?? 0) > 0;

  return (
    <main className="mx-auto max-w-[1280px] p-4 md:p-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Industrial Safety Monitor</h1>
          <p className="text-sm text-mute">Hard hat and high-visibility vest compliance, live</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-mute" role="status">
          <span className={`h-2.5 w-2.5 rounded-full ${online ? "bg-ok" : "bg-bad"}`} />
          {online ? "Server connected" : "Server offline, retrying"}
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section>
          <div className={`relative overflow-hidden rounded-md border bg-black ${bad ? "border-bad" : "border-line"}`}>
            {api && /* eslint-disable-next-line @next/next/no-img-element */
              <img src={`${api}/stream`} alt="Live annotated camera feed" className="block aspect-[4/3] w-full object-contain" />}
            {noSignal && (
              <div className="absolute inset-0 grid place-items-center bg-black/70 text-center">
                <div><p className="text-lg font-medium">No frames from the ESP32-CAM</p>
                  <p className="mt-1 text-sm text-mute">Check power, Wi-Fi and SERVER_URL, or switch to Webcam / Video file.</p></div>
              </div>)}
            {stats?.source_error && (
              <div className="absolute inset-x-0 bottom-0 bg-bad/90 px-3 py-2 text-sm">{stats.source_error}</div>)}
          </div>
          <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-1 text-sm text-mute">
            <div className="flex gap-2"><dt>Processing</dt><dd className="text-[#e7ebef]">{stats?.fps ?? 0} FPS</dd></div>
            <div className="flex gap-2"><dt>Frame to annotated</dt><dd className="text-[#e7ebef]">{stats?.latency_ms ?? 0} ms</dd></div>
            <div className="flex gap-2"><dt>Frames</dt><dd className="text-[#e7ebef]">{stats?.frames ?? 0}</dd></div>
          </dl>
        </section>

        <aside className="flex flex-col gap-5">
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line">
            <Metric label="Workers" value={stats?.workers ?? 0} />
            <Metric label="Compliant" value={stats?.compliant ?? 0} tone="ok" />
            <Metric label="Violations" value={stats?.violations ?? 0} tone={bad ? "bad" : undefined} />
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium">Video source</h2>
            <div className="grid grid-cols-3 rounded-md border border-line p-0.5" role="group" aria-label="Video source">
              {SOURCES.map((s) => (
                <button key={s.id} onClick={() => setSource(s.id)} aria-pressed={stats?.source === s.id}
                  className={`rounded px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-hivis ${
                    stats?.source === s.id ? "bg-hivis font-medium text-black" : "text-mute hover:text-white"}`}>
                  {s.label}
                </button>))}
            </div>
          </div>

          <CameraPicker api={api} active={stats?.source === "browser"} />

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium">Incident log</h2>
              {log.length > 0 && <button onClick={clearLog} className="text-xs text-mute underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-hivis">Clear</button>}
            </div>
            <ul className="max-h-[420px] divide-y divide-line overflow-y-auto rounded-md border border-line bg-panel">
              {log.length === 0 && <li className="p-4 text-sm text-mute">No violations recorded.</li>}
              {log.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3 px-3 py-2.5 text-sm">
                  <span><span className="font-medium text-bad">{e.item === "hardhat" ? "No hard hat" : "No vest"}</span>
                    <span className="text-mute">  Worker #{e.worker}</span></span>
                  <time className="text-xs text-mute">{clock(e.ts)}</time>
                </li>))}
            </ul>
          </div>
        </aside>
      </div>

      <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-80 flex-col gap-2" aria-live="assertive">
        {toasts.map((t) => (
          <div key={t.id} className="toast rounded-md border-l-4 border-bad bg-panel px-4 py-3 shadow-lg">
            <p className="font-medium">{t.item === "hardhat" ? "Hard hat missing" : "Safety vest missing"}</p>
            <p className="text-sm text-mute">Worker #{t.worker} at {clock(t.ts)}</p>
          </div>))}
      </div>
    </main>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "ok" | "bad" }) {
  const c = tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : "text-white";
  return (<div className="bg-panel px-3 py-3"><div className={`text-3xl font-semibold ${c}`}>{value}</div><div className="text-xs text-mute">{label}</div></div>);
}

/** Lists every camera the browser can see (laptop, USB, phone-as-webcam) by name and streams the chosen one to /ingest. */
function CameraPicker({ api, active }: { api: string; active: boolean }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [err, setErr] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices) { setErr("Open the dashboard at http://localhost:3000. Cameras need localhost or HTTPS."); return; }
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true }); // permission is needed before names are shown
      tmp.getTracks().forEach((t) => t.stop());
    } catch { /* still try to list; labels may be blank */ }
    try {
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      setDevices(list);
      setDeviceId((id) => (id && list.some((d) => d.deviceId === id) ? id : list[0]?.deviceId ?? ""));
      setErr(list.length ? "" : "No camera found. Allow camera access in the address bar, or connect one.");
    } catch { setErr("Could not list cameras."); }
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);   // plug in a phone, list updates
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [active, refresh]);

  useEffect(() => {
    if (!active || !deviceId || !api) return;
    let stream: MediaStream | null = null, busy = false, timer: ReturnType<typeof setInterval>;
    const canvas = document.createElement("canvas");
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } } });
        const v = videoRef.current!;
        v.srcObject = stream; await v.play(); setErr("");
        timer = setInterval(() => {
          if (busy || !v.videoWidth) return;
          canvas.width = 640; canvas.height = Math.round((640 * v.videoHeight) / v.videoWidth);
          canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
          busy = true;
          canvas.toBlob((b) => {
            if (!b) { busy = false; return; }
            fetch(`${api}/ingest`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: b })
              .catch(() => {}).finally(() => { busy = false; });
          }, "image/jpeg", 0.75);
        }, 350);
      } catch { setErr("Could not open this camera. Close other apps using it (Zoom, Teams) or pick another."); }
    })();
    return () => { clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [active, deviceId, api]);

  return (
    <div className={active ? "" : "hidden"}>
      <label htmlFor="cam" className="mb-2 block text-sm font-medium">Camera</label>
      <div className="flex gap-2">
        <select id="cam" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-hivis">
          {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
        </select>
        <button onClick={refresh} className="rounded-md border border-line px-3 text-sm text-mute hover:text-white focus-visible:ring-2 focus-visible:ring-hivis">Refresh</button>
      </div>
      {err && <p className="mt-2 text-sm text-bad">{err}</p>}
      <p className="mt-2 text-xs text-mute">Phone as webcam: connect it with Phone Link, DroidCam, Iriun or Camo, then press Refresh.</p>
      <video ref={videoRef} muted playsInline className="absolute h-px w-px opacity-0" />
    </div>
  );
}
