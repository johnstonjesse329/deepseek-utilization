import type { BalanceSnapshot } from './deepseek';

/** Spend windows reported for each currency, newest first. */
const WINDOWS: readonly { label: string; hours: number }[] = [
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 7 days', hours: 24 * 7 },
  { label: 'Last 30 days', hours: 24 * 30 },
];

/** Readings closer together than this replace each other instead of stacking. */
const COLLAPSE_MS = 5_000;

/**
 * How far back the burn rate looks. An average over a whole day barely reacts to
 * a session ending: an hour after stepping away it still reports the spend from
 * when you were working, which makes the runway look far longer than the balance
 * will really last. Thirty minutes is short enough to describe what is happening
 * now and long enough to survive a few poll gaps.
 */
const RATE_WINDOW_MS = 30 * 60_000;

/** Below this the rate comes from too little time to mean anything. */
const MIN_RATE_SPAN_MS = 10 * 60_000;

/**
 * Tiered retention. At a 30-60 second poll interval, keeping every reading for a
 * month would be ~43k entries; instead recent detail is kept raw and older
 * history is thinned. Each retained sample carries a cumulative `spent` total, so
 * thinning never changes the spend maths.
 */
const RETENTION: readonly { olderThanMs: number; bucketMs: number }[] = [
  { olderThanMs: 2 * 3_600_000, bucketMs: 0 },
  { olderThanMs: 24 * 3_600_000, bucketMs: 5 * 60_000 },
  { olderThanMs: 7 * 86_400_000, bucketMs: 30 * 60_000 },
  { olderThanMs: Number.POSITIVE_INFINITY, bucketMs: 6 * 3_600_000 },
];

/** A point-in-time reading of a single currency balance. */
export interface UsageSample {
  readonly at: number;
  readonly currency: string;
  readonly total: number;
  readonly granted: number;
  readonly toppedUp: number;
  /** Consumption observed for this currency since tracking began. */
  readonly spent: number;
}

export interface SpendWindow {
  readonly label: string;
  readonly hours: number;
  /** Amount spent in the window, or null when history does not reach back that far. */
  readonly amount: number | null;
}

export interface SpendSummary {
  readonly currency: string;
  readonly balance: number;
  readonly granted: number;
  readonly toppedUp: number;
  readonly updatedAt: number;
  readonly trackedMs: number;
  readonly spentTotal: number;
  readonly windows: readonly SpendWindow[];
  /** Recent spend rate, or null while the history is too short to measure one. */
  readonly burnPerHour: number | null;
  /** Time the readings behind `burnPerHour` actually cover. */
  readonly burnSpanMs: number | null;
  readonly runwayHours: number | null;
}

/** A spend rate and the span of readings it was measured over. */
export interface BurnRate {
  readonly perHour: number;
  readonly spanMs: number;
}

/** Balances from a snapshot become one sample per currency. */
export function samplesFromSnapshot(snapshot: BalanceSnapshot): UsageSample[] {
  return snapshot.balances.map((balance) => ({
    at: snapshot.at,
    currency: balance.currency,
    total: balance.totalBalance,
    granted: balance.grantedBalance,
    toppedUp: balance.toppedUpBalance,
    spent: 0,
  }));
}

export function trackedCurrencies(samples: readonly UsageSample[]): string[] {
  const seen: string[] = [];
  for (const sample of samples) {
    if (!seen.includes(sample.currency)) {
      seen.push(sample.currency);
    }
  }
  return seen;
}

export function samplesFor(samples: readonly UsageSample[], currency: string): UsageSample[] {
  return samples.filter((sample) => sample.currency === currency);
}

export function latestSample(
  samples: readonly UsageSample[],
  currency: string,
): UsageSample | undefined {
  const matching = samplesFor(samples, currency);
  return matching[matching.length - 1];
}

/** Newest sample at or before `timestamp`. */
export function sampleAtOrBefore(
  samples: readonly UsageSample[],
  currency: string,
  timestamp: number,
): UsageSample | undefined {
  let found: UsageSample | undefined;
  for (const sample of samplesFor(samples, currency)) {
    if (sample.at <= timestamp) {
      found = sample;
    } else {
      break;
    }
  }
  return found;
}

/**
 * Append a reading, rolling its cumulative `spent` forward. A top-up shows up as
 * a balance increase, which contributes nothing, so top-ups never cancel out real
 * consumption in later window maths.
 */
export function appendSample(
  samples: readonly UsageSample[],
  sample: UsageSample,
  collapseMs = COLLAPSE_MS,
): UsageSample[] {
  const previous = latestSample(samples, sample.currency);
  const next: UsageSample = {
    ...sample,
    spent: previous ? previous.spent + Math.max(0, previous.total - sample.total) : 0,
  };

  if (previous && sample.at - previous.at < collapseMs) {
    const index = samples.lastIndexOf(previous);
    return [...samples.slice(0, index), next, ...samples.slice(index + 1)];
  }
  return [...samples, next];
}

/**
 * Spend between two instants. Both endpoints only need a reading at or before
 * them, and because `spent` is cumulative this stays exact even after retention
 * has thinned the readings in between.
 */
