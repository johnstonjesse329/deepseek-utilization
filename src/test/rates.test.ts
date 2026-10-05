import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDuration, formatMoney, formatTime, safeTimeZone } from '../format';
import { ChineseHolidayProvider, HOLIDAY_DATA_THROUGH, NO_HOLIDAYS, upcomingWeekdayHolidays } from '../holidays';
import { computeStatus, isPeakAt, peakWindowLabels, upcomingTransitions } from '../rates';

const at = (iso: string): Date => new Date(iso);

test('peak windows cover both UTC blocks on a weekday', () => {
  assert.equal(isPeakAt(at('2026-03-04T01:00:00Z'), NO_HOLIDAYS), true);
  assert.equal(isPeakAt(at('2026-03-04T03:59:59Z'), NO_HOLIDAYS), true);
  assert.equal(isPeakAt(at('2026-03-04T06:00:00Z'), NO_HOLIDAYS), true);
  assert.equal(isPeakAt(at('2026-03-04T09:59:59Z'), NO_HOLIDAYS), true);
});

test('weekday hours outside the peak windows are off-peak', () => {
  assert.equal(isPeakAt(at('2026-03-04T00:00:00Z'), NO_HOLIDAYS), false);
  assert.equal(isPeakAt(at('2026-03-04T00:59:59Z'), NO_HOLIDAYS), false);
  assert.equal(isPeakAt(at('2026-03-04T04:00:00Z'), NO_HOLIDAYS), false);
  assert.equal(isPeakAt(at('2026-03-04T05:59:59Z'), NO_HOLIDAYS), false);
  assert.equal(isPeakAt(at('2026-03-04T10:00:00Z'), NO_HOLIDAYS), false);
  assert.equal(isPeakAt(at('2026-03-04T23:59:59Z'), NO_HOLIDAYS), false);
});

test('weekends are off-peak in full', () => {
  assert.equal(isPeakAt(at('2026-03-07T02:00:00Z'), NO_HOLIDAYS), false);
  assert.equal(isPeakAt(at('2026-03-08T07:00:00Z'), NO_HOLIDAYS), false);
});

test('chinese public holidays are off-peak on weekdays', () => {
  const holidays = new ChineseHolidayProvider();
  assert.equal(holidays.isHoliday('2025-10-01'), true);
  assert.equal(isPeakAt(at('2025-10-01T02:00:00Z'), holidays), false);
  assert.equal(isPeakAt(at('2026-10-01T07:00:00Z'), holidays), false);
  assert.equal(isPeakAt(at('2025-09-30T02:00:00Z'), holidays), true);
});

test('a weekend make-up workday stays off-peak', () => {
  const holidays = new ChineseHolidayProvider();
  assert.equal(holidays.isHoliday('2025-09-28'), false, 'make-up workday is not a statutory holiday');
  assert.equal(isPeakAt(at('2025-09-28T02:00:00Z'), holidays), false, 'Sunday wins regardless of the make-up workday');
});

test('next change is the end of the current peak window', () => {
  const status = computeStatus(at('2026-03-04T03:30:00Z'), NO_HOLIDAYS);
  assert.equal(status.isPeak, true);
  assert.equal(status.nextChange?.toISOString(), '2026-03-04T04:00:00.000Z');
  assert.equal(status.nextChangeToPeak, false);
});

test('next change is the start of the next peak window', () => {
  const status = computeStatus(at('2026-03-04T04:30:00Z'), NO_HOLIDAYS);
  assert.equal(status.isPeak, false);
  assert.equal(status.nextChange?.toISOString(), '2026-03-04T06:00:00.000Z');
  assert.equal(status.nextChangeToPeak, true);
});

test('the gap between peak windows is off-peak', () => {
  const status = computeStatus(at('2026-03-04T05:30:00Z'), NO_HOLIDAYS);
  assert.equal(status.isPeak, false);
  assert.equal(status.nextChange?.toISOString(), '2026-03-04T06:00:00.000Z');
});

test('friday morning skips the weekend to monday peak', () => {
  const status = computeStatus(at('2026-03-06T10:30:00Z'), NO_HOLIDAYS);
  assert.equal(status.isPeak, false);
  assert.equal(status.nextChange?.toISOString(), '2026-03-09T01:00:00.000Z');
  assert.equal(status.nextChangeToPeak, true);
});

