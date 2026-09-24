/**
 * Minimal, dependency-free micro-benchmark harness (task T0.5). Runs unchanged on Node and on
 * Hermes (the mobile app calls it from a dev-only screen or a Detox run), so budgets from the
 * implementation plan §3.1 can be measured on real devices with the same code.
 */

export interface BenchOptions {
  /** Iterations discarded before measuring (JIT / inline caches). */
  warmup?: number;
  /** Measured iterations. */
  iterations?: number;
  /** Clock returning milliseconds; defaults to performance.now() or Date.now(). */
  now?: () => number;
}

export interface BenchResult {
  name: string;
  iterations: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  opsPerSecond: number;
}

function defaultClock(): () => number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? () => perf.now() : () => Date.now();
}

/**
 * Times `fn` once per input, cycling through `inputs`. Returns percentile latencies per call.
 * Keep `fn` synchronous; the pipeline hot path is synchronous by design.
 */
export function bench<T>(name: string, inputs: readonly T[], fn: (input: T) => unknown, options: BenchOptions = {}): BenchResult {
  if (inputs.length === 0) throw new RangeError('bench needs at least one input');
  const warmup = options.warmup ?? 200;
  const iterations = options.iterations ?? 2000;
  const now = options.now ?? defaultClock();
  let sink: unknown;

  for (let i = 0; i < warmup; i++) sink = fn(inputs[i % inputs.length] as T);

  const samples = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const input = inputs[i % inputs.length] as T;
    const start = now();
    sink = fn(input);
    samples[i] = now() - start;
  }
  // Keep the result observable so engines can't dead-code-eliminate the call.
  if (sink === BENCH_SENTINEL) console.log('');

  const sorted = Array.from(samples).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const meanMs = total / iterations;
  return {
    name,
    iterations,
    meanMs,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    opsPerSecond: meanMs > 0 ? 1000 / meanMs : Infinity,
  };
}

const BENCH_SENTINEL = Symbol('bench-sentinel');

/** Formats results as a Markdown table for pasting into the implementation plan. */
export function formatBenchTable(results: readonly BenchResult[]): string {
  const fmt = (ms: number) => (ms < 0.01 ? `${(ms * 1000).toFixed(1)} µs` : `${ms.toFixed(3)} ms`);
  const lines = [
    '| Benchmark | Iterations | Mean | p50 | p95 | p99 | Max |',
    '|---|---|---|---|---|---|---|',
    ...results.map(
      (r) => `| ${r.name} | ${r.iterations} | ${fmt(r.meanMs)} | ${fmt(r.p50Ms)} | ${fmt(r.p95Ms)} | ${fmt(r.p99Ms)} | ${fmt(r.maxMs)} |`,
    ),
  ];
  return lines.join('\n');
}
