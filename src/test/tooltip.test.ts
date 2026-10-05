import assert from 'node:assert/strict';
import test from 'node:test';
import { ChineseHolidayProvider, NO_HOLIDAYS } from '../holidays';
import { computeStatus, type RateStatus } from '../rates';
import { statusBarText, tooltipMarkdown, type UsageViewState } from '../tooltip';
import { summarize, type UsageSample } from '../usage';

const HOUR = 3_600_000;
const at = (iso: string): Date => new Date(iso);
const ms = (iso: string): number => at(iso).getTime();

function synthetic(overrides: Partial<RateStatus> = {}): RateStatus {
  return {
    at: at('2026-03-04T04:30:00Z'),
    isPeak: false,
    nextChange: null,
    nextChangeToPeak: null,
    scheduleUnknown: false,
    ...overrides,
  };
}

function viewState(overrides: Partial<UsageViewState> = {}): UsageViewState {
  return {
    configured: false,
    error: undefined,
    summaries: [],
    polling: { tier: 'active', intervalMs: 60_000, unchangedStreak: 0 },
    ...overrides,
  };
}

test('status bar text names the rate, the countdown and the balance', () => {
  const now = ms('2026-03-04T04:30:00Z');
  const status = computeStatus(new Date(now), NO_HOLIDAYS);

  assert.equal(statusBarText(status, now), '$(circle-filled) Off-peak · ½ price · 1h 30m');
  assert.equal(
    statusBarText(status, now, { label: 'DeepSeek' }),
    '$(circle-filled) DeepSeek: Off-peak · ½ price · 1h 30m',
  );
  assert.equal(
    statusBarText(status, now, { label: 'DeepSeek', balance: 'CNY 110.00' }),
    '$(circle-filled) DeepSeek: Off-peak · ½ price · 1h 30m · CNY 110.00',
  );
  assert.equal(
    statusBarText(status, now, { balance: 'CNY 110.00' }),
    '$(circle-filled) Off-peak · ½ price · 1h 30m · CNY 110.00',
    'the label is optional',
  );
});

test('status bar text reports peak pricing', () => {
  const now = ms('2026-03-04T02:15:00Z');
  const status = computeStatus(new Date(now), NO_HOLIDAYS);
  assert.equal(status.isPeak, true);
  assert.equal(statusBarText(status, now), '$(circle-filled) Peak · full price · 1h 45m');
});

test('status bar text omits the countdown when no change is in range', () => {
  assert.equal(statusBarText(synthetic({ isPeak: true }), Date.now()), '$(circle-filled) Peak · full price');
});

test('status bar countdown stays minute-granular so it does not strobe', () => {
  const now = Date.now();
  const text = statusBarText(synthetic({ nextChange: new Date(now + 30_000) }), now);
  assert.equal(text, '$(circle-filled) Off-peak · ½ price · <1m');
  assert.equal(
    statusBarText(synthetic({ nextChange: new Date(now + 45_000) }), now),
    text,
    'two renders inside the same minute must be identical',
  );
});

