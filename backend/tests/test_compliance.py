import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from compliance import *

P = (100, 100, 200, 400, .9)          # person 100x300
HAT_ON = (120, 90, 180, 140, .8)      # on head
HAT_BENCH = (400, 380, 450, 420, .9)  # far away on a bench
VEST_ON = (105, 180, 195, 320, .8)

def run(frames, cfg=None):
    tr = SafetyTracker(cfg or Config(cooldown_s=30))
    out = []
    for i, (persons, hats, vests) in enumerate(frames):
        out.append(tr.update(assess_frame(persons, hats, vests, tr.cfg), now=i * 0.4))
    return out

def test_small_hat_passes_where_iou_would_fail():
    assert iou(HAT_ON, zone_of(P, (-0.1, 0.3))) < 0.35        # why plain IoU is wrong
    (_, h, v), = assess_frame([P], [HAT_ON], [VEST_ON], Config())
    assert h and v

def test_hat_on_bench_is_not_compliant():
    (_, h, _), = assess_frame([P], [HAT_BENCH], [VEST_ON], Config())
    assert not h

def test_hat_credited_to_one_person_only():
    P2 = (210, 100, 310, 400, .9)
    res = assess_frame([P, P2], [HAT_ON], [], Config())
    assert [r[1] for r in res] == [True, False]

def test_single_bad_frame_does_not_alert():
    f_ok = ([P], [HAT_ON], [VEST_ON]); f_bad = ([P], [], [VEST_ON])
    res = run([f_ok, f_ok, f_bad, f_ok, f_ok])
    assert all(not a for _, a in res)
    assert res[2][0][0].status == "pending"

def test_persistent_violation_alerts_once_then_cools_down():
    f_bad = ([P], [], [VEST_ON])
    res = run([f_bad] * 10)
    assert res[0][0][0].status == "pending"
    assert res[1][0][0].status == "violation"
    assert sum(len(a) for _, a in res) == 1
    assert res[1][1][0]["item"] == "hardhat"

def test_track_id_stable_when_person_moves():
    moved = (110, 105, 210, 405, .9)
    res = run([([P], [], []), ([moved], [], [])])
    assert res[0][0][0].id == res[1][0][0].id

def test_both_missing_gives_two_alerts():
    res = run([([P], [], [])] * 3)
    assert sum(len(a) for _, a in res) == 2