test('after midnight the next peak is the same day', () => {
  const status = computeStatus(at('2026-03-04T00:15:00Z'), NO_HOLIDAYS);
  assert.equal(status.isPeak, false);
  assert.equal(status.nextChange?.toISOString(), '2026-03-04T01:00:00.000Z');
});

test('upcoming transitions alternate between peak and off-peak', () => {
  const transitions = upcomingTransitions(at('2026-03-04T00:15:00Z'), NO_HOLIDAYS, 4);
  assert.deepEqual(
    transitions.map((transition) => `${transition.time.toISOString()} ${transition.becomesPeak}`),
    [
      '2026-03-04T01:00:00.000Z true',
      '2026-03-04T04:00:00.000Z false',
      '2026-03-04T06:00:00.000Z true',
      '2026-03-04T10:00:00.000Z false',
    ],
  );
});

test('a holiday suspends the weekday peak windows', () => {
  const holidays = new ChineseHolidayProvider();
  const status = computeStatus(at('2026-10-01T02:00:00Z'), holidays);
  assert.equal(status.isPeak, false);
  assert.equal(status.scheduleUnknown, false);
  assert.equal(status.nextChange?.toISOString(), '2026-10-08T01:00:00.000Z');
});

test('dates past the published schedule are flagged, not silently guessed', () => {
  const holidays = new ChineseHolidayProvider();
  assert.equal(holidays.isUnknown('2026-12-31'), false);
  assert.equal(holidays.isUnknown('2027-01-04'), true);

  const status = computeStatus(at('2027-01-04T02:00:00Z'), holidays);
  assert.equal(status.isPeak, true, 'assumed working day');
  assert.equal(status.scheduleUnknown, true);
  assert.equal(HOLIDAY_DATA_THROUGH, '2026-12-31');
});

test('configured extra holidays close the schedule gap', () => {
  const holidays = new ChineseHolidayProvider(['2027-01-04', 'not-a-date']);
  assert.equal(holidays.isUnknown('2027-01-04'), false);
  assert.equal(isPeakAt(at('2027-01-04T02:00:00Z'), holidays), false);
  assert.equal(holidays.name('2027-01-04'), 'User-defined holiday');
});

test('upcoming weekday holidays skip weekends and name real holidays', () => {
  const holidays = new ChineseHolidayProvider();
  const hits = upcomingWeekdayHolidays(holidays, at('2026-09-20T00:00:00Z'), 30);
  assert.equal(hits[0]?.date, '2026-09-25');
  assert.match(hits[0]?.name ?? '', /Mid-autumn/);
  assert.equal(hits.some((hit) => hit.date === '2026-10-03'), false, 'Saturday is skipped');
  assert.equal(hits.some((hit) => hit.date === '2026-10-05'), true);
});

test('peak window labels describe the rule', () => {
  assert.deepEqual(peakWindowLabels(), ['01:00–04:00 UTC', '06:00–10:00 UTC']);
});

test('formatting converts UTC windows into the configured zone', () => {
  assert.equal(safeTimeZone('America/Chicago'), 'America/Chicago');
  assert.equal(safeTimeZone('Not/AZone'), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(formatTime(at('2026-03-04T04:00:00Z'), 'America/Chicago'), '10:00 PM');
  assert.equal(formatTime(at('2026-07-01T04:00:00Z'), 'America/Chicago'), '11:00 PM');
});

test('duration and money formatting are stable', () => {
  assert.equal(formatDuration(0), '<1m');
  assert.equal(formatDuration(45_000), '<1m');
  assert.equal(formatDuration(90_000), '1m');
  assert.equal(formatDuration(3_600_000 * 2 + 60_000 * 14), '2h 14m');
  assert.equal(formatDuration(86_400_000 * 2 + 3_600_000 * 3), '2d 3h');
  assert.equal(formatDuration(86_400_000 * 2), '2d');
  assert.equal(formatDuration(3_600_000 * 2), '2h');
  assert.equal(formatDuration(60_000), '1m');
  assert.equal(formatMoney(1234.5, 'CNY'), 'CNY 1,234.50');
  assert.equal(formatMoney(0.5, 'USD'), 'USD 0.50');
});
