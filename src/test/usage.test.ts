import assert from 'node:assert/strict';
import test from 'node:test';
import { DeepSeekError, buildBalanceUrl, parseBalance } from '../deepseek';
import { renderUsageHtml, sparkline, type UsagePanelData } from '../usageHtml';
import {
  applyRetention,
  appendSample,
  parseSamples,
  recentBurnRate,
  samplesFromSnapshot,
  spendBetween,
  summarize,
  trackedCurrencies,
  trimSamples,
  type UsageSample,
} from '../usage';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function raw(at: number, total: number, currency = 'CNY'): UsageSample {
  return { at, currency, total, granted: 0, toppedUp: total, spent: 0 };
}

/**
 * Build a ledger with cumulative spend computed independently of `appendSample`,
 * so the spend assertions do not depend on the code under test.
 */
function ledger(entries: readonly (readonly [number, number])[], currency = 'CNY'): UsageSample[] {
  let spent = 0;
  const out: UsageSample[] = [];
  entries.forEach(([at, total], index) => {
    if (index > 0) {
      spent += Math.max(0, entries[index - 1][1] - total);
    }
    out.push({ at, currency, total, granted: 0, toppedUp: total, spent });
  });
  return out;
}

test('buildBalanceUrl targets the documented endpoint', () => {
  assert.equal(buildBalanceUrl('https://api.deepseek.com').toString(), 'https://api.deepseek.com/user/balance');
  assert.equal(buildBalanceUrl('https://api.deepseek.com/').toString(), 'https://api.deepseek.com/user/balance');
  assert.equal(buildBalanceUrl('https://proxy.example/v1').toString(), 'https://proxy.example/user/balance');
  assert.throws(() => buildBalanceUrl('not a url'), DeepSeekError);
});

test('parseBalance maps the documented response shape', () => {
  const snapshot = parseBalance(
    {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        { currency: 'USD', total_balance: '3.5', granted_balance: '0', topped_up_balance: '3.5' },
      ],
    },
    1_700_000_000_000,
  );

  assert.equal(snapshot.isAvailable, true);
  assert.deepEqual(snapshot.balances, [
    { currency: 'CNY', totalBalance: 110, grantedBalance: 10, toppedUpBalance: 100 },
    { currency: 'USD', totalBalance: 3.5, grantedBalance: 0, toppedUpBalance: 3.5 },
  ]);
  assert.deepEqual(samplesFromSnapshot(snapshot), [
    { at: 1_700_000_000_000, currency: 'CNY', total: 110, granted: 10, toppedUp: 100, spent: 0 },
    { at: 1_700_000_000_000, currency: 'USD', total: 3.5, granted: 0, toppedUp: 3.5, spent: 0 },
  ]);
});

test('parseBalance rejects responses without balance information', () => {
  assert.throws(() => parseBalance({ is_available: true, balance_infos: [] }, 0), DeepSeekError);
  assert.throws(() => parseBalance('nope', 0), DeepSeekError);
});

test('appendSample rolls cumulative spend forward', () => {
  const first = raw(0, 10);
  const second = appendSample([first], raw(HOUR, 5));
  const third = appendSample(second, raw(2 * HOUR, 20), 0);

  assert.deepEqual(
    second.map((sample) => sample.spent),
    [0, 5],
  );
  assert.deepEqual(
    third.map((sample) => sample.spent),
    [0, 5, 5],
    'a top-up adds nothing to spend',
  );
});

test('appendSample collapses readings inside the same instant window', () => {
  const first = raw(1000, 10);

  const collapsed = appendSample([first], raw(3000, 9), 5_000);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].spent, 1);

  const kept = appendSample([first], raw(9_000, 9), 5_000);
  assert.equal(kept.length, 2);
  assert.equal(kept[1].spent, 1);
});

test('appendSample keeps currencies independent', () => {
  const cny = raw(0, 10, 'CNY');
  const both = appendSample([cny], raw(0, 5, 'USD'), 0);
  const grown = appendSample(both, raw(HOUR, 8, 'CNY'), 0);

  assert.deepEqual(trackedCurrencies(grown), ['CNY', 'USD']);
  assert.equal(grown[2].currency, 'CNY');
  assert.equal(grown[2].spent, 2, 'only the CNY ledger moved');
});

test('spendBetween uses cumulative totals and ignores top-ups', () => {
  const samples = ledger([
    [0, 100],
    [HOUR, 95],
    [2 * HOUR, 98],
    [3 * HOUR, 90],
  ]);

  assert.equal(spendBetween(samples, 'CNY', 0, 3 * HOUR), 13, '5 + 0 (top-up ignored) + 8');
  assert.equal(spendBetween(samples, 'CNY', 2 * HOUR, 3 * HOUR), 8);
  assert.equal(spendBetween(samples, 'CNY', -HOUR, 3 * HOUR), null, 'no reading at or before the window start');
  assert.equal(spendBetween(samples, 'CNY', 3 * HOUR, 3 * HOUR), 0);
  assert.equal(spendBetween(samples, 'USD', 0, 3 * HOUR), null);
});

