"""parallax_track: live training telemetry for Parallax (a small W&B-style client).

Python standard library only, one file: copy it next to your code or `pip install -e`.

    import parallax_track as px

    run = px.init(name="sft-lr3e-5", group="lr-sweep", config={"lr": 3e-5, "seed": 0})
    for step, batch in enumerate(loader):
        loss = train_step(batch)
        run.log({"train/loss": loss, "train/lr": sched.get_last_lr()[0]}, step=step)
    run.summary["best_val_acc"] = 0.91
    run.finish()

Name metrics "split/metric" (train/loss, val/loss) or "metric/split": the Runs tab puts
train and val of one metric in one chart. NaN and Inf are recorded as divergence markers.

Where the data goes
- Every event is first appended to PARALLAX_DIR/<run id>.jsonl (a write-ahead log).
- mode "online" also posts batches to PARALLAX_URL every 2 s. If the server is down,
  the events stay in the file and are retried; training never waits or crashes for it.
- mode "offline" writes only the file. Send it later, idempotently:
      python parallax_track.py sync parallax-runs/
  or stream a file that is still growing on a cluster to the laptop:
      ssh bulbasaur 'tail -n +1 -F /workspace-vast/$USER/parallax-runs/RUN.jsonl' \\
        | python parallax_track.py sync -
- mode "auto" (default): online when the server answers at init, otherwise offline.

Environment: PARALLAX_URL (http://127.0.0.1:3000), PARALLAX_WORKSPACE_ID, PARALLAX_MODE,
PARALLAX_DIR (./parallax-runs), PARALLAX_RUN_ID (resume a run, e.g. a requeued Slurm job).

System metrics (every 15 s, step = Unix time): GPU utilization, memory, temperature and
power from nvidia-smi (only the GPUs in CUDA_VISIBLE_DEVICES when set); CPU, system memory,
network from /proc (Linux); this process's RSS; disk use of PARALLAX_DIR.
"""

from __future__ import annotations

import atexit
import json
import math
import os
import platform
import random
import shutil
import socket
import string
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Mapping

__all__ = ["init", "Run", "sync"]

DEFAULT_URL = "http://127.0.0.1:3000"
FLUSH_SECONDS = 2.0
HEARTBEAT_SECONDS = 30.0
POST_BATCH = 2000
MAX_PENDING = 200_000


def _warn(message: str) -> None:
    print(f"[parallax] {message}", file=sys.stderr, flush=True)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _number(name: str, value: Any) -> float | None:
    """A loggable scalar, or None for NaN/Inf. Tensors and numpy scalars use .item()."""
    if hasattr(value, "item") and callable(value.item):
        value = value.item()
    if isinstance(value, bool):
        value = int(value)
    if not isinstance(value, (int, float)):
        raise TypeError(
            f"parallax_track: {name!r} must be a number, got {type(value).__name__}"
        )
    value = float(value)
    return value if math.isfinite(value) else None


