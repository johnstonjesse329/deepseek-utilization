# DeepSeek Utilization

A VS Code extension that tells you, at a glance, whether DeepSeek API pricing is
currently **peak** or **off-peak** — so you can schedule work into the cheap hours —
and keeps your remaining credit in the status bar.

Off-peak rates are **half** of peak rates.

## The rule

| Window | Rate |
| --- | --- |
| 01:00–04:00 UTC | Peak |
| 04:00–06:00 UTC | Off-peak |
| 06:00–10:00 UTC | Peak |
| 10:00–01:00 UTC (next day) | Off-peak |

Peak only applies **Monday–Friday**, and **never** on a Chinese public holiday.
Everything else — all weekend hours, all holiday hours — is off-peak at half price.

Quoted from DeepSeek's [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)
page (checked 2026-10-04), which is the authority for everything in the table above:

> Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
> 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays. All
> other hours are off-peak, including weekends and Chinese public holidays in full.

The windows are defined in UTC; the extension converts them into whatever time
zone you configure (`America/Chicago`, US Central, by default).

## Status bar

The item names itself, shows the current rate and countdown, and your remaining
balance:

```
$(circle-filled) DeepSeek: Off-peak · ½ price · 2h 14m · CNY 110.00     (green)
$(circle-filled) DeepSeek: Peak · full price · 45m · CNY 108.20         (red)
```

The `DeepSeek:` prefix comes from `peakRateClock.statusBar.label`, so the item is
identifiable at a glance rather than an anonymous countdown. Set it to an empty
string to drop it, and hide the balance with
`peakRateClock.usage.showBalanceInStatusBar`.

Hover for upcoming rate changes, the next Chinese holidays, the rule restated in
your local time, and balance / burn-rate / runway detail. Click for the full
schedule.

## Why nothing flickers

A status bar item that is reassigned on a timer re-renders its hover preview, which
reads as strobing. So the controller:

* re-renders **at most every 30 seconds**, and wakes up just after the next minute
  boundary or rate flip, whichever comes first — never more often than needed;
* **drops renders that produce identical text** instead of writing them;
* keeps countdowns **minute-granular** (`1h 30m`, `<1m`), never second-by-second.

The usage webview is the same: it only reloads its document when the rendered
markup actually changed, so your scroll position survives a poll.

## Commands

| Command | What it does |
| --- | --- |
| `DeepSeek Utilization: Show Rate Schedule` | Quick pick with upcoming changes, holidays and the rule |
| `DeepSeek Utilization: Show DeepSeek Usage` | Balance, inferred spend and a history chart |
| `DeepSeek Utilization: Refresh DeepSeek Balance` | Poll the balance immediately |
| `DeepSeek Utilization: Set DeepSeek API Key` | Store your key in VS Code Secret Storage |
| `DeepSeek Utilization: Clear DeepSeek API Key` | Remove the stored key |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `peakRateClock.timeZone` | `America/Chicago` | IANA zone used for all displayed times |
| `peakRateClock.statusBarAlignment` | `right` | Which side of the status bar to use |
| `peakRateClock.statusBar.label` | `DeepSeek` | Identifying prefix in the bar text |
| `peakRateClock.extraHolidays` | `[]` | Extra `YYYY-MM-DD` holidays (UTC) to treat as off-peak |
| `peakRateClock.usage.enabled` | `true` | Poll the DeepSeek balance |
| `peakRateClock.usage.pollIntervalSeconds` | `60` | How often to poll while readings keep changing (15–3600 s) |
| `peakRateClock.usage.backoffWhenUnchanged` | `true` | Stretch the interval while the balance does not move |
| `peakRateClock.usage.maxBackoffSeconds` | `900` | Ceiling for that backoff (60–86400 s) |
| `peakRateClock.usage.pauseWhenUnfocused` | `true` | Stop polling while no VS Code window is focused |
| `peakRateClock.usage.showBalanceInStatusBar` | `true` | Show the balance in the bar text |
| `peakRateClock.usage.balanceCurrency` | `""` | Currency for the bar when several are reported |
| `peakRateClock.usage.baseUrl` | `https://api.deepseek.com` | API origin (application-scoped: see below) |

## DeepSeek usage tracking

