import * as vscode from 'vscode';
import { fetchBalance, DeepSeekError } from './deepseek';
import { PollCadence, PollPolicy, PollState } from './polling';
import {
  SpendSummary,
  UsageSample,
  appendSample,
  applyRetention,
  latestSample,
  parseSamples,
  samplesFromSnapshot,
  summarize,
  trackedCurrencies,
  trimSamples,
} from './usage';

const STORAGE_KEY = 'deepseekUtilization.usageSamples';
const MAX_SAMPLES = 20_000;
const MIN_INTERVAL_MS = 15_000;

export interface UsageSettings {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly maxBackoffMs: number;
  readonly backoffWhenUnchanged: boolean;
  readonly pauseWhenUnfocused: boolean;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}

/** Current cadence, plus when the next automatic poll is due. */
export interface PollStatus extends PollState {
  /** Milliseconds until the next automatic poll, or null while paused. */
  readonly nextPollInMs: number | null;
}

export class UsageTracker implements vscode.Disposable {
  private samples: UsageSample[];
  private settings: UsageSettings = {
    enabled: false,
    intervalMs: 15 * 60_000,
    maxBackoffMs: 60 * 60_000,
    backoffWhenUnchanged: true,
    pauseWhenUnfocused: true,
    baseUrl: 'https://api.deepseek.com',
    apiKey: undefined,
  };
  private readonly cadence: PollCadence;
  private readonly windowState: vscode.Disposable;
  private timer: NodeJS.Timeout | undefined;
  private nextPollAt: number | undefined;
  private refreshing = false;
  private disposed = false;

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this.changed.event;

  lastError: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    this.samples = parseSamples(context.globalState.get(STORAGE_KEY));
    this.cadence = new PollCadence(policyFor(this.settings), vscode.window.state.focused);
    this.windowState = vscode.window.onDidChangeWindowState((state) => this.onWindowState(state));
  }

  pollStatus(now = Date.now()): PollStatus {
    return {
      ...this.cadence.state(),
      nextPollInMs: this.nextPollAt === undefined ? null : Math.max(0, this.nextPollAt - now),
    };
  }

  get allSamples(): readonly UsageSample[] {
    return this.samples;
  }

  get currencies(): string[] {
    return trackedCurrencies(this.samples);
  }

  summary(currency: string, now = Date.now()): SpendSummary | null {
    return summarize(this.samples, currency, now);
  }

  applySettings(settings: UsageSettings): void {
    const keyOrIntervalChanged =
      settings.apiKey !== this.settings.apiKey ||
      settings.intervalMs !== this.settings.intervalMs ||
      settings.baseUrl !== this.settings.baseUrl;
    this.settings = settings;
    this.cadence.setPolicy(policyFor(settings));
    this.schedule();

    if (keyOrIntervalChanged && this.canPoll() && !this.cadence.paused) {
      void this.refresh();
    }
  }

  /**
   * The next poll is scheduled only once the previous one has finished, so a slow
   * request can never overlap, and a paused tracker simply has no timer at all.
   */
  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.nextPollAt = undefined;
    if (!this.canPoll() || this.cadence.paused) {
      return;
    }
    const delay = this.cadence.intervalMs();
    this.nextPollAt = Date.now() + delay;
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  private canPoll(): boolean {
    return !this.disposed && this.settings.enabled && this.settings.apiKey !== undefined;
  }

  private onWindowState(state: vscode.WindowState): void {
    if (this.cadence.setFocused(state.focused) && this.canPoll()) {
      // Focus is back: read now rather than wait out an interval that was measured
      // for a session nobody was looking at.
      void this.refresh({ force: true });
      return;
    }
    this.schedule();
    this.changed.fire();
  }

  async refresh(options: { force?: boolean } = {}): Promise<void> {
    if (this.refreshing || this.disposed) {
      return;
    }
    if (options.force) {
      // Somebody asked for this reading, so treat it as fresh activity and go back
      // to the configured cadence rather than the backed-off one.
      this.cadence.resetBackoff();
    }
    const { apiKey, baseUrl } = this.settings;

    if (!apiKey) {
      this.lastError = 'No DeepSeek API key configured.';
      this.changed.fire();
      return;
    }

    this.refreshing = true;
    let balanceChanged = false;
    try {
      const before = this.latestTotals();
      const snapshot = await fetchBalance(baseUrl, apiKey);
      balanceChanged = snapshot.balances.some(
        (balance) => before.get(balance.currency) !== balance.totalBalance,
      );

      let samples = this.samples;
      for (const sample of samplesFromSnapshot(snapshot)) {
        samples = appendSample(samples, sample);
      }
      this.samples = trimSamples(applyRetention(samples, snapshot.at), MAX_SAMPLES);
      await this.context.globalState.update(STORAGE_KEY, this.samples);
      this.lastError = undefined;
      const readable = snapshot.balances
        .map((balance) => `${balance.currency} ${balance.totalBalance.toFixed(2)}`)
        .join(', ');
      this.log.appendLine(`[${new Date(snapshot.at).toISOString()}] balance: ${readable}`);
    } catch (error) {
      this.lastError = error instanceof DeepSeekError ? error.message : String(error);
      this.log.appendLine(`[${new Date().toISOString()}] balance poll failed: ${this.lastError}`);
    } finally {
      this.refreshing = false;
      this.cadence.recordReading(balanceChanged);
      this.changed.fire();
      this.schedule();
    }
  }

  private latestTotals(): Map<string, number> {
    const totals = new Map<string, number>();
    for (const currency of this.currencies) {
      const sample = latestSample(this.samples, currency);
      if (sample) {
        totals.set(currency, sample.total);
      }
    }
    return totals;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.windowState.dispose();
    this.changed.dispose();
  }
}

function policyFor(settings: UsageSettings): PollPolicy {
  const intervalMs = Math.max(MIN_INTERVAL_MS, settings.intervalMs);
  return {
    intervalMs,
    maxBackoffMs: Math.max(intervalMs, settings.maxBackoffMs),
    backoffWhenUnchanged: settings.backoffWhenUnchanged,
    pauseWhenUnfocused: settings.pauseWhenUnfocused,
  };
}
