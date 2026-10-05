import type { HolidayProvider } from './holidays';

/** A half-open `[startMinute, endMinute)` window measured from UTC midnight. */
export interface RateWindow {
  readonly startMinute: number;
  readonly endMinute: number;
}

/**
 * Peak pricing windows: 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday,
 * excluding Chinese public holidays. Every other hour is off-peak at half price.
 */
export const PEAK_WINDOWS: readonly RateWindow[] = [
  { startMinute: 60, endMinute: 240 },
  { startMinute: 360, endMinute: 600 },
];

/** Instants at which the rate can flip; the rate is constant in between. */
const BOUNDARY_MINUTES: readonly number[] = PEAK_WINDOWS.flatMap((w) => [
  w.startMinute,
  w.endMinute,
]);

/** The rate can never be constant for longer than a Spring Festival break. */
const DEFAULT_HORIZON_DAYS = 14;

export interface Transition {
  readonly time: Date;
  readonly becomesPeak: boolean;
}

export interface RateStatus {
  readonly at: Date;
  readonly isPeak: boolean;
  readonly nextChange: Date | null;
  readonly nextChangeToPeak: boolean | null;
  /** True when the holiday schedule has no published data for the relevant date. */
  readonly scheduleUnknown: boolean;
}

export function utcDateKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

function utcMinuteOfDay(instant: Date): number {
  return instant.getUTCHours() * 60 + instant.getUTCMinutes();
}

export function isPeakAt(instant: Date, holidays: HolidayProvider): boolean {
  const weekday = instant.getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return false;
  }
  const minute = utcMinuteOfDay(instant);
  const inWindow = PEAK_WINDOWS.some(
    (window) => minute >= window.startMinute && minute < window.endMinute,
  );
  if (!inWindow) {
    return false;
  }
  return !holidays.isHoliday(utcDateKey(instant));
}

function boundary(origin: Date, dayOffset: number, minuteOfDay: number): Date {
  return new Date(
    Date.UTC(
      origin.getUTCFullYear(),
      origin.getUTCMonth(),
      origin.getUTCDate() + dayOffset,
      0,
      minuteOfDay,
      0,
      0,
    ),
  );
}

export function computeStatus(
  now: Date,
  holidays: HolidayProvider,
  horizonDays = DEFAULT_HORIZON_DAYS,
): RateStatus {
  const isPeak = isPeakAt(now, holidays);
  let nextChange: Date | null = null;

  scan: for (let offset = 0; offset <= horizonDays; offset++) {
    for (const minute of BOUNDARY_MINUTES) {
      const candidate = boundary(now, offset, minute);
      if (candidate.getTime() <= now.getTime()) {
        continue;
      }
      if (isPeakAt(candidate, holidays) !== isPeak) {
        nextChange = candidate;
        break scan;
      }
    }
  }

  const scheduleUnknown =
    holidays.isUnknown(utcDateKey(now)) ||
    (nextChange !== null && holidays.isUnknown(utcDateKey(nextChange)));

  return {
    at: now,
    isPeak,
    nextChange,
    nextChangeToPeak: nextChange === null ? null : !isPeak,
    scheduleUnknown,
  };
}

export function upcomingTransitions(
  now: Date,
  holidays: HolidayProvider,
  count: number,
  horizonDays = DEFAULT_HORIZON_DAYS,
): Transition[] {
  const transitions: Transition[] = [];
  let current = isPeakAt(now, holidays);

  for (let offset = 0; offset <= horizonDays && transitions.length < count; offset++) {
    for (const minute of BOUNDARY_MINUTES) {
      const candidate = boundary(now, offset, minute);
      if (candidate.getTime() <= now.getTime()) {
        continue;
      }
      const at = isPeakAt(candidate, holidays);
      if (at !== current) {
        transitions.push({ time: candidate, becomesPeak: at });
        current = at;
      }
    }
  }

  return transitions;
}

/** Human readable UTC windows, e.g. `["01:00–04:00 UTC", "06:00–10:00 UTC"]`. */
export function peakWindowLabels(): string[] {
  return PEAK_WINDOWS.map(
    (window) => `${minutesToClock(window.startMinute)}–${minutesToClock(window.endMinute)} UTC`,
  );
}

function minutesToClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