test('retention keeps the last two hours raw', () => {
  const now = 10 * HOUR;
  let samples: UsageSample[] = [];
  for (let minute = 0; minute <= 120; minute++) {
    samples = appendSample(samples, raw(now - (120 - minute) * 60_000, 200 - minute), 0);
  }

  const retained = applyRetention(samples, now);
  assert.equal(retained.length, samples.length, 'nothing recent is dropped');
});

test('retention thins old readings without changing spend totals', () => {
  const readings = 30 * 24;
  const now = 40 * DAY;
  let samples: UsageSample[] = [];
  for (let hour = 0; hour < readings; hour++) {
    samples = appendSample(samples, raw(hour * HOUR, 1000 - hour), 0);
  }

  const retained = applyRetention(samples, now);
  assert.ok(retained.length < readings / 4, `expected heavy thinning, kept ${retained.length}`);
  assert.ok(retained.length > 100, `expected a month of history to survive, kept ${retained.length}`);
  assert.equal(retained[0].at, samples[0].at, 'the oldest reading anchors long windows');
  assert.equal(retained[retained.length - 1].at, samples[samples.length - 1].at, 'the newest reading is kept');

  assert.equal(spendBetween(samples, 'CNY', 0, now), readings - 1);
  assert.equal(
    spendBetween(retained, 'CNY', 0, now),
    readings - 1,
    'thinning must not lose the spend carried by dropped readings',
  );
});

test('summarize scopes the burn rate to the most recent readings', () => {
  const now = 30 * HOUR;
  const samples = ledger([
    [0, 130],
    [24 * HOUR, 120],
    [now, 90],
  ]);

  const summary = summarize(samples, 'CNY', now);
  assert.ok(summary);
  assert.equal(summary.balance, 90);
  assert.equal(summary.spentTotal, 40);
  assert.equal(summary.windows[0].amount, 40, 'spend totals still cover the whole day');
  assert.equal(summary.windows[1].amount, null, 'no history seven days back');
  assert.equal(summary.burnSpanMs, 6 * HOUR, 'measured against the newest reading at least 30 minutes old');
  assert.ok(summary.burnPerHour !== null);
  assert.ok(Math.abs(summary.burnPerHour - 30 / 6) < 1e-9, '30 spent over the last 6 hours');
  assert.ok(summary.runwayHours !== null);
  assert.ok(Math.abs(summary.runwayHours - 90 / 5) < 1e-9);
});

test('summarize reports an idle rate once a session has ended', () => {
  const now = 30 * HOUR;
  // A burst 20 hours ago and nothing since. The day window still sees the spend,
  // but nothing is burning now, so the runway must not be extrapolated from it.
  const samples = ledger([
    [0, 130],
    [10 * HOUR, 90],
    [now, 90],
  ]);

  const summary = summarize(samples, 'CNY', now);
  assert.ok(summary);
  assert.equal(summary.windows[0].amount, 40, 'the day window still counts the burst');
  assert.equal(summary.burnPerHour, 0);
  assert.equal(summary.burnSpanMs, 20 * HOUR, 'the span the zero was measured over is reported');
  assert.equal(summary.runwayHours, null, 'an idle account has no runway');
});

test('recentBurnRate needs enough time and reports the span it measured', () => {
  assert.equal(recentBurnRate(ledger([[0, 100]]), 'CNY', 0), null, 'a single reading has no rate');

  const brief = ledger([
    [0, 100],
    [5 * 60_000, 90],
  ]);
  assert.equal(recentBurnRate(brief, 'CNY', 5 * 60_000), null, 'five minutes is too short to extrapolate');

  const rate = recentBurnRate(
    ledger([
      [0, 100],
      [HOUR, 90],
    ]),
    'CNY',
    HOUR,
  );
  assert.deepEqual(rate, { perHour: 10, spanMs: HOUR });
});

test('summarize reports zero burn and no runway for a flat balance', () => {
  const now = 2 * HOUR;
  const summary = summarize(ledger([[0, 50], [now, 50]]), 'CNY', now);
  assert.ok(summary);
  assert.equal(summary.windows[0].amount, null, 'not enough history for a 24 hour window');
  assert.equal(summary.burnPerHour, 0);
  assert.equal(summary.runwayHours, null, 'zero burn means no finite runway');
});

test('summarize returns null for an unknown currency', () => {
  assert.equal(summarize([raw(0, 10)], 'USD', 1000), null);
});