export function spendBetween(
  samples: readonly UsageSample[],
  currency: string,
  from: number,
  to: number,
): number | null {
  const baseline = sampleAtOrBefore(samples, currency, from);
  const end = sampleAtOrBefore(samples, currency, to);
  if (!baseline || !end) {
    return null;
  }
  return Math.max(0, end.spent - baseline.spent);
}

/**
 * Spend rate over the most recent readings: the newest reading against the newest
 * one that is at least `windowMs` old, falling back to the whole tracked history
 * while it is shorter than that. The span is reported with the rate because
 * polling gaps (a window nobody was looking at, or an unchanged balance) make the
 * two differ, and a rate is only honest next to the time it was measured over.
 */
export function recentBurnRate(
  samples: readonly UsageSample[],
  currency: string,
  now: number,
  windowMs = RATE_WINDOW_MS,
): BurnRate | null {
  const points = samplesFor(samples, currency);
  if (points.length < 2) {
    return null;
  }

  const end = points[points.length - 1];
  const baseline = sampleAtOrBefore(points, currency, now - windowMs) ?? points[0];
  const spanMs = end.at - baseline.at;
  if (spanMs < MIN_RATE_SPAN_MS) {
    return null;
  }

  return {
    perHour: Math.max(0, end.spent - baseline.spent) / (spanMs / 3_600_000),
    spanMs,
  };
}

function bucketMsFor(ageMs: number): number {
  for (const tier of RETENTION) {
    if (ageMs <= tier.olderThanMs) {
      return tier.bucketMs;
    }
  }
  return RETENTION[RETENTION.length - 1].bucketMs;
}

/** Thin old readings without losing the cumulative spend they carry. */
export function applyRetention(samples: readonly UsageSample[], now: number): UsageSample[] {
  const kept: UsageSample[] = [];

  for (const currency of trackedCurrencies(samples)) {
    const points = samplesFor(samples, currency);
    const seen = new Set<string>();

    for (let index = points.length - 1; index >= 0; index--) {
      const point = points[index];
      // Always keep the newest reading (the current balance) and the oldest one,
      // which anchors the longest spend window we can still measure.
      if (index === points.length - 1 || index === 0) {
        kept.push(point);
        continue;
      }
      const bucketMs = bucketMsFor(now - point.at);
      if (bucketMs === 0) {
        kept.push(point);
        continue;
      }
      const key = `${bucketMs}:${Math.floor(point.at / bucketMs)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      kept.push(point);
    }
  }

  kept.sort((a, b) => a.at - b.at);
  return kept;
}

/** Trim to the newest `max` samples; input is assumed sorted oldest-first. */
export function trimSamples(samples: readonly UsageSample[], max: number): UsageSample[] {
  return samples.length <= max ? [...samples] : samples.slice(samples.length - max);
}

export function summarize(
  samples: readonly UsageSample[],
  currency: string,
  now: number,
): SpendSummary | null {
  const latest = latestSample(samples, currency);
  if (!latest) {
    return null;
  }
  const matching = samplesFor(samples, currency);
  const first = matching[0];

  const windows: SpendWindow[] = WINDOWS.map((window) => ({
    label: window.label,
    hours: window.hours,
    amount: spendBetween(matching, currency, now - window.hours * 3_600_000, now),
  }));

  const trackedMs = now - first.at;
  const rate = recentBurnRate(matching, currency, now);
  const burnPerHour = rate?.perHour ?? null;
  const runwayHours = burnPerHour !== null && burnPerHour > 0 ? latest.total / burnPerHour : null;

  return {
    currency,
    balance: latest.total,
    granted: latest.granted,
    toppedUp: latest.toppedUp,
    updatedAt: latest.at,
    trackedMs,
    spentTotal: latest.spent - first.spent,
    windows,
    burnPerHour,
    burnSpanMs: rate?.spanMs ?? null,
    runwayHours,
  };
}

export function parseSamples(raw: unknown): UsageSample[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const parsed: UsageSample[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const at = Number(record.at);
    const currency = record.currency;
    const total = Number(record.total);
    if (!Number.isFinite(at) || typeof currency !== 'string' || !Number.isFinite(total)) {
      continue;
    }
    parsed.push({
      at,
      currency,
      total,
      granted: Number.isFinite(Number(record.granted)) ? Number(record.granted) : 0,
      toppedUp: Number.isFinite(Number(record.toppedUp)) ? Number(record.toppedUp) : 0,
      spent: Number.isFinite(Number(record.spent)) ? Number(record.spent) : Number.NaN,
    });
  }

  parsed.sort((a, b) => a.at - b.at);

  // Roll cumulative spend forward, deriving it for entries stored before it was
  // recorded (an absent `spent` parses to NaN).
  const running = new Map<string, UsageSample>();
  return parsed.map((sample) => {
    const previous = running.get(sample.currency);
    const spent = Number.isFinite(sample.spent)
      ? sample.spent
      : previous
        ? previous.spent + Math.max(0, previous.total - sample.total)
        : 0;
    const resolved: UsageSample = { ...sample, spent };
    running.set(sample.currency, resolved);
    return resolved;
  });
}
