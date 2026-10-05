import { formatCount, formatDateTime, formatDuration, formatMoney } from './format';
import { describePolling, PollState } from './polling';
import { SpendSummary, UsageSample, samplesFor, trackedCurrencies } from './usage';

const STYLES = `
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 20px 24px 48px;
    line-height: 1.5;
  }
  h1 { font-size: 1.5em; margin: 0 0 4px; font-weight: 600; }
  h2 { font-size: 1.1em; margin: 28px 0 8px; font-weight: 600; }
  p { margin: 4px 0 12px; }
  code {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .muted { color: var(--vscode-descriptionForeground); }
  .callout {
    border-left: 3px solid var(--vscode-panel-border);
    background: var(--vscode-textBlockQuote-background);
    padding: 10px 14px;
    margin: 12px 0;
    border-radius: 2px;
  }
  .callout.warn { border-left-color: var(--vscode-editorWarning-foreground); }
  .cards { display: flex; flex-wrap: wrap; gap: 14px; margin: 12px 0; }
  .card {
    flex: 1 1 220px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 14px 16px;
    background: var(--vscode-editorWidget-background);
  }
  .card .label { font-size: 0.85em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.06em; }
  .card .value { font-size: 1.7em; font-weight: 600; margin: 4px 0 6px; }
  .card .sub { font-size: 0.9em; color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  th { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  td.num, th.num { text-align: right; font-family: var(--vscode-editor-font-family); }
  .spend-up { color: var(--vscode-editorWarning-foreground); }
  .chart { margin: 14px 0 4px; }
  .chart svg { width: 100%; height: auto; display: block; }
  .chart .line { fill: none; stroke: var(--vscode-charts-blue); stroke-width: 2; }
  .chart .axis { stroke: var(--vscode-panel-border); stroke-width: 1; }
  .chart text { fill: var(--vscode-descriptionForeground); font-size: 11px; font-family: var(--vscode-editor-font-family); }
`;

export interface UsagePanelData {
  readonly configured: boolean;
  readonly error: string | undefined;
  readonly samples: readonly UsageSample[];
  readonly summaries: readonly SpendSummary[];
  readonly timeZone: string;
  readonly baseUrl: string;
  readonly pollLabel: string;
  readonly polling: PollState;
}

export function renderUsageHtml(data: UsagePanelData, now: number): string {
  const body: string[] = [];

  body.push('<h1>DeepSeek usage</h1>');
  body.push(
    `<p class="muted">Balance readings polled every ${esc(data.pollLabel)} from <code>${esc(data.baseUrl)}</code>. DeepSeek exposes no usage endpoint, so spend is inferred from balance drops observed while VS Code is running, and the burn rate and runway come from the most recent readings only.</p>`,
  );

  const polling = describePolling(data.polling);
  if (polling) {
    body.push(`<p class="muted">${esc(polling)}</p>`);
  }

  if (!data.configured) {
    body.push(
      '<div class="callout warn"><strong>No API key configured.</strong><br>Run <code>Peak Rate Clock: Set DeepSeek API Key</code> from the Command Palette. The key is kept in VS Code Secret Storage and is only sent to DeepSeek.</div>',
    );
  } else if (data.error) {
    body.push(`<div class="callout warn"><strong>Last poll failed.</strong><br>${esc(data.error)}</div>`);
  }

  const currencies = trackedCurrencies(data.samples);
  if (currencies.length === 0) {
    body.push(
      '<div class="callout"><strong>No readings yet.</strong><br>Balance history will appear after the first successful poll.</div>',
    );
  } else {
    for (const currency of currencies) {
      body.push(renderCurrencySection(currency, data.summaries.find((entry) => entry.currency === currency), data, now));
    }
  }

  body.push('<h2>Recent readings</h2>');
  body.push(renderRecentTable(data.samples, data.timeZone));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>DeepSeek Usage</title>
<style>${STYLES}</style>
</head>
<body>
${body.join('\n')}
</body>
</html>`;
}

function renderCurrencySection(
  currency: string,
  summary: SpendSummary | undefined,
  data: UsagePanelData,
  now: number,
): string {
  if (!summary) {
    return '';
  }

  const parts: string[] = [];
  parts.push(`<h2>${esc(currency)}</h2>`);
  parts.push('<div class="cards">');
  parts.push(
    card('Balance', formatMoney(summary.balance, currency), `last read ${formatDuration(now - summary.updatedAt)} ago`),
  );
  parts.push(card('Granted', formatMoney(summary.granted, currency), 'free credit'));
  parts.push(card('Topped up', formatMoney(summary.toppedUp, currency), 'paid credit'));
  parts.push(
    card(
      'Spent',
      formatMoney(summary.spentTotal, currency),
      `since tracking began ${formatDuration(summary.trackedMs)} ago`,
    ),
  );

  const burn = summary.burnPerHour;
  const scope = `the last ${formatDuration(summary.burnSpanMs ?? summary.trackedMs)}`;
  if (summary.runwayHours !== null && burn !== null) {
    parts.push(
      card(
        'Runway',
        formatDuration(summary.runwayHours * 3_600_000),
        `at ${formatMoney(burn, currency)}/h over ${scope}`,
      ),
    );
  } else if (burn === 0) {
    parts.push(card('Runway', '—', `idle: no spend over ${scope}`));
  } else {
    parts.push(card('Runway', '—', 'needs more readings'));
  }
  parts.push('</div>');

  parts.push('<table><thead><tr><th>Window</th><th class="num">Spent</th><th>Note</th></tr></thead><tbody>');
  for (const window of summary.windows) {
    const amount = window.amount === null ? '<span class="muted">—</span>' : formatMoney(window.amount, currency);
    const note =
      window.amount === null
        ? `needs ${window.hours >= 48 ? `${Math.round(window.hours / 24)} days` : `${window.hours} h`} of history`
        : 'complete';
    parts.push(
      `<tr><td>${esc(window.label)}</td><td class="num">${amount}</td><td class="muted">${esc(note)}</td></tr>`,
    );
  }
  parts.push('</tbody></table>');

  parts.push(`<div class="chart">${sparkline(data.samples, currency, data.timeZone)}</div>`);
  return parts.join('\n');
}

function card(label: string, value: string, sub: string): string {
  return `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
}