test('history helpers track currencies, trim, and survive corrupt storage', () => {
  const samples = [raw(0, 10, 'CNY'), raw(HOUR, 5, 'USD'), raw(2 * HOUR, 9, 'CNY')];
  assert.deepEqual(trackedCurrencies(samples), ['CNY', 'USD']);

  const trimmed = trimSamples(samples, 2);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[0].currency, 'USD');

  assert.deepEqual(parseSamples(undefined), []);
  assert.deepEqual(parseSamples([{ at: 5, currency: 'CNY', total: 1 }]), [
    { at: 5, currency: 'CNY', total: 1, granted: 0, toppedUp: 0, spent: 0 },
  ]);
  assert.deepEqual(
    parseSamples([
      { at: 2, currency: 'CNY', total: 1 },
      { at: 1, currency: 'CNY', total: 2 },
    ]).map((entry) => entry.at),
    [1, 2],
    'entries are sorted on load',
  );
});

test('parseSamples back-fills spend for entries stored before it was recorded', () => {
  const legacy = parseSamples([
    { at: 1, currency: 'CNY', total: 10 },
    { at: 2, currency: 'CNY', total: 7 },
    { at: 3, currency: 'CNY', total: 9 },
  ]);
  assert.deepEqual(legacy.map((entry) => entry.spent), [0, 3, 3]);
});

test('parseSamples trusts a stored cumulative spend', () => {
  const stored = parseSamples([
    { at: 1, currency: 'CNY', total: 10, spent: 0 },
    { at: 2, currency: 'CNY', total: 7, spent: 3 },
  ]);
  assert.deepEqual(stored.map((entry) => entry.spent), [0, 3]);
});

function panelData(overrides: Partial<UsagePanelData> = {}): UsagePanelData {
  return {
    configured: true,
    error: undefined,
    samples: [],
    summaries: [],
    timeZone: 'America/Chicago',
    baseUrl: 'https://api.deepseek.com',
    pollLabel: '1 minute',
    polling: { tier: 'active', intervalMs: 60_000, unchangedStreak: 0 },
    ...overrides,
  };
}

test('usage panel prompts for an API key when none is configured', () => {
  const html = renderUsageHtml(panelData({ configured: false }), 30 * HOUR);
  assert.match(html, /No API key configured/);
  assert.match(html, /No readings yet/);
  assert.match(html, /polled every 1 minute/);
  assert.match(html, /Content-Security-Policy/);
  assert.equal(html.includes('<script'), false, 'the panel ships no scripts');
});

test('usage panel reports balance, spend and a chart', () => {
  const samples = ledger([
    [0, 130],
    [24 * HOUR, 120],
    [30 * HOUR, 90],
  ]);
  const now = 30 * HOUR;
  const summary = summarize(samples, 'CNY', now);
  assert.ok(summary);

  const html = renderUsageHtml(panelData({ samples, summaries: [summary] }), now);
  assert.match(html, /<h2>CNY<\/h2>/);
  assert.match(html, /CNY 90\.00/);
  assert.match(html, /Last 24 hours/);
  assert.match(html, /CNY 40\.00/);
  assert.match(html, /Spent/);
  assert.match(html, /since tracking began 1d 6h ago/);
  assert.match(html, /Runway/);
  assert.match(html, /at CNY 5\.00\/h over the last 6h/, 'the runway states the rate and window behind it');
  assert.match(html, /<polyline class="line" points="/);
  assert.match(html, /api\.deepseek\.com/);
});

test('usage panel reports an idle runway rather than a stale average', () => {
  const samples = ledger([
    [0, 130],
    [10 * HOUR, 90],
    [30 * HOUR, 90],
  ]);
  const now = 30 * HOUR;
  const summary = summarize(samples, 'CNY', now);
  assert.ok(summary);

  const html = renderUsageHtml(panelData({ samples, summaries: [summary] }), now);
  assert.match(html, /idle: no spend over the last 20h/);
  assert.match(
    html,
    /<div class="label">Spent<\/div><div class="value">CNY 40\.00<\/div>/,
    'the burst is still reported as spend',
  );
});

test('usage panel explains a paused or backing-off tracker', () => {
  const paused = renderUsageHtml(
    panelData({ polling: { tier: 'paused', intervalMs: 60_000, unchangedStreak: 0 } }),
    1000,
  );
  assert.match(paused, /Polling is paused while no VS Code window is focused/);

  const backingOff = renderUsageHtml(
    panelData({ polling: { tier: 'backoff', intervalMs: 900_000, unchangedStreak: 3 } }),
    1000,
  );
  assert.match(backingOff, /Backing off to 15 minutes/);
});

test('usage panel surfaces poll errors and escapes them', () => {
  const html = renderUsageHtml(panelData({ error: '<script>alert(1)</script>' }), 1000);
  assert.match(html, /Last poll failed/);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('sparkline falls back to text with a single reading', () => {
  assert.match(sparkline([raw(0, 10)], 'CNY', 'America/Chicago'), /Not enough readings/);
  assert.match(sparkline([raw(0, 10), raw(HOUR, 5)], 'CNY', 'America/Chicago'), /<svg/);
});
