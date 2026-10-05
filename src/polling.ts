import { formatInterval } from './format';

/**
 * Pacing for the DeepSeek balance poll.
 *
 * Polling a balance every minute is only worth it while something is actually
 * burning credit, so two brakes apply. Neither costs data: every reading carries a
 * cumulative spend total, so a gap between readings changes how finely the history
 * is sampled, never what the totals come to.
 *
 * - Unfocused window: while no VS Code window has focus the next poll is not
 *   scheduled at all, so leaving the editor open in the background makes no
 *   requests. Focus returning reads the balance immediately, so what the user
 *   sees the moment they look is current.
 * - Unchanged balance: an unchanged balance is direct evidence that nothing is
 *   being spent, so each unchanged reading doubles the interval up to a ceiling.
 *   Any change — including a top-up — snaps it back to the configured cadence.
 */

export type PollTier = 'active' | 'backoff' | 'paused';

export interface PollPolicy {
  /** Cadence while readings keep changing. */
  readonly intervalMs: number;
  /** Ceiling for the unchanged-balance backoff. */
  readonly maxBackoffMs: number;
  /** Let an unchanged balance stretch the interval. */
  readonly backoffWhenUnchanged: boolean;
  /** Stop polling entirely while no VS Code window has focus. */
  readonly pauseWhenUnfocused: boolean;
}

export interface PollState {
  readonly tier: PollTier;
  /** Interval the next automatic poll will use. */
  readonly intervalMs: number;
  /** Consecutive readings that showed no change. */
  readonly unchangedStreak: number;
}

/** Streaks past this are already far beyond any sane ceiling. */
const MAX_STREAK = 16;

export class PollCadence {
  private unchangedStreak = 0;

  constructor(private policy: PollPolicy, private focused = true) {}

  setPolicy(policy: PollPolicy): void {
    this.policy = policy;
  }

  get paused(): boolean {
    return this.policy.pauseWhenUnfocused && !this.focused;
  }

  /** Returns true when this call takes the cadence out of a paused state. */
  setFocused(focused: boolean): boolean {
    const wasPaused = this.paused;
    this.focused = focused;
    return wasPaused && !this.paused;
  }

  recordReading(changed: boolean): void {
    this.unchangedStreak = changed ? 0 : Math.min(this.unchangedStreak + 1, MAX_STREAK);
  }

  /** A person asked for a reading: go back to the configured cadence. */
  resetBackoff(): void {
    this.unchangedStreak = 0;
  }

  intervalMs(): number {
    if (!this.policy.backoffWhenUnchanged) {
      return this.policy.intervalMs;
    }
    return Math.min(this.policy.maxBackoffMs, this.policy.intervalMs * 2 ** this.unchangedStreak);
  }

  state(): PollState {
    const backingOff = this.policy.backoffWhenUnchanged && this.unchangedStreak > 0;
    return {
      tier: this.paused ? 'paused' : backingOff ? 'backoff' : 'active',
      intervalMs: this.intervalMs(),
      unchangedStreak: this.unchangedStreak,
    };
  }
}

/**
 * Why the balance is not being polled at the configured cadence, or undefined
 * while it is. Shown in the tooltip and the usage panel so a slow tracker is not
 * mistaken for a broken one.
 */
export function describePolling(poll: PollState): string | undefined {
  if (poll.tier === 'paused') {
    return 'Polling is paused while no VS Code window is focused; the balance is re-read as soon as you come back.';
  }
  if (poll.tier === 'backoff') {
    const readings = poll.unchangedStreak === 1 ? '1 reading' : `${poll.unchangedStreak} readings`;
    return `Backing off to ${formatInterval(poll.intervalMs)}: the balance has not changed in the last ${readings}.`;
  }
  return undefined;
}