test('tooltip explains the current rate and the rule', () => {
  const now = ms('2026-03-04T02:15:00Z');
  const status = computeStatus(new Date(now), NO_HOLIDAYS);
  const markdown = tooltipMarkdown(
    status,
    NO_HOLIDAYS,
    'America/Chicago',
    viewState(),
    now,
  );

  assert.match(markdown, /^### Peak Rate Clock/);
  assert.match(markdown, /\*\*Peak right now\*\* — full price\./);
  assert.match(markdown, /\*\*Changes in 1h 45m\*\*/);
  assert.match(markdown, /Peak is 01:00–04:00 UTC and 06:00–10:00 UTC, Mon–Fri/);
  assert.match(markdown, /today: 7:00 PM–10:00 PM, 12:00 AM–4:00 AM/);
  assert.match(markdown, /Not connected\. Add a DeepSeek API key/);
  assert.match(markdown, /\[Usage details\]\(command:peakRateClock\.showUsage\)/);
});

test('tooltip reports the session spend and the forecast', () => {
  const now = 30 * HOUR;
  const samples: UsageSample[] = [
    { at: 0, currency: 'CNY', total: 130, granted: 10, toppedUp: 120, spent: 0 },
    { at: 24 * HOUR, currency: 'CNY', total: 120, granted: 10, toppedUp: 110, spent: 10 },
    { at: now, currency: 'CNY', total: 90, granted: 10, toppedUp: 80, spent: 40 },
  ];
  const summary = summarize(samples, 'CNY', now);
  assert.ok(summary);

  const markdown = tooltipMarkdown(
    synthetic({ at: new Date(now) }),
    NO_HOLIDAYS,
    'UTC',
    viewState({ configured: true, summaries: [summary] }),
    now,
  );

  assert.match(markdown, /\*\*CNY 90\.00\*\* remaining · granted CNY 10\.00 · topped up CNY 80\.00/);
  assert.match(markdown, /^- Spent CNY 40\.00 since tracking began 1d 6h ago$/m, 'a session total, not a window');
  assert.match(
    markdown,
    /^- Runway ≈ 18h at CNY 5\.00\/h over the last 6h$/m,
    'every time-scoped figure lives in the forecast line',
  );
  assert.match(markdown, /Last checked <1m ago/);
  assert.doesNotMatch(markdown, /in the last 24 hours/, 'windows belong in the panel, not the tooltip');
});

test('tooltip says when there is not yet a rate to forecast from', () => {
  const now = 5 * 60_000;
  const samples: UsageSample[] = [{ at: 0, currency: 'CNY', total: 110, granted: 10, toppedUp: 100, spent: 0 }];
  const summary = summarize(samples, 'CNY', now);
  assert.ok(summary);

  const markdown = tooltipMarkdown(
    synthetic({ at: new Date(now) }),
    NO_HOLIDAYS,
    'UTC',
    viewState({ configured: true, summaries: [summary] }),
    now,
  );

  assert.match(markdown, /- Spent CNY 0\.00 since tracking began 5m ago/);
  assert.match(markdown, /- Runway: needs more readings of the balance to measure a rate\./);
});

test('tooltip surfaces poll errors', () => {
  const now = Date.now();
  const markdown = tooltipMarkdown(
    synthetic({ at: new Date(now) }),
    NO_HOLIDAYS,
    'UTC',
    viewState({ configured: true, error: 'DeepSeek returned HTTP 401.' }),
    now,
  );
  assert.match(markdown, /- ⚠️ DeepSeek returned HTTP 401\./);
  assert.match(markdown, /No readings yet/);
});

test('tooltip warns once the holiday schedule runs out', () => {
  const holidays = new ChineseHolidayProvider();
  const now = ms('2027-01-04T02:00:00Z');
  const markdown = tooltipMarkdown(
    computeStatus(new Date(now), holidays),
    holidays,
    'UTC',
    viewState(),
    now,
  );

  assert.match(markdown, /holiday schedule ends 2026-12-31/);
  assert.match(markdown, /assumed to be working days/);
});

test('tooltip lists the next Chinese holidays', () => {
  const holidays = new ChineseHolidayProvider();
  const now = ms('2026-09-20T00:00:00Z');
  const markdown = tooltipMarkdown(
    computeStatus(new Date(now), holidays),
    holidays,
    'UTC',
    viewState(),
    now,
  );

  assert.match(markdown, /\*\*Next Chinese holidays\*\* \(off-peak all day\)/);
  assert.match(markdown, /- 2026-09-25 — Mid-autumn Festival/);
});

test('tooltip reports an idle rate rather than a stale session average', () => {
  const now = 30 * HOUR;
  const samples: UsageSample[] = [
    { at: 0, currency: 'CNY', total: 130, granted: 10, toppedUp: 120, spent: 0 },
    { at: 10 * HOUR, currency: 'CNY', total: 90, granted: 10, toppedUp: 80, spent: 40 },
    { at: now, currency: 'CNY', total: 90, granted: 10, toppedUp: 80, spent: 40 },
  ];
  const summary = summarize(samples, 'CNY', now);
  assert.ok(summary);

  const markdown = tooltipMarkdown(
    synthetic({ at: new Date(now) }),
    NO_HOLIDAYS,
    'UTC',
    viewState({ configured: true, summaries: [summary] }),
    now,
  );

  assert.match(markdown, /- Spent CNY 40\.00 since tracking began 1d 6h ago/, 'the burst is still counted');
  assert.match(markdown, /- Runway: none — no spend over the last 20h, so nothing is burning\./);
  assert.doesNotMatch(markdown, /18h|Runway ≈/, 'nothing is extrapolated from the stale burst');
});

test('tooltip explains why polling is slow', () => {
  const now = Date.now();
  const paused = tooltipMarkdown(
    synthetic({ at: new Date(now) }),
    NO_HOLIDAYS,
    'UTC',
    viewState({
      configured: true,
      polling: { tier: 'paused', intervalMs: 60_000, unchangedStreak: 0 },
    }),
    now,
  );
  assert.match(paused, /Polling is paused while no VS Code window is focused/);

  const backingOff = tooltipMarkdown(
    synthetic({ at: new Date(now) }),
    NO_HOLIDAYS,
    'UTC',
    viewState({
      configured: true,
      polling: { tier: 'backoff', intervalMs: 900_000, unchangedStreak: 4 },
    }),
    now,
  );
  assert.match(
    backingOff,
    /Backing off to 15 minutes: the balance has not changed in the last 4 readings\./,
  );
});

test('tooltip stays quiet while polling normally', () => {
  const now = Date.now();
  const markdown = tooltipMarkdown(
    synthetic({ at: new Date(now) }),
    NO_HOLIDAYS,
    'UTC',
    viewState({ configured: true }),
    now,
  );
  assert.doesNotMatch(markdown, /Polling is paused|Backing off/);
});