def _flatten(values: Mapping[str, Any], prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in values.items():
        name = f"{prefix}/{key}" if prefix else str(key)
        if isinstance(value, Mapping):
            out.update(_flatten(value, name))
        else:
            out[name] = value
    return out


def _jsonable(value: Any) -> Any:
    """Config and summary values: JSON as is, everything else (paths, dtypes) as text."""
    return json.loads(json.dumps(value, default=str, allow_nan=False))


class _Client:
    def __init__(self, url: str, workspace: str | None) -> None:
        self.url = url.rstrip("/")
        self.query = f"?workspaceId={workspace}" if workspace else ""

    def post(self, events: list[dict], timeout: float = 10.0) -> None:
        for i in range(0, len(events), POST_BATCH):
            body = json.dumps({"events": events[i : i + POST_BATCH]}).encode()
            request = urllib.request.Request(
                f"{self.url}/api/runs{self.query}",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    response.read()
            except urllib.error.HTTPError as error:
                detail = error.read().decode(errors="replace")[:500]
                raise RuntimeError(f"HTTP {error.code}: {detail}") from None

    def reachable(self) -> bool:
        try:
            with urllib.request.urlopen(
                f"{self.url}/api/runs{self.query}{'&' if self.query else '?'}limit=1",
                timeout=2,
            ) as response:
                return response.status == 200
        except (OSError, ValueError):
            return False


class _SystemSampler:
    """Reads GPU, CPU, memory, disk and network use. Each source that fails is dropped once, with a warning."""

    def __init__(self, disk_path: Path) -> None:
        self.disk_path = disk_path
        self.gpu = shutil.which("nvidia-smi") is not None
        self.proc = Path("/proc/stat").exists()
        self.last_cpu: tuple[int, int] | None = None
        self.last_net: tuple[float, int, int] | None = None

    def sample(self) -> dict[str, float]:
        values: dict[str, float] = {}
        for source in (self._gpus, self._cpu, self._memory, self._net, self._disk):
            try:
                values.update(source())
            except Exception as error:  # a broken source must not stop training
                _warn(f"system metrics: {source.__name__[1:]} disabled ({error})")
                if source is self._gpus:
                    self.gpu = False
                elif source is not self._disk:
                    self.proc = False
        return values

    def _gpus(self) -> dict[str, float]:
        if not self.gpu:
            return {}
        command = [
            "nvidia-smi",
            "--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
            "--format=csv,noheader,nounits",
        ]
        visible = os.environ.get("CUDA_VISIBLE_DEVICES", "").strip()
        if visible:
            command += ["-i", visible]
        output = subprocess.run(
            command, capture_output=True, text=True, timeout=10, check=True
        ).stdout
        values: dict[str, float] = {}
        for line in output.strip().splitlines():
            index, util, used, total, temp, power = [f.strip() for f in line.split(",")]
            fields = {
                "util_pct": util,
                "mem_gb": str(float(used) / 1024) if used.isdigit() else used,
                "mem_pct": str(100 * float(used) / float(total))
                if used.isdigit() and total.isdigit() and float(total)
                else "",
                "temp_c": temp,
                "power_w": power,
            }
            for key, raw in fields.items():
                try:  # "[N/A]" on some GPUs and drivers
                    values[f"system/gpu.{index}.{key}"] = float(raw)
                except ValueError:
                    pass
        return values

    def _cpu(self) -> dict[str, float]:
        if not self.proc:
            return {}
        fields = [int(x) for x in Path("/proc/stat").read_text().split("\n")[0].split()[1:]]
        idle, total = fields[3] + fields[4], sum(fields)
        previous, self.last_cpu = self.last_cpu, (idle, total)
        if previous is None or total == previous[1]:
            return {}
        busy = 1 - (idle - previous[0]) / (total - previous[1])
        return {"system/cpu.util_pct": 100 * busy}

    def _memory(self) -> dict[str, float]:
        if not self.proc:
            return {}
        info = {
            line.split(":")[0]: int(line.split()[1])
            for line in Path("/proc/meminfo").read_text().splitlines()
            if line.split(":")[0] in ("MemTotal", "MemAvailable")
        }
        rss = next(
            int(line.split()[1])
            for line in Path("/proc/self/status").read_text().splitlines()
            if line.startswith("VmRSS:")
        )
        return {
            "system/mem.used_pct": 100 * (1 - info["MemAvailable"] / info["MemTotal"]),
            "system/proc.rss_gb": rss / 1024**2,
        }

    def _net(self) -> dict[str, float]:
        if not self.proc:
            return {}
        recv = sent = 0
        for line in Path("/proc/net/dev").read_text().splitlines()[2:]:
            name, data = line.split(":", 1)
            if name.strip() != "lo":
                fields = data.split()
                recv += int(fields[0])
                sent += int(fields[8])
        now = time.time()
        previous, self.last_net = self.last_net, (now, recv, sent)
        if previous is None or now <= previous[0]:
            return {}
        seconds = now - previous[0]
        return {
            "system/net.recv_mbps": (recv - previous[1]) / seconds / 1e6,
            "system/net.sent_mbps": (sent - previous[2]) / seconds / 1e6,
        }

    def _disk(self) -> dict[str, float]:
        usage = shutil.disk_usage(self.disk_path)
        return {"system/disk.used_pct": 100 * usage.used / usage.total}


def _git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", *args], capture_output=True, text=True, timeout=5, check=True
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _meta() -> dict[str, Any]:
    meta: dict[str, Any] = {
        "host": socket.gethostname(),
        "pid": os.getpid(),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "command": " ".join([sys.executable, *sys.argv]),
        "cwd": os.getcwd(),
    }
    commit = _git("rev-parse", "HEAD")
    if commit:
        meta["git"] = {
            "commit": commit,
            "branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
            "dirty": bool(_git("status", "--porcelain", "--untracked-files=no")),
            "remote": _git("config", "--get", "remote.origin.url"),
        }
    slurm = {
        key[6:].lower(): value
        for key, value in os.environ.items()
        if key in ("SLURM_JOB_ID", "SLURM_JOB_NAME", "SLURM_ARRAY_JOB_ID",
                   "SLURM_ARRAY_TASK_ID", "SLURM_JOB_NODELIST", "SLURM_JOB_PARTITION")
    }
    if slurm:
        meta["slurm"] = slurm
    if os.environ.get("CUDA_VISIBLE_DEVICES"):
        meta["cuda_visible_devices"] = os.environ["CUDA_VISIBLE_DEVICES"]
    if shutil.which("nvidia-smi"):
        try:
            meta["gpus"] = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=10, check=True,
            ).stdout.strip().splitlines()
        except (OSError, subprocess.SubprocessError):
            pass
    return meta


class _Summary(dict):
    """run.summary["best"] = x sends the value; reading works like a dict."""

    def __init__(self, run: "Run") -> None:
        super().__init__()
        self._run = run

    def __setitem__(self, key: str, value: Any) -> None:
        super().__setitem__(key, value)
        self._run._emit({"type": "summary", "values": {key: _jsonable(value)}})

    def update(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        values = dict(*args, **kwargs)
        super().update(values)
        self._run._emit({"type": "summary", "values": _jsonable(values)})


class Run:
    def __init__(
        self,
        *,
        id: str | None = None,
        name: str | None = None,
        group: str | None = None,
        tags: Iterable[str] = (),
        notes: str | None = None,
        config: Mapping[str, Any] | None = None,
        experiment_id: str | None = None,
        workspace_id: str | None = None,
        url: str | None = None,
        mode: str | None = None,
        dir: str | os.PathLike | None = None,
        system: bool = True,
        system_interval: float = 15.0,
    ) -> None:
        self.id = id or os.environ.get("PARALLAX_RUN_ID") or "".join(
            random.choices(string.ascii_lowercase + string.digits, k=10)
        )
        self.config = dict(config or {})
        self.summary = _Summary(self)
        self.path = Path(dir or os.environ.get("PARALLAX_DIR", "parallax-runs")) / f"{self.id}.jsonl"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._client = _Client(
            url or os.environ.get("PARALLAX_URL", DEFAULT_URL),
            workspace_id or os.environ.get("PARALLAX_WORKSPACE_ID"),
        )
        mode = mode or os.environ.get("PARALLAX_MODE", "auto")
        if mode not in ("auto", "online", "offline"):
            raise ValueError("mode must be auto, online or offline")
        if mode == "auto":
            mode = "online" if self._client.reachable() else "offline"
            if mode == "offline":
                _warn(f"no server at {self._client.url}; writing {self.path} only "
                      f"(send it later with: python parallax_track.py sync {self.path})")
        self.mode = mode
        self._lock = threading.Lock()
        self._file = self.path.open("a", encoding="utf-8")
        self._pending: list[dict] = []
        self._dropped = 0
        self._failing = False
        self._last_event = time.monotonic()
        self._step = 0
        self._finished = False
        self._stop = threading.Event()
        self._sampler = _SystemSampler(self.path.parent) if system else None
        self._system_interval = system_interval
        self._emit({
            "type": "start",
            **{k: v for k, v in {"name": name, "group": group, "notes": notes,
                                 "experimentId": experiment_id}.items() if v is not None},
            **({"tags": list(tags)} if tags else {}),
            "config": _jsonable(self.config),
            "meta": _jsonable(_meta()),
        })
        self._flush()
        self._thread = threading.Thread(target=self._loop, name="parallax-track", daemon=True)
        self._thread.start()
        _hooks.add(self)

    # Public API ---------------------------------------------------------------
    def log(self, values: Mapping[str, Any], step: int | float | None = None) -> None:
        """Record numbers at a step. Without step, each call is the next step."""
        if self._finished:
            raise RuntimeError("parallax_track: log() after finish()")
        if step is None:
            step = self._step
        elif step < 0:
            raise ValueError("parallax_track: step must be >= 0")
        flat = {name: _number(name, v) for name, v in _flatten(values).items()}
        if flat:
            self._emit({"type": "log", "step": step, "values": flat})
        self._step = max(self._step, int(step) + 1)

    def update_config(self, values: Mapping[str, Any]) -> None:
        self.config.update(values)
        self._emit({"type": "config", "values": _jsonable(dict(values))})

    def finish(self, status: str = "finished", exit_code: int | None = None) -> None:
        if status not in ("finished", "failed", "killed"):
            raise ValueError("status must be finished, failed or killed")
        if self._finished:
            return
        self._emit({"type": "finish", "status": status,
                    **({"exitCode": exit_code} if exit_code is not None else {})})
        self._finished = True
        self._stop.set()
        self._thread.join(timeout=5)
        self._flush(final=True)
        self._file.close()
        _hooks.discard(self)
        if self._dropped or (self.mode == "online" and self._pending):
            _warn(f"{self._dropped + len(self._pending)} events were not sent; "
                  f"they are in {self.path}: python parallax_track.py sync {self.path}")

    def __enter__(self) -> "Run":
        return self

    def __exit__(self, kind, value, traceback) -> None:
        self.finish("failed" if kind else "finished", 1 if kind else None)

    # Internals ----------------------------------------------------------------
    def _emit(self, event: dict) -> None:
        event = {**event, "run": self.id, "time": _now_ms()}
        line = json.dumps(event, allow_nan=False)
        with self._lock:
            self._file.write(line + "\n")
            self._last_event = time.monotonic()
            if self.mode == "online":
                self._pending.append(event)
                if len(self._pending) > MAX_PENDING:  # still in the file for a later sync
                    self._dropped += len(self._pending) - MAX_PENDING
                    del self._pending[: len(self._pending) - MAX_PENDING]

    def _flush(self, final: bool = False) -> None:
        with self._lock:
            self._file.flush()
            batch, self._pending = self._pending, []
        if not batch:
            return
        try:
            self._client.post(batch, timeout=10 if final else 5)
            if self._failing:
                _warn("server reachable again; telemetry resumed")
            self._failing = False
        except (OSError, RuntimeError) as error:
            with self._lock:
                self._pending = batch + self._pending
            if not self._failing:
                _warn(f"could not send telemetry ({error}); retrying, events are kept in {self.path}")
            self._failing = True

    def _loop(self) -> None:
        next_system = time.monotonic()
        while not self._stop.wait(FLUSH_SECONDS):
            try:
                now = time.monotonic()
                if self._sampler and now >= next_system:
                    next_system = now + self._system_interval
                    values = self._sampler.sample()
                    if values:
                        self._emit({"type": "log", "step": int(time.time()), "values": values})
                if now - self._last_event > HEARTBEAT_SECONDS:
                    self._emit({"type": "heartbeat"})
                self._flush()
            except Exception as error:  # the telemetry thread must never take training down
                _warn(f"telemetry thread error: {error!r}")


# Finish open runs at exit: "failed" after an uncaught exception, "killed" after Ctrl-C,
# else "finished". A SIGTERM (scancel, preemption) skips atexit: the run shows as stalled
# after 5 minutes and resumes if the job restarts with the same PARALLAX_RUN_ID.
_hooks: set[Run] = set()
_exit_status = "finished"
_previous_excepthook = sys.excepthook


def _excepthook(kind, value, traceback):
    global _exit_status
    _exit_status = "killed" if issubclass(kind, KeyboardInterrupt) else "failed"
    _previous_excepthook(kind, value, traceback)


sys.excepthook = _excepthook


@atexit.register
def _finish_all() -> None:
    for run in list(_hooks):
        run.finish(_exit_status, 0 if _exit_status == "finished" else 1)


def init(**kwargs: Any) -> Run:
    """Start (or, with an existing id, resume) a run. See Run for the arguments."""
    return Run(**kwargs)


def _events(lines: Iterable[str], source: str) -> Iterable[dict]:
    for number, line in enumerate(lines, 1):
        if line.strip():
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                _warn(f"{source}:{number}: not JSON, skipped")


def sync(paths: Iterable[str], url: str | None = None, workspace_id: str | None = None) -> int:
    """Send event files (or '-' for stdin, streamed as it grows). Safe to repeat."""
    client = _Client(url or os.environ.get("PARALLAX_URL", DEFAULT_URL),
                     workspace_id or os.environ.get("PARALLAX_WORKSPACE_ID"))
    sent = 0
    for raw in paths:
        if raw == "-":
            batch: list[dict] = []
            last = time.monotonic()
            for event in _events(sys.stdin, "stdin"):
                batch.append(event)
                if len(batch) >= POST_BATCH or time.monotonic() - last > FLUSH_SECONDS:
                    client.post(batch)
                    sent += len(batch)
                    batch, last = [], time.monotonic()
            if batch:
                client.post(batch)
                sent += len(batch)
            continue
        path = Path(raw)
        for file in sorted(path.glob("*.jsonl")) if path.is_dir() else [path]:
            events = list(_events(file.read_text(encoding="utf-8").splitlines(), str(file)))
            client.post(events)
            sent += len(events)
            print(f"{file}: {len(events)} events sent")
    return sent


def _main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="parallax_track")
    commands = parser.add_subparsers(dest="command", required=True)
    sync_parser = commands.add_parser("sync", help="send offline event files to Parallax")
    sync_parser.add_argument("paths", nargs="+", help=".jsonl files, folders of them, or - for stdin")
    sync_parser.add_argument("--url", default=None)
    sync_parser.add_argument("--workspace-id", default=None)
    args = parser.parse_args(argv)
    sent = sync(args.paths, args.url, args.workspace_id)
    print(f"{sent} events sent")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
