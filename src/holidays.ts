import { getDayDetail, isHoliday as chineseIsHoliday } from 'chinese-days';

/**
 * Last calendar date covered by the published State Council holiday arrangement
 * bundled with `chinese-days` (the package ships data for 2004 through 2026).
 */
export const HOLIDAY_DATA_THROUGH = '2026-12-31';

const WEEKDAY_NAMES = new Set([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

/** Everything the rate logic needs to know about the Chinese holiday calendar. */
export interface HolidayProvider {
  /** True when the UTC calendar date (`YYYY-MM-DD`) is a Chinese public holiday. */
  isHoliday(dateUtc: string): boolean;
  /** True when no published holiday schedule exists for the date. */
  isUnknown(dateUtc: string): boolean;
  /** Human readable holiday names, when the date is a Chinese public holiday. */
  name(dateUtc: string): string | undefined;
}

export class ChineseHolidayProvider implements HolidayProvider {
  private readonly extraDates: Set<string>;

  constructor(extraDates: readonly string[] = []) {
    this.extraDates = new Set(extraDates.filter(isDateKey));
  }

  isHoliday(dateUtc: string): boolean {
    if (this.extraDates.has(dateUtc)) {
      return true;
    }
    if (this.isUnknown(dateUtc)) {
      return false;
    }
    return chineseIsHoliday(dateUtc);
  }

  isUnknown(dateUtc: string): boolean {
    return dateUtc > HOLIDAY_DATA_THROUGH && !this.extraDates.has(dateUtc);
  }

  name(dateUtc: string): string | undefined {
    if (this.extraDates.has(dateUtc)) {
      return 'User-defined holiday';
    }
    if (this.isUnknown(dateUtc) || !this.isHoliday(dateUtc)) {
      return undefined;
    }
    return describeHoliday(getDayDetail(dateUtc).name);
  }
}

/** A provider with no holidays at all; every weekday is treated normally. */
export const NO_HOLIDAYS: HolidayProvider = {
  isHoliday: () => false,
  isUnknown: () => false,
  name: () => undefined,
};

export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * `chinese-days` encodes a holiday as e.g. `"National Day,国庆节,3"` and falls back
 * to the English weekday name for ordinary days. Strip the weekday name and the
 * trailing day count so only the holiday names remain.
 */
function describeHoliday(raw: string): string | undefined {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !WEEKDAY_NAMES.has(part) && !/^\d+$/.test(part));
  return parts.length > 0 ? parts.join(' / ') : undefined;
}

export interface HolidayHit {
  readonly date: string;
  readonly name: string | undefined;
}

/**
 * Weekday holidays in the next `days` days. Weekends are already off-peak, so they
 * are skipped here.
 */
export function upcomingWeekdayHolidays(
  provider: HolidayProvider,
  from: Date,
  days = 45,
): HolidayHit[] {
  const hits: HolidayHit[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let offset = 0; offset <= days; offset++) {
    const day = new Date(cursor.getTime() + offset * 86_400_000);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) {
      continue;
    }
    const key = day.toISOString().slice(0, 10);
    if (provider.isHoliday(key)) {
      hits.push({ date: key, name: provider.name(key) });
    }
  }
  return hits;
}
