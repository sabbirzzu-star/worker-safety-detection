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
  const sourceLabel = SOURCES.find((source) => source.id === stats?.source)?.label ?? "Connecting";
  const feedState = !online ? "Connecting to server" : noSignal ? "Waiting for camera" : bad ? "Attention required" : "Monitoring active";

  return (
    <main className="min-h-screen">
      <header className="border-b border-line bg-[#151b21]">
        <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-4 px-4 py-3 md:px-6">
          <div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-lg bg-hivis text-sm font-black text-black">IS</div><div><h1 className="text-base font-semibold text-white md:text-lg">Industrial Safety Monitor</h1><p className="hidden text-xs text-mute sm:block">Live PPE compliance</p></div></div>
          <div className="flex items-center gap-2 text-xs"><span className={`status-dot ${online ? "status-dot-ok" : "status-dot-bad"}`} /><span className={online ? "text-ok" : "text-bad"}>{online ? "Online" : "Offline"}</span></div>
        </div>
      </header>

      <div className="mx-auto max-w-[1480px] px-3 py-4 sm:px-5 md:px-6 md:py-6">
        <div className="mb-4 flex items-center justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-[.16em] text-hivis">Live view</p><h2 className="mt-1 text-xl font-semibold text-white md:text-2xl">Camera monitoring</h2></div><div className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${bad ? "border-bad/40 bg-bad/10 text-bad" : noSignal ? "border-warn/40 bg-warn/10 text-warn" : "border-ok/30 bg-ok/10 text-ok"}`}>{feedState}</div></div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          <section className="min-w-0">
            <div className={`relative overflow-hidden rounded-xl border bg-black shadow-2xl ${bad ? "border-bad/60" : "border-line"}`}>
              <div className="feed-toolbar absolute inset-x-0 top-0 z-10 flex items-center justify-between px-3 py-3 sm:px-4"><span className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-white"><span className="status-dot status-dot-live" />ANNOTATED CAMERA</span><span className="rounded bg-black/60 px-2 py-1 text-[11px] text-white/80">{sourceLabel}</span></div>
              {api && /* eslint-disable-next-line @next/next/no-img-element */
                <img key={sourceLabel} src={`${api}/stream?source=${stats?.source ?? "initial"}`} alt="Live annotated camera feed" decoding="async" fetchPriority="high" className="camera-feed block h-auto max-h-[78vh] min-h-[240px] w-full bg-black object-contain" />}
              {noSignal && <div className="absolute inset-0 grid place-items-center bg-black/80 px-5 text-center"><div className="max-w-xs"><div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-warn/15 font-bold text-warn">!</div><p className="font-semibold text-white">No ESP32 frames</p><p className="mt-1 text-xs leading-5 text-mute">Check the board Wi-Fi and SERVER_URL. This view will recover automatically.</p></div></div>}
              {stats?.source_error && <div className="absolute inset-x-0 bottom-0 bg-bad/90 px-3 py-2 text-xs">{stats.source_error}</div>}
            </div>
            <div className="grid grid-cols-3 divide-x divide-line rounded-b-xl border-x border-b border-line bg-panel"><FeedStat label="FPS" value={`${stats?.fps ?? 0}`} /><FeedStat label="Latency" value={`${stats?.latency_ms ?? 0} ms`} /><FeedStat label="Frames" value={`${stats?.frames ?? 0}`} /></div>
          </section>

          <aside className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
              <Metric label="Workers" value={stats?.workers ?? 0} detail="Detected now" />
              <Metric label="Compliant" value={stats?.compliant ?? 0} detail="PPE complete" tone="ok" />
              <Metric label="Violations" value={stats?.violations ?? 0} detail="Needs attention" tone={bad ? "bad" : undefined} />
              <Metric label="Checking" value={stats?.pending ?? 0} detail="Being confirmed" tone="warn" />
            </div>
            <div className="rounded-xl border border-line bg-panel p-3">
              <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-white">Video source</h2><span className="text-[10px] uppercase tracking-wider text-mute">{sourceLabel}</span></div>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-[#11161b] p-1" role="group" aria-label="Video source">{SOURCES.map((s) => <button key={s.id} onClick={() => setSource(s.id)} aria-pressed={stats?.source === s.id} className={`rounded-md px-1 py-2 text-[11px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-hivis ${stats?.source === s.id ? "bg-hivis text-black" : "text-mute hover:bg-[#202931] hover:text-white"}`}>{s.label}</button>)}</div>
            </div>
            <CameraPicker api={api} active={stats?.source === "browser"} />
            <div className="rounded-xl border border-line bg-panel p-3"><div className="mb-2 flex items-center justify-between"><div><h2 className="text-sm font-semibold text-white">Incidents</h2><p className="text-[11px] text-mute">{log.length ? `${log.length} recorded` : "All clear"}</p></div>{log.length > 0 && <button onClick={clearLog} className="rounded px-2 py-1 text-[11px] text-mute hover:bg-[#202931] hover:text-white">Clear</button>}</div><ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-[#11161b]">{log.length === 0 && <li className="p-5 text-center text-xs text-ok">✓ No violations recorded</li>}{log.map((e) => <li key={e.id} className="flex items-center justify-between gap-2 px-2.5 py-2.5"><span className="min-w-0 truncate text-xs text-white"><span className="mr-1.5 text-bad">!</span>{e.item === "hardhat" ? "Hard hat missing" : "Vest missing"} <span className="text-mute">· Worker #{e.worker}</span></span><time className="shrink-0 text-[10px] text-mute">{clock(e.ts)}</time></li>)}</ul></div>
          </aside>
        </div>
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

function Metric({ label, value, detail, tone }: { label: string; value: number; detail: string; tone?: "ok" | "bad" | "warn" }) {
  const c = tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-white";
  return (<div className="rounded-2xl border border-line bg-panel p-4 md:p-5"><div className={`text-3xl font-semibold tracking-tight md:text-4xl ${c}`}>{value}</div><div className="mt-1 text-sm font-medium text-white">{label}</div><div className="mt-1 text-xs text-mute">{detail}</div></div>);
}

function FeedStat({ label, value }: { label: string; value: string }) {
  return <div className="px-3 py-3 md:px-4"><div className="text-sm font-semibold text-white">{value}</div><div className="mt-1 text-[11px] text-mute">{label}</div></div>;
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
      <video ref={videoRef} muted playsInline autoPlay className="mt-3 block w-full rounded-md border border-line bg-black object-contain" />
    </div>
  );
}
