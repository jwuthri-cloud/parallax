"use client";
// "Simulate live run": the browser streams a SYNTHETIC training run to /api/runs in real
// time, so the live dashboard can be seen without running a script. Simulations live at
// module level, so they keep going when the Runs tab unmounts, until the page closes.
// The run is tagged "demo" (id "demo-live-…") and removed with the other demo runs.
import { useSyncExternalStore } from "react";
import type { RunEvent } from "@/lib/schema";

type Post = (events: RunEvent[]) => Promise<unknown>;
const STEPS = 600;
const TICK_MS = 500;
const STEPS_PER_TICK = 2;
const SYSTEM_EVERY = 10; // ticks, so every 5 s

const timers = new Map<string, ReturnType<typeof setInterval>>();
const inFlight = new Set<Promise<unknown>>();
let state = { running: [] as string[], error: "" };
const listeners = new Set<() => void>();
function emit(change: Partial<typeof state>) {
  state = { ...state, ...change, running: [...timers.keys()] };
  listeners.forEach((l) => l());
}

/** Seeded uniform and normal noise, so each simulation is reproducible from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = (sd: number) =>
    Math.sqrt(-2 * Math.log(1 - uniform())) *
    Math.cos(2 * Math.PI * uniform()) *
    sd;
  return { uniform, gauss };
}

/** Post the start event, then stream steps until done. Resolves with the run id. */
export async function startSimulation(post: Post) {
  const seed = Date.now() % 2 ** 31;
  const { uniform, gauss } = rng(seed);
  const lr = 10 ** (-4 + 1.4 * uniform()); // 1e-4 … 2.5e-3
  const id = `demo-live-${seed.toString(36)}`;
  const floor = 0.3 + 0.4 * Math.abs(Math.log10(lr) + 3.2) ** 2;
  let step = 0;
  let tick = 0;
  let busy = false;
  await post([
    {
      type: "start",
      run: id,
      name: `live lr=${lr.toExponential(1)}`,
      group: "demo-live",
      tags: ["demo"],
      notes:
        "Synthetic run streamed by the app's Simulate button. Not a measured result.",
      config: {
        optim: { lr, weight_decay: 0.01, warmup: 50 },
        batch_size: 64,
        steps: STEPS,
        seed,
      },
      meta: { host: "browser-simulation" },
    },
  ]);
  const events: RunEvent[] = [];
  const timer = setInterval(async () => {
    if (busy) return; // a slow post: skip this tick rather than pile up requests
    for (let i = 0; i < STEPS_PER_TICK && step < STEPS; i++, step++) {
      const warm = Math.min(1, (step + 1) / 50);
      const loss = floor + 2.2 * Math.exp(-step * lr * 12) + gauss(0.04);
      const values: Record<string, number> = {
        "train/loss": loss,
        "train/lr": lr * warm * 0.5 * (1 + Math.cos((Math.PI * step) / STEPS)),
        "train/grad_norm": Math.abs(1 + gauss(0.25)),
        "train/tokens_per_s": 52000 + gauss(1500),
      };
      if (step % 25 === 0 || step === STEPS - 1) {
        const val = loss + 0.08 + gauss(0.02);
        values["val/loss"] = val;
        values["val/accuracy"] = Math.max(0, Math.min(1, 1.05 - val / 2.6));
      }
      events.push({ type: "log", run: id, step, values });
    }
    if (tick++ % SYSTEM_EVERY === 0) {
      const system: Record<string, number> = {
        "system/cpu.util_pct": 35 + gauss(5),
        "system/mem.used_pct": 42 + (6 * step) / STEPS + gauss(0.3),
      };
      for (const gpu of [0, 1]) {
        const util = Math.max(0, Math.min(100, 92 + gauss(4)));
        system[`system/gpu.${gpu}.util_pct`] = util;
        system[`system/gpu.${gpu}.mem_pct`] = 71 + 3 * gpu + gauss(0.5);
        system[`system/gpu.${gpu}.temp_c`] = 58 + util / 10 + gauss(1);
        system[`system/gpu.${gpu}.power_w`] = 180 + util * 4.5 + gauss(10);
      }
      events.push({
        type: "log",
        run: id,
        step: Math.floor(Date.now() / 1000),
        values: system,
      });
    }
    const done = step >= STEPS;
    if (done) events.push({ type: "finish", run: id, status: "finished" });
    const batch = events.splice(0);
    busy = true;
    try {
      const sent = post(batch);
      inFlight.add(sent);
      await sent.finally(() => inFlight.delete(sent));
      if (done) stop(id);
    } catch (e) {
      stop(id);
      emit({ error: `Simulation stopped: ${(e as Error).message}` });
    } finally {
      busy = false;
    }
  }, TICK_MS);
  timers.set(id, timer);
  emit({ error: "" });
  return id;
}

function stop(id: string) {
  clearInterval(timers.get(id));
  timers.delete(id);
  emit({});
}

/** Stop every simulation and wait for posts already sent, e.g. before deleting demo runs. */
export async function stopAllSimulations() {
  [...timers.keys()].forEach(stop);
  await Promise.allSettled([...inFlight]);
}

/** Stop early; the run is marked killed. */
export async function stopSimulation(id: string, post: Post) {
  stop(id);
  await post([{ type: "finish", run: id, status: "killed" }]);
}

export function useSimulations() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}
