import * as vscode from 'vscode';
import { formatDateTime, formatDuration, formatTime, timeZoneAbbreviation } from './format';
import { HOLIDAY_DATA_THROUGH, HolidayProvider, upcomingWeekdayHolidays } from './holidays';
import { RateStatus, peakWindowLabels, upcomingTransitions } from './rates';

export interface ScheduleContext {
  readonly status: RateStatus;
  readonly holidays: HolidayProvider;
  readonly timeZone: string;
  readonly now: number;
}

export async function showScheduleQuickPick(context: ScheduleContext): Promise<void> {
  const { status, holidays, timeZone, now } = context;
  const items: vscode.QuickPickItem[] = [];

  items.push({
    label: status.isPeak ? '$(circle-filled) Peak — full price' : '$(circle-filled) Off-peak — ½ price',
    kind: vscode.QuickPickItemKind.Default,
    detail: `${formatDateTime(status.at, timeZone)} ${timeZoneAbbreviation(status.at, timeZone)}`,
  });

  if (status.nextChange) {
    const target = status.nextChangeToPeak ? 'Peak' : 'Off-peak';
    items.push({
      label: `$(watch) Changes to ${target} at ${formatTime(status.nextChange, timeZone)}`,
      description: `in ${formatDuration(status.nextChange.getTime() - now)}`,
    });
  }

  items.push({ label: 'Upcoming rate changes', kind: vscode.QuickPickItemKind.Separator });

  for (const transition of upcomingTransitions(status.at, holidays, 8)) {
    items.push({
      label: `$(circle-filled) ${transition.becomesPeak ? 'Peak' : 'Off-peak'} — ${formatDateTime(transition.time, timeZone)}`,
      description: transition.becomesPeak ? 'full price' : '½ price',
      detail: `${formatDuration(transition.time.getTime() - now)} from now`,
    });
  }

  items.push({ label: 'Chinese holidays ahead', kind: vscode.QuickPickItemKind.Separator });
  const holidaysAhead = upcomingWeekdayHolidays(holidays, status.at, 90);
  if (holidaysAhead.length === 0) {
    items.push({ label: 'None in the next 90 days' });
  } else {
    for (const hit of holidaysAhead.slice(0, 10)) {
      items.push({ label: `$(calendar) ${hit.date}`, description: hit.name ?? 'Chinese public holiday' });
    }
  }

  items.push({ label: 'Schedule', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(globe) Peak windows',
    description: peakWindowLabels().join(', '),
    detail: `Monday–Friday, excluding Chinese public holidays. All other hours are off-peak at ½ price. Displayed in ${timeZone}.`,
  });

  if (status.scheduleUnknown) {
    items.push({
      label: '$(warning) Holiday data exhausted',
      detail: `The bundled schedule ends ${HOLIDAY_DATA_THROUGH}. Later dates are assumed to be working days; add exceptions with deepseekUtilization.extraHolidays.`,
    });
  }

  await vscode.window.showQuickPick(items, {
    title: 'DeepSeek Utilization',
    placeHolder: status.isPeak ? 'Peak pricing is active' : 'Off-peak pricing is active',
    matchOnDetail: true,
  });
}
