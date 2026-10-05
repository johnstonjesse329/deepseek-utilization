import * as vscode from 'vscode';
import { formatInterval, formatMoney, safeTimeZone } from './format';
import { ChineseHolidayProvider } from './holidays';
import { RateStatus, computeStatus } from './rates';
import { showScheduleQuickPick } from './schedule';
import { ClockStatusBar } from './statusBar';
import { UsageViewState, statusBarText, tooltipMarkdown } from './tooltip';
import type { SpendSummary } from './usage';
import { UsagePanelData } from './usageHtml';
import { UsageTracker } from './usageTracker';
import { UsagePanel } from './usageView';

const API_KEY_SECRET = 'peakRateClock.deepseekApiKey';
/** Never re-render the status bar more often than this. */
const MAX_REFRESH_MS = 30_000;
/** ...and never sleep longer than a rate flip can be away. */
const MIN_REFRESH_MS = 1_000;
const MINUTE_MS = 60_000;
const MIN_POLL_SECONDS = 15;

interface Settings {
  readonly timeZone: string;
  readonly alignment: 'left' | 'right';
  readonly statusBarLabel: string;
  readonly extraHolidays: readonly string[];
  readonly usageEnabled: boolean;
  readonly usageIntervalMs: number;
  readonly usageMaxBackoffMs: number;
  readonly usageBackoffWhenUnchanged: boolean;
  readonly usagePauseWhenUnfocused: boolean;
  readonly usageBaseUrl: string;
  readonly usageShowBalance: boolean;
  readonly usageBalanceCurrency: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Peak Rate Clock');
  const statusBar = new ClockStatusBar(readSettings().alignment);
  const usage = new UsageTracker(context, log);
  const usagePanel = new UsagePanel();
  context.subscriptions.push(log, statusBar, usage, usagePanel);

  let settings = readSettings();
  let holidays = new ChineseHolidayProvider(settings.extraHolidays);
  let apiKey: string | undefined = await context.secrets.get(API_KEY_SECRET);
  let status: RateStatus = computeStatus(new Date(), holidays);
  let timer: NodeJS.Timeout | undefined;

  const summaries = (now: number): SpendSummary[] =>
    usage.currencies
      .map((currency) => usage.summary(currency, now))
      .filter((summary): summary is SpendSummary => summary !== null);

  const usageViewState = (now: number): UsageViewState => ({
    configured: apiKey !== undefined,
    error: usage.lastError,
    summaries: summaries(now),
    polling: usage.pollStatus(now),
  });

  const panelData = (now: number): UsagePanelData => ({
    configured: apiKey !== undefined,
    error: usage.lastError,
    samples: usage.allSamples,
    summaries: summaries(now),
    timeZone: safeTimeZone(settings.timeZone),
    baseUrl: settings.usageBaseUrl,
    pollLabel: formatInterval(settings.usageIntervalMs),
    polling: usage.pollStatus(now),
  });

  const balanceLabel = (now: number): string | undefined => {
    if (!settings.usageShowBalance || apiKey === undefined) {
      return undefined;
    }
    const currency = settings.usageBalanceCurrency || usage.currencies[0];
    if (!currency) {
      return undefined;
    }
    const summary = usage.summary(currency, now);
    return summary ? formatMoney(summary.balance, currency) : undefined;
  };

  /**
   * Wake up for the next thing that can change the display: the next minute
   * boundary (the countdown is minute-granular), the next rate flip, or the
   * ceiling. Writes are guarded in ClockStatusBar, so a wake-up that changes
   * nothing produces no UI churn — the tooltip must not be reassigned on a timer
   * or the hover preview strobes.
   */
  const scheduleNextRefresh = (now: number): void => {
    if (timer) {
      clearTimeout(timer);
    }
    const toMinuteBoundary = MINUTE_MS - (now % MINUTE_MS);
    const toTransition = status.nextChange
      ? status.nextChange.getTime() - now
      : Number.POSITIVE_INFINITY;
    const delay = Math.max(MIN_REFRESH_MS, Math.min(toMinuteBoundary, toTransition, MAX_REFRESH_MS));
    timer = setTimeout(tick, delay);
  };

  const tick = (): void => {
    const now = Date.now();
    status = computeStatus(new Date(now), holidays);
    statusBar.update({
      text: statusBarText(status, now, {
        label: settings.statusBarLabel,
        balance: balanceLabel(now),
      }),
      tooltip: tooltipMarkdown(
        status,
        holidays,
        safeTimeZone(settings.timeZone),
        usageViewState(now),
        now,
      ),
      isPeak: status.isPeak,
    });
    scheduleNextRefresh(now);
  };

