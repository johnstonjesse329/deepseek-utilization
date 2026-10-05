import assert from 'node:assert/strict';
import test from 'node:test';
import { PollCadence, describePolling, type PollPolicy } from '../polling';

const MINUTE = 60_000;

function policy(overrides: Partial<PollPolicy> = {}): PollPolicy {
  return {
    intervalMs: MINUTE,
    maxBackoffMs: 15 * MINUTE,
    backoffWhenUnchanged: true,
    pauseWhenUnfocused: true,
    ...overrides,
  };
}

test('cadence polls at the configured interval while readings change', () => {
  const cadence = new PollCadence(policy());
  assert.equal(cadence.state().tier, 'active');
  assert.equal(cadence.intervalMs(), MINUTE);

  cadence.recordReading(true);
  assert.equal(cadence.intervalMs(), MINUTE, 'a change keeps the cadence');
  assert.equal(cadence.state().tier, 'active');
});

test('cadence doubles the interval for each unchanged reading', () => {
  const cadence = new PollCadence(policy());
  const delays: number[] = [];
  for (let reading = 0; reading < 5; reading++) {
    cadence.recordReading(false);
    delays.push(cadence.intervalMs());
  }

  assert.deepEqual(delays, [2 * MINUTE, 4 * MINUTE, 8 * MINUTE, 15 * MINUTE, 15 * MINUTE]);
  assert.equal(cadence.state().tier, 'backoff');
  assert.equal(cadence.state().unchangedStreak, 5);
});

test('the backoff never overflows past its ceiling', () => {
  const cadence = new PollCadence(policy());
  for (let reading = 0; reading < 40; reading++) {
    cadence.recordReading(false);
  }
  assert.equal(cadence.intervalMs(), 15 * MINUTE);
});

test('a change or a manual refresh drops the backoff', () => {
  const cadence = new PollCadence(policy());
  cadence.recordReading(false);
  cadence.recordReading(false);
  assert.equal(cadence.intervalMs(), 4 * MINUTE);

  cadence.recordReading(true);
  assert.equal(cadence.intervalMs(), MINUTE, 'a change resets the cadence');

  cadence.recordReading(false);
  cadence.resetBackoff();
  assert.equal(cadence.intervalMs(), MINUTE, 'a manual refresh resets the cadence');
  assert.equal(cadence.state().unchangedStreak, 0);
});

test('backoff can be turned off without touching the streak', () => {
  const cadence = new PollCadence(policy({ backoffWhenUnchanged: false }));
  cadence.recordReading(false);
  cadence.recordReading(false);

  assert.equal(cadence.intervalMs(), MINUTE);
  assert.equal(cadence.state().tier, 'active', 'a fixed schedule never claims to be backing off');
});

test('changing the configured interval keeps the streak', () => {
  const cadence = new PollCadence(policy());
  cadence.recordReading(false);
  assert.equal(cadence.intervalMs(), 2 * MINUTE);

  cadence.setPolicy(policy({ intervalMs: 5 * MINUTE }));
  assert.equal(cadence.intervalMs(), 10 * MINUTE);
});

test('an unfocused window pauses the cadence until focus returns', () => {
  const cadence = new PollCadence(policy(), true);
  assert.equal(cadence.paused, false);

  assert.equal(cadence.setFocused(false), false, 'losing focus is not a resume');
  assert.equal(cadence.paused, true);
  assert.equal(cadence.state().tier, 'paused');
  assert.equal(
    describePolling(cadence.state()),
    'Polling is paused while no VS Code window is focused; the balance is re-read as soon as you come back.',
  );

  assert.equal(cadence.setFocused(false), false, 'still unfocused is not a resume');
  assert.equal(cadence.setFocused(true), true, 'regaining focus is a resume');
  assert.equal(cadence.paused, false);
  assert.equal(cadence.setFocused(true), false, 'focus already held is not a resume');
});

test('a cadence that never pauses cannot be resumed', () => {
  const cadence = new PollCadence(policy({ pauseWhenUnfocused: false }), true);
  assert.equal(cadence.setFocused(false), false);
  assert.equal(cadence.paused, false);
  assert.equal(cadence.state().tier, 'active');
});

test('describePolling explains the backoff and stays quiet while polling normally', () => {
  const cadence = new PollCadence(policy());
  assert.equal(describePolling(cadence.state()), undefined);

  cadence.recordReading(false);
  assert.equal(
    describePolling(cadence.state()),
    'Backing off to 2 minutes: the balance has not changed in the last 1 reading.',
  );

  cadence.recordReading(false);
  assert.equal(
    describePolling(cadence.state()),
    'Backing off to 4 minutes: the balance has not changed in the last 2 readings.',
  );
});