export function sparkline(samples: readonly UsageSample[], currency: string, timeZone: string): string {
  const points = samplesFor(samples, currency);
  if (points.length < 2) {
    return '<p class="muted">Not enough readings yet to draw a chart.</p>';
  }

  const width = 720;
  const height = 160;
  const padX = 52;
  const padY = 16;
  const minX = points[0].at;
  const maxX = points[points.length - 1].at;
  const spanX = Math.max(1, maxX - minX);
  const totals = points.map((point) => point.total);
  const minY = Math.min(...totals);
  const maxY = Math.max(...totals);
  const spanY = Math.max(1e-9, maxY - minY);

  const coords = points
    .map((point) => {
      const x = padX + ((point.at - minX) / spanX) * (width - padX - 12);
      const y = padY + (1 - (point.total - minY) / spanY) * (height - padY * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const label = (value: number, y: number): string =>
    `<text x="4" y="${(y + 4).toFixed(1)}">${esc(formatCount(value, 2))}</text>`;

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Balance over time">
  <line class="axis" x1="${padX}" y1="${padY}" x2="${padX}" y2="${height - padY}"></line>
  <line class="axis" x1="${padX}" y1="${height - padY}" x2="${width - 12}" y2="${height - padY}"></line>
  ${label(maxY, padY)}
  ${label(minY, height - padY)}
  <polyline class="line" points="${coords}"></polyline>
  <text x="${padX}" y="${height - 2}">${esc(formatDateTime(new Date(minX), timeZone))}</text>
  <text x="${width - 12}" y="${height - 2}" text-anchor="end">${esc(formatDateTime(new Date(maxX), timeZone))}</text>
</svg>`;
}

function renderRecentTable(samples: readonly UsageSample[], timeZone: string): string {
  const recent = [...samples].reverse().slice(0, 25);
  if (recent.length === 0) {
    return '<p class="muted">No readings recorded yet.</p>';
  }

  const previousTotals = new Map<string, number>();
  const rows: string[] = [];
  for (const sample of [...recent].reverse()) {
    const previous = previousTotals.get(sample.currency);
    const delta = previous === undefined ? undefined : previous - sample.total;
    previousTotals.set(sample.currency, sample.total);
    const deltaCell =
      delta === undefined || Math.abs(delta) < 1e-9
        ? '<span class="muted">—</span>'
        : `<span class="spend-up">${esc(formatCount(delta, 2))}</span>`;
    rows.push(
      `<tr><td>${esc(formatDateTime(new Date(sample.at), timeZone))}</td><td>${esc(sample.currency)}</td><td class="num">${esc(formatCount(sample.total, 2))}</td><td class="num">${deltaCell}</td></tr>`,
    );
  }
  rows.reverse();

  return `<table><thead><tr><th>When</th><th>Currency</th><th class="num">Balance</th><th class="num">Change</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
