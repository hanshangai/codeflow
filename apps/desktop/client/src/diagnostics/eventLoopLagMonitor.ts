import { monitorEventLoopDelay } from "node:perf_hooks";

export type EventLoopLagSnapshot = {
  intervalMs: number;
  minMs: number;
  meanMs: number;
  maxMs: number;
  p99Ms: number;
  stddevMs: number;
};

export function startEventLoopLagMonitor(opts: {
  intervalMs?: number;
  resolutionMs?: number;
  warnThresholdMs?: number;
  onSample?: (snapshot: EventLoopLagSnapshot) => void;
  onLag?: (snapshot: EventLoopLagSnapshot) => void;
}): () => void {
  const intervalMs = Math.max(1_000, Math.floor(opts.intervalMs ?? 15_000));
  const resolutionMs = Math.max(10, Math.floor(opts.resolutionMs ?? 20));
  const warnThresholdMs = Math.max(100, Math.floor(opts.warnThresholdMs ?? 2_000));
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();

  const timer = setInterval(() => {
    const snapshot: EventLoopLagSnapshot = {
      intervalMs,
      minMs: toMs(histogram.min),
      meanMs: toMs(histogram.mean),
      maxMs: toMs(histogram.max),
      p99Ms: toMs(histogram.percentile(99)),
      stddevMs: toMs(histogram.stddev),
    };
    opts.onSample?.(snapshot);
    if (snapshot.maxMs >= warnThresholdMs) {
      opts.onLag?.(snapshot);
    }
    histogram.reset();
  }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}

function toMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value / 1_000_000) * 100) / 100;
}
