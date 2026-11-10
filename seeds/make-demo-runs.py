"""Write seeds/demo-runs.jsonl: SYNTHETIC runs that show what the Runs tab looks like.

Not a result of any experiment. Every run has an id starting with "demo-", the tag "demo",
and a note saying it is synthetic, so it can be told apart and removed (Runs tab →
"Remove demo runs"). Deterministic: the same file on every run of this script.

    python3 seeds/make-demo-runs.py
"""

import json
import math
import random
from pathlib import Path

OUT = Path(__file__).with_name("demo-runs.jsonl")
T0 = 1_767_225_600_000  # 2026-01-01T00:00:00Z; the app shifts times to now when loading
STEPS = 600
STEP_MS = 1500
NOTE = "Synthetic demo data from seeds/make-demo-runs.py. Not a measured result."

RUNS = [
    # id, lr, start offset (h), outcome
    ("demo-lr3e-4", 3e-4, 0.0, "finished"),
    ("demo-lr1e-3", 1e-3, 0.5, "finished"),
    ("demo-lr3e-3", 3e-3, 1.0, "diverged"),
    ("demo-lr1e-4", 1e-4, 1.5, "stalled"),
]


def run_events(run_id: str, lr: float, offset_h: float, outcome: str, rng: random.Random):
    start = T0 + int(offset_h * 3600_000)
    yield {
        "type": "start", "run": run_id, "time": start, "name": run_id.removeprefix("demo-"),
        "group": "demo-lr-sweep", "tags": ["demo"], "notes": NOTE,
        "config": {"optim": {"lr": lr, "weight_decay": 0.01, "warmup": 50},
                   "batch_size": 64, "model": "demo-mlp", "seed": 0},
        "meta": {"host": "demo-node", "git": {"commit": "0" * 40, "branch": "demo", "dirty": False}},
    }
    last = STEPS if outcome != "stalled" else int(STEPS * 0.7)
    floor = 0.35 + 40 * abs(math.log10(lr) + 3.3) ** 2 / 100
    for step in range(last):
        time = start + step * STEP_MS
        warm = min(1.0, (step + 1) / 50)
        cur_lr = lr * warm * 0.5 * (1 + math.cos(math.pi * step / STEPS))
        loss = floor + 2.2 * math.exp(-step * lr * 12) + rng.gauss(0, 0.04)
        if outcome == "diverged" and step > STEPS * 0.55:
            loss = loss * 1.08 ** (step - STEPS * 0.55)
        values = {
            "train/loss": None if not math.isfinite(loss) or loss > 1e6 else round(loss, 5),
            "train/lr": cur_lr,
            "train/grad_norm": round(abs(rng.gauss(1.0, 0.25)) * (1 + 3 * (loss > 10)), 4),
        }
        if step % 50 == 0 or step == last - 1:
            val = None if values["train/loss"] is None else round(loss + 0.08 + rng.gauss(0, 0.02), 5)
            values["val/loss"] = val
            values["val/accuracy"] = None if val is None else round(max(0.0, min(1.0, 1.05 - val / 2.6)), 4)
        yield {"type": "log", "run": run_id, "time": time, "step": step, "values": values}
        if step % 20 == 0:  # system metrics every 30 s, step = Unix seconds
            system = {}
            for gpu in range(2):
                util = max(0.0, min(100.0, 92 + rng.gauss(0, 4) - 30 * (step % 200 < 5)))
                system |= {
                    f"system/gpu.{gpu}.util_pct": round(util, 1),
                    f"system/gpu.{gpu}.mem_pct": round(71 + gpu * 3 + rng.gauss(0, 0.5), 1),
                    f"system/gpu.{gpu}.temp_c": round(58 + util / 10 + rng.gauss(0, 1), 1),
                    f"system/gpu.{gpu}.power_w": round(180 + util * 4.5 + rng.gauss(0, 10), 1),
                }
            system |= {
                "system/cpu.util_pct": round(35 + rng.gauss(0, 5), 1),
                "system/mem.used_pct": round(42 + step / STEPS * 6 + rng.gauss(0, 0.3), 2),
            }
            yield {"type": "log", "run": run_id, "time": time, "step": time // 1000, "values": system}
    end = start + last * STEP_MS
    if outcome == "finished":
        yield {"type": "finish", "run": run_id, "time": end, "status": "finished", "exitCode": 0}
    elif outcome == "diverged":
        yield {"type": "finish", "run": run_id, "time": end, "status": "failed", "exitCode": 1}
    # "stalled": no finish event, so the run shows as stalled.


def main() -> None:
    rng = random.Random(0)
    with OUT.open("w", encoding="utf-8") as f:
        for spec in RUNS:
            for event in run_events(*spec, rng):
                f.write(json.dumps(event, separators=(",", ":"), allow_nan=False) + "\n")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
