# parallax_track

Live training telemetry for Parallax, in the style of W&B or Comet. It is one file and uses only the Python standard library.

```python
import parallax_track as px

run = px.init(name="sft-lr3e-5", group="lr-sweep", config={"lr": 3e-5, "seed": 0},
              experiment_id="<Parallax experiment id>")   # optional link
for step, batch in enumerate(loader):
    run.log({"train/loss": loss, "train/lr": lr}, step=step)
run.log({"val/loss": val_loss, "val/accuracy": acc}, step=step)
run.summary["best_val_accuracy"] = best
run.finish()          # also runs at exit: "failed" after an exception, "killed" after Ctrl-C
```

- `log(values, step=None)`: numbers only (tensors and numpy scalars are fine). Nested dicts become `a/b`. Without `step`, each call counts up. NaN and Inf are stored as divergence markers.
- `update_config(dict)`, `summary[key] = value`, `finish(status, exit_code)`. `with px.init(...) as run:` also works.
- System metrics are sampled every 15 s (`system=False` turns them off): GPU utilization, memory, temperature and power from `nvidia-smi`, and CPU, memory, network and disk use from `/proc` (Linux).
- The Runs tab charts are built from metric names. `train/loss`, `val/loss` and `loss/val` share one "loss" chart. Charts go into these sections: Loss, Metrics, Optimization (lr, grad_norm, throughput) and System.

## Where data goes

| Mode (`PARALLAX_MODE`) | Behaviour                                                                   |
| ---------------------- | --------------------------------------------------------------------------- |
| `auto` (default)       | Online if `PARALLAX_URL` answers at init, else offline (with a warning)     |
| `online`               | Posts batches every 2 s. Failed posts are retried and training never blocks |
| `offline`              | Writes only `PARALLAX_DIR/<run id>.jsonl`                                   |

Every mode writes the `.jsonl` event log first. Sending it again is safe, because points are replaced, not duplicated.

The Parallax server listens on 127.0.0.1 only. A cluster job runs `offline` and writes to shared storage. To get live charts on the laptop, stream the growing file over SSH:

```bash
# in the sbatch script
export PARALLAX_MODE=offline PARALLAX_DIR=$STORE/parallax-runs PARALLAX_RUN_ID=$SLURM_JOB_NAME-$SLURM_JOB_ID

# on the laptop: live (Ctrl-C to stop), or once after the job
ssh bulbasaur 'tail -n +1 -F /workspace-vast/$USER/parallax-runs/<run id>.jsonl' | python3 parallax_track.py sync -
rsync -a bulbasaur:/workspace-vast/$USER/parallax-runs/ ./parallax-runs/ && python3 parallax_track.py sync parallax-runs/
```

A job killed by SIGTERM (scancel, preemption) does not reach `finish()`. The run shows as **stalled** after 5 minutes with no events. A requeued job with the same `PARALLAX_RUN_ID` resumes the run.

Other settings: `PARALLAX_WORKSPACE_ID` (otherwise the server default), `PARALLAX_URL` (default `http://127.0.0.1:3000`).

Tests: `cd clients/python && python3 -m unittest test_parallax_track`.
