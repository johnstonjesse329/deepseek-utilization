import { formatDateTime, formatDuration, formatMoney, formatTime, timeZoneAbbreviation } from './format';
import { HOLIDAY_DATA_THROUGH, HolidayProvider, upcomingWeekdayHolidays } from './holidays';
import { describePolling, PollState } from './polling';
import { PEAK_WINDOWS, RateStatus, peakWindowLabels, upcomingTransitions } from './rates';
import type { SpendSummary } from './usage';

export interface UsageViewState {
  readonly configured: boolean;
  readonly error: string | undefined;
  readonly summaries: readonly SpendSummary[];
  /** Current poll pacing, so a tracker that is deliberately slow explains itself. */
  readonly polling: PollState;
}

export interface StatusBarTextOptions {
  /** Identifying prefix, e.g. `DeepSeek`, so the item is not an anonymous blob. */
  readonly label?: string;
  /** Pre-formatted balance, e.g. `CNY 110.00`. */
  readonly balance?: string;
}

/**
 * Status bar text: an identifying label, the current rate, the countdown, and the
 * balance when one is available. Callers should skip assigning this when it is
 * unchanged so the status bar and its hover preview stay put between refreshes.
 */
export function statusBarText(
  status: RateStatus,
  now: number,
  options: StatusBarTextOptions = {},
): string {
  const parts = [status.isPeak ? 'Peak · full price' : 'Off-peak · ½ price'];
  if (status.nextChange) {
    parts.push(formatDuration(status.nextChange.getTime() - now));
  }
  if (options.balance) {
    parts.push(options.balance);
  }
  const label = options.label ? `${options.label}: ` : '';
  return `$(circle-filled) ${label}${parts.join(' · ')}`;
}

export function tooltipMarkdown(
  status: RateStatus,
  holidays: HolidayProvider,
  timeZone: string,
  usage: UsageViewState,
  now: number,
): string {
  const lines: string[] = [];

  lines.push('### DeepSeek Utilization');
  lines.push('');
  lines.push(
    status.isPeak
      ? '**Peak right now** — full price.'
      : '**Off-peak right now** — ½ price (50% cheaper).',
  );
  lines.push(
    `${formatDateTime(status.at, timeZone)} ${timeZoneAbbreviation(status.at, timeZone)} · \`${timeZone}\``,
  );
  lines.push('');

  if (status.nextChange) {
    const target = status.nextChangeToPeak ? 'Peak (full price)' : 'Off-peak (½ price)';
    lines.push(
      `**Changes in ${formatDuration(status.nextChange.getTime() - now)}** → ${target} at ${formatTime(status.nextChange, timeZone)}`,
    );
  } else {
    lines.push('**No rate change found in the next two weeks.**');
  }
  lines.push('');

  const transitions = upcomingTransitions(status.at, holidays, 4);
  if (transitions.length > 0) {
    lines.push('**Upcoming**');
    for (const transition of transitions) {
      const label = transition.becomesPeak ? 'Peak (full price)' : 'Off-peak (½ price)';
      lines.push(`- ${formatDateTime(transition.time, timeZone)} — ${label}`);
    }
    lines.push('');
  }

  if (status.scheduleUnknown) {
    lines.push(
      `⚠️ The bundled Chinese holiday schedule ends ${HOLIDAY_DATA_THROUGH}; later dates are assumed to be working days. Add exceptions with \`peakRateClock.extraHolidays\`.`,
    );
    lines.push('');
  }

  const holidaysAhead = upcomingWeekdayHolidays(holidays, status.at, 45);
  if (holidaysAhead.length > 0) {
    lines.push('**Next Chinese holidays** (off-peak all day)');
    for (const hit of holidaysAhead.slice(0, 3)) {
      lines.push(`- ${hit.date}${hit.name ? ` — ${hit.name}` : ''}`);
    }
    lines.push('');
  }

  lines.push('**Rule**');
  lines.push(
    `Peak is ${peakWindowLabels().join(' and ')}, Mon–Fri, excluding Chinese public holidays. Every other hour — including all weekend hours — is off-peak at ½ price. Times shown in ${timeZone} (today: ${localWindowLabel(timeZone, status.at)}). [Source](https://api-docs.deepseek.com/quick_start/pricing/)`,
  );
  lines.push('');

  lines.push('**DeepSeek balance**');
  lines.push(...usageLines(usage, now));
  lines.push('');
  lines.push(
    '[Set API key](command:peakRateClock.setApiKey) · [Usage details](command:peakRateClock.showUsage) · [Refresh now](command:peakRateClock.refreshUsage)',
  );

  return lines.join('\n');
}

function localWindowLabel(timeZone: string, reference: Date): string {
  return PEAK_WINDOWS.map((window) => {
    const start = boundaryInstant(reference, window.startMinute);
    const end = boundaryInstant(reference, window.endMinute);
    return `${formatTime(start, timeZone)}–${formatTime(end, timeZone)}`;
  }).join(', ');
}

function boundaryInstant(reference: Date, minuteOfDay: number): Date {
  return new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate(), 0, minuteOfDay),
  );
}

function usageLines(usage: UsageViewState, now: number): string[] {
  if (!usage.configured) {
    return [
      '- Not connected. Add a DeepSeek API key to track your balance and spend.',
      '- DeepSeek publishes no usage API, so spend is inferred from balance readings taken while VS Code is open.',
    ];
  }

  const lines: string[] = [];
  for (const summary of usage.summaries) {
    lines.push(
      `- **${formatMoney(summary.balance, summary.currency)}** remaining · granted ${formatMoney(summary.granted, summary.currency)} · topped up ${formatMoney(summary.toppedUp, summary.currency)}`,
    );
    lines.push(...spendLines(summary));
    lines.push(`- Last checked ${formatDuration(now - summary.updatedAt)} ago`);
  }

  if (usage.summaries.length === 0) {
    lines.push('- No readings yet — the first balance poll has not completed.');
  }
  const polling = describePolling(usage.polling);
  if (polling) {
    lines.push(`- ${polling}`);
  }
  if (usage.error) {
    lines.push(`- ⚠️ ${usage.error}`);
  }
  return lines;
}

/**
 * What has been spent, and what that implies for the balance.
 *
 * The Spent line is the running total for this history. Everything time-scoped —
 * the burn rate, the window it was measured over, and the runway that follows —
 * lives in the Runway line together, so the one figure that is an extrapolation is
 * also the one figure that states what it extrapolates from.
 */
function spendLines(summary: SpendSummary): string[] {
  const scope = formatDuration(summary.burnSpanMs ?? summary.trackedMs);
  const lines = [
    `- Spent ${formatMoney(summary.spentTotal, summary.currency)} since tracking began ${formatDuration(summary.trackedMs)} ago`,
  ];

  if (summary.runwayHours !== null && summary.burnPerHour !== null) {
    const rate = `${formatMoney(summary.burnPerHour, summary.currency)}/h`;
    lines.push(
      `- Runway ≈ ${formatDuration(summary.runwayHours * 3_600_000)} at ${rate} over the last ${scope}`,
    );
  } else if (summary.burnPerHour === 0) {
    lines.push(`- Runway: none — no spend over the last ${scope}, so nothing is burning.`);
  } else {
    lines.push('- Runway: needs more readings of the balance to measure a rate.');
  }

  return lines;
}