  const applyUsageSettings = (): void => {
    usage.applySettings({
      enabled: settings.usageEnabled,
      intervalMs: settings.usageIntervalMs,
      maxBackoffMs: settings.usageMaxBackoffMs,
      backoffWhenUnchanged: settings.usageBackoffWhenUnchanged,
      pauseWhenUnfocused: settings.usagePauseWhenUnfocused,
      baseUrl: settings.usageBaseUrl,
      apiKey,
    });
  };

  usage.onDidChange(() => {
    tick();
    if (usagePanel.visible) {
      usagePanel.update(panelData(Date.now()));
    }
  });

  context.subscriptions.push(
    { dispose: () => { if (timer) { clearTimeout(timer); } } },
    vscode.commands.registerCommand('peakRateClock.showSchedule', () =>
      showScheduleQuickPick({
        status,
        holidays,
        timeZone: safeTimeZone(settings.timeZone),
        now: Date.now(),
      }),
    ),
    vscode.commands.registerCommand('peakRateClock.showUsage', () =>
      usagePanel.show(panelData(Date.now())),
    ),
    vscode.commands.registerCommand('peakRateClock.refreshUsage', async () => {
      if (apiKey === undefined) {
        const choice = await vscode.window.showWarningMessage(
          'Peak Rate Clock: set a DeepSeek API key before polling your balance.',
          'Set API Key',
        );
        if (choice === 'Set API Key') {
          await vscode.commands.executeCommand('peakRateClock.setApiKey');
        }
        return;
      }
      await usage.refresh({ force: true });
      tick();
    }),
    vscode.commands.registerCommand('peakRateClock.setApiKey', async () => {
      const entered = await vscode.window.showInputBox({
        title: 'DeepSeek API Key',
        prompt: 'Stored in VS Code Secret Storage and only sent to DeepSeek.',
        placeHolder: 'sk-...',
        password: true,
        ignoreFocusOut: true,
      });
      if (entered === undefined) {
        return;
      }
      const trimmed = entered.trim();
      if (trimmed.length === 0) {
        await context.secrets.delete(API_KEY_SECRET);
        apiKey = undefined;
      } else {
        await context.secrets.store(API_KEY_SECRET, trimmed);
        apiKey = trimmed;
      }
      applyUsageSettings();
      await usage.refresh({ force: true });
      tick();
    }),
    vscode.commands.registerCommand('peakRateClock.clearApiKey', async () => {
      await context.secrets.delete(API_KEY_SECRET);
      apiKey = undefined;
      applyUsageSettings();
      tick();
      void vscode.window.showInformationMessage('Peak Rate Clock: DeepSeek API key cleared.');
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('peakRateClock')) {
        return;
      }
      settings = readSettings();
      holidays = new ChineseHolidayProvider(settings.extraHolidays);
      statusBar.setAlignment(settings.alignment);
      applyUsageSettings();
      tick();
    }),
    context.secrets.onDidChange((event) => {
      if (event.key !== API_KEY_SECRET) {
        return;
      }
      void context.secrets.get(API_KEY_SECRET).then((key) => {
        apiKey = key;
        applyUsageSettings();
        tick();
      });
    }),
  );

  applyUsageSettings();
  tick();
}

export function deactivate(): void {
  // Every resource is registered on the extension context and released by VS Code.
}

function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('peakRateClock');
  const pollSeconds = Math.max(MIN_POLL_SECONDS, config.get<number>('usage.pollIntervalSeconds', 60));
  const maxBackoffSeconds = Math.max(pollSeconds, config.get<number>('usage.maxBackoffSeconds', 900));
  return {
    timeZone: config.get<string>('timeZone', 'America/Chicago'),
    alignment: config.get<string>('statusBarAlignment') === 'left' ? 'left' : 'right',
    statusBarLabel: config.get<string>('statusBar.label', 'DeepSeek').trim(),
    extraHolidays: config.get<string[]>('extraHolidays', []),
    usageEnabled: config.get<boolean>('usage.enabled', true),
    usageIntervalMs: pollSeconds * 1000,
    usageMaxBackoffMs: maxBackoffSeconds * 1000,
    usageBackoffWhenUnchanged: config.get<boolean>('usage.backoffWhenUnchanged', true),
    usagePauseWhenUnfocused: config.get<boolean>('usage.pauseWhenUnfocused', true),
    usageBaseUrl: config.get<string>('usage.baseUrl', 'https://api.deepseek.com'),
    usageShowBalance: config.get<boolean>('usage.showBalanceInStatusBar', true),
    usageBalanceCurrency: config.get<string>('usage.balanceCurrency', ''),
  };
}
