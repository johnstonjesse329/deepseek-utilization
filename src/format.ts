/** Resolve an IANA time zone, falling back to the machine's zone when invalid. */
export function safeTimeZone(timeZone: string | undefined): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!timeZone) {
    return fallback;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return fallback;
  }
}

export function formatInZone(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(date);
}

export function formatTime(date: Date, timeZone: string): string {
  return formatInZone(date, timeZone, { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(date: Date, timeZone: string): string {
  return formatInZone(date, timeZone, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function timeZoneAbbreviation(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(date);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
}

/**
 * `2d 3h`, `2h 14m`, `14m`, `<1m`.
 *
 * Deliberately minute-granular: a countdown that ticks in seconds forces the
 * status bar and hover preview to re-render every second, which makes the hover
 * flicker. Minute precision keeps the rendered text stable between refreshes.
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) {
    return '<1m';
  }
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return '<1m';
}

/** `45 seconds`, `1 minute`, `15 minutes`, `2 hours`. */
export function formatInterval(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) {
    return `${seconds} seconds`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export function formatMoney(value: number, currency: string): string {
  return `${currency} ${formatCount(value, 2)}`;
}

/** Group thousands and round to `fractionDigits` decimals. */
export function formatCount(value: number, fractionDigits = 0): string {
  const fixed = value.toFixed(fractionDigits);
  const [whole, fraction] = fixed.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const grouped = whole.replace(/^-/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}