DeepSeek documents exactly one account endpoint, `GET /user/balance`, which reports
**remaining credit**. There is no usage or token-consumption API — the published
surface is generation, model listing, the Files API and this balance call — so the
[usage dashboard](https://platform.deepseek.com/usage) is the only place DeepSeek
itself breaks consumption down, and it is web-only.
([Get User Balance](https://api-docs.deepseek.com/api/get-user-balance) ·
[API index](https://api-docs.deepseek.com/api/deepseek-api), checked 2026-10-04.)

So the extension polls the balance every
`peakRateClock.usage.pollIntervalSeconds` (default 60 seconds, 15 minimum, because
credits can drain fast across concurrent sessions), keeps the readings, and derives
spend from the drops between them.

* **Spent in the last 24 hours / 7 days / 30 days** — the panel's window table, read
  off a cumulative spend total carried on each reading, so a top-up never cancels out
  real consumption. A window reports `—` until history reaches back that far.
* **Spent** — the running total since tracking began, shown in the tooltip and the
  panel, and the only spend figure that is not a window.
* **Runway** — the forecast, and the only time-scoped figure in the tooltip: the
  current balance at the recent burn rate, always shown with the rate and the window
  it came from (`≈ CNY 2.40/h over the last 30m`) so the estimate can be judged
  rather than trusted. The rate is the newest reading measured against the newest one
  at least 30 minutes old, falling back to the tracked history while that is shorter.
  With nothing spent in the recent window there is no rate to extrapolate, so the
  runway reads `none` instead of a stale average.

### Poll pacing

A minute-by-minute poll is only worth making while something is actually burning
credit, so two brakes apply. Neither costs accuracy: every reading carries a
cumulative spend total, so a gap between readings changes how finely the history is
sampled, never what the totals come to.

* **Unfocused window** — while no VS Code window has focus no poll is scheduled at
  all, so an editor left open in the background makes no requests. Gaining focus
  reads the balance immediately, so the first thing you see is current. Turn this
  off with `peakRateClock.usage.pauseWhenUnfocused`. The trade-off is that spending
  which happens while nothing is focused shows up as a single balance drop on the
  next reading: the total stays exact, only its timing gets coarse.
* **Unchanged balance** — each reading that shows the same balance doubles the
  interval, up to `peakRateClock.usage.maxBackoffSeconds` (default 15 minutes),
  because an unchanged balance means nothing is being spent. Any change — including
  a top-up — snaps the interval back to the configured one, and a failed poll counts
  as no news so a flaky endpoint is retried gently too. Turn this off with
  `peakRateClock.usage.backoffWhenUnchanged`.

The tooltip and the usage panel both say when the tracker is backing off or paused,
and `DeepSeek Utilization: Refresh DeepSeek Balance` always reads immediately.

At a 60-second interval a naive history would be ~43,000 entries a month, so
readings are kept raw for the last 2 hours and then thinned (5-minute buckets for a
day, 30-minute for a week, 6-hourly beyond). Because spend is cumulative on each
reading, thinning never changes the totals, and the oldest reading is always kept so
long windows keep their baseline.

History lives in VS Code global state. Spend and the burn rate are only observed
while VS Code is running, so treat both as a lower bound on real usage — and expect
the rate to lag the last reading rather than the current instant.

The API key lives in VS Code Secret Storage, never in `settings.json`, and is only
sent to the DeepSeek API origin you configure.

`peakRateClock.usage.baseUrl` is deliberately **application-scoped**, so only your
user settings can set it. An ordinary setting could otherwise be overridden by a
`.vscode/settings.json` in any repository you open, which would hand the key your
extension already holds to whichever host that file named. User scope keeps that
decision yours. (VS Code stores secrets per extension id, so renaming the extension
means entering the key again.)

## Chinese holiday data

Holiday dates come from [chinese-days](https://github.com/vsme/chinese-days), which
ships the State Council arrangements for **2004 through 2026**. Once the clock runs
past that, the extension assumes ordinary working days and says so in the tooltip.
Add dates to `peakRateClock.extraHolidays` to cover the gap.

Note that Chinese *make-up workdays* (调休) are ignored by design: the rule says all
weekend hours are off-peak, so a weekend that China designates as a working day
stays off-peak here.

## Sources

Everything the extension asserts about DeepSeek traces to DeepSeek's own docs
(checked 2026-10-04). If a page moves or the rule changes, these are the places to
re-check:

| Claim | Source |
| --- | --- |
| Peak hours 01:00–04:00 and 06:00–10:00 UTC Mon–Fri; off-peak is half price; weekends and holidays off-peak in full | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) |
| `GET /user/balance`, and the `is_available` / `balance_infos[]` schema the parser mirrors | [Get User Balance](https://api-docs.deepseek.com/api/get-user-balance) |
| No usage or token-consumption endpoint exists | [API index](https://api-docs.deepseek.com/api/deepseek-api) and the docs [sitemap](https://api-docs.deepseek.com/sitemap.xml) |

The one third-party input is the holiday *dates*: the pricing doc supplies the rule
that Chinese public holidays are off-peak, and
[chinese-days](https://github.com/vsme/chinese-days) supplies which dates those are.

## Development

```bash
npm install
npm run compile        # tsc -p ./
npm test               # compiles, then runs node --test
npm run test:smoke     # activates the compiled extension against a stubbed host
npm run package        # builds deepseek-utilization-<version>.vsix
```

Press `F5` to launch an Extension Development Host, or install a build with:

```bash
code --install-extension deepseek-utilization-0.3.0.vsix
```

The rate logic in `src/rates.ts`, the spend maths in `src/usage.ts`, the poll pacing
in `src/polling.ts`, the tooltip markup in `src/tooltip.ts` and the panel markup in
`src/usageHtml.ts` are all pure modules with no VS Code dependency, which is what the
unit tests exercise.
`test/activation.smoke.cjs` goes a step further: it stubs the `vscode` module,
stands up a local HTTP server in place of the DeepSeek API, activates the real
`out/extension.js`, drives every command, and counts status bar writes to prove
identical renders are skipped.
