"""PPE compliance logic: geometric containment + per-worker temporal smoothing.
Pure Python (no torch/cv2) so it can be unit-tested on its own.
A detection is a tuple: (x1, y1, x2, y2, conf)."""
from __future__ import annotations
from collections import deque
from dataclasses import dataclass, field

Box = tuple  # (x1, y1, x2, y2, conf)


@dataclass
class Config:
    head_zone: tuple = (-0.10, 0.30)    # vertical span of head zone, as fraction of person height
    torso_zone: tuple = (0.20, 0.80)    # vertical span of torso zone
    min_overlap_hat: float = 0.50       # fraction of the HARDHAT box that must lie in the head zone
    min_overlap_vest: float = 0.40      # fraction of the VEST box that must lie in the torso zone
    require_hat: bool = True
    require_vest: bool = True
    window: int = 3                     # smoothing window (frames)
    min_bad: int = 2                    # bad frames inside window to confirm a violation
    cooldown_s: float = 30.0            # min seconds between repeated alerts for same worker+item
    max_age: int = 6                    # frames a lost track survives
    match_iou: float = 0.25


def area(b: Box) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def inter(a: Box, b: Box) -> float:
    return area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def iou(a: Box, b: Box) -> float:
    i = inter(a, b)
    u = area(a) + area(b) - i
    return i / u if u > 0 else 0.0


def frac_inside(item: Box, zone: Box) -> float:
    """Intersection over the ITEM's own area (not IoU: a helmet is tiny next to a head zone)."""
    a = area(item)
    return inter(item, zone) / a if a > 0 else 0.0


def zone_of(person: Box, span: tuple) -> Box:
    h = person[3] - person[1]
    return (person[0], person[1] + span[0] * h, person[2], person[1] + span[1] * h, 1.0)


def assess_frame(persons: list, hats: list, vests: list, cfg: Config) -> list:
    """Per-frame check. Each hat/vest is credited to at most one person (the best overlap),
    so a helmet lying on a bench, or one worn by a neighbour, can't make someone compliant."""
    n = len(persons)
    has_hat = [False] * n
    has_vest = [False] * n

    def assign(items, span, thr, out):
        for it in items:
            best, best_f = -1, 0.0
            for i, p in enumerate(persons):
                f = frac_inside(it, zone_of(p, span))
                if f > best_f:
                    best, best_f = i, f
            if best >= 0 and best_f >= thr:
                out[best] = True

    assign(hats, cfg.head_zone, cfg.min_overlap_hat, has_hat)
    assign(vests, cfg.torso_zone, cfg.min_overlap_vest, has_vest)
    return [(persons[i], has_hat[i], has_vest[i]) for i in range(n)]


@dataclass
class Track:
    id: int
    box: Box
    hist: deque
    missed: int = 0
    seen: int = 0
    last_alert: dict = field(default_factory=dict)


@dataclass
class WorkerState:
    id: int
    box: Box
    hat_ok: bool
    vest_ok: bool
    status: str            # "ok" | "pending" | "violation"
    missing: list          # confirmed missing items, e.g. ["hardhat"]


class SafetyTracker:
    def __init__(self, cfg: Config | None = None):
        self.cfg = cfg or Config()
        self.tracks: dict[int, Track] = {}
        self._next = 1

    def update(self, assessed: list, now: float):
        """assessed: output of assess_frame. Returns (workers, alerts)."""
        cfg = self.cfg
        matched: dict[int, int] = {}
        pairs = sorted(
            ((iou(t.box, a[0]), tid, ai) for tid, t in self.tracks.items() for ai, a in enumerate(assessed)),
            reverse=True)
        used_t, used_a = set(), set()
        for score, tid, ai in pairs:
            if score < cfg.match_iou:
                break
            if tid in used_t or ai in used_a:
                continue
            used_t.add(tid); used_a.add(ai); matched[ai] = tid
        for ai in range(len(assessed)):
            if ai not in matched:
                tid = self._next; self._next += 1
                self.tracks[tid] = Track(tid, assessed[ai][0], deque(maxlen=cfg.window))
                matched[ai] = tid
        live = set(matched.values())
        for tid, t in list(self.tracks.items()):
            if tid not in live:
                t.missed += 1
                if t.missed > cfg.max_age:
                    del self.tracks[tid]

        workers, alerts = [], []
        for ai, (box, hat, vest) in enumerate(assessed):
            t = self.tracks[matched[ai]]
            t.box, t.missed = box, 0
            t.seen += 1
            t.hist.append((cfg.require_hat and not hat, cfg.require_vest and not vest))
            hat_bad = sum(h[0] for h in t.hist) >= cfg.min_bad
            vest_bad = sum(h[1] for h in t.hist) >= cfg.min_bad
            missing = (["hardhat"] if hat_bad else []) + (["vest"] if vest_bad else [])
            if missing:
                status = "violation"
            elif any(t.hist[-1]):
                status = "pending"
            else:
                status = "ok"
            for item in missing:
                if now - t.last_alert.get(item, -1e18) >= cfg.cooldown_s:
                    t.last_alert[item] = now
                    alerts.append({"track_id": t.id, "item": item})
            workers.append(WorkerState(t.id, box, hat, vest, status, missing))
        return workers, alerts
