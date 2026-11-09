# Changelog

## 0.4.0

- Preparing for a public release: added the MIT `LICENSE`, an unofficial /
  non-affiliation notice, an icon, CI, `SECURITY.md` and `CONTRIBUTING.md`.
- **Breaking:** the leftover `peakRateClock.*` configuration keys, command ids and
  Secret Storage key are now `deepseekUtilization.*`. Settings under the old names
  are ignored and the API key has to be entered once more.

## 0.3.0

- Renamed to **DeepSeek Utilization**. The extension id is now
  `local.deepseek-utilization`; the command category, status bar item name, output
  channel, tooltip heading and quick pick title follow it. The `peakRateClock.*`
  configuration keys and command ids are deliberately unchanged, but a new
  extension id means a fresh Secret Storage and global state scope — the API key
  has to be entered once more and the reading history starts over.
- Claims now cite their source. The peak-hour rule and the balance response schema
  were re-checked against DeepSeek's first-party docs and matched exactly, and the
  README, `src/rates.ts`, `src/deepseek.ts` and the tooltip's rule section link to
  them.

## 0.2.0

- Balance polling now paces itself instead of running on a timer.
  - While no VS Code window is focused no poll is scheduled at all, so an editor
    left open in the background makes no requests. Focus returning reads the
    balance immediately. Configurable via
    `peakRateClock.usage.pauseWhenUnfocused`.
  - Each reading that shows the same balance doubles the interval, up to
    `peakRateClock.usage.maxBackoffSeconds` (default 15 minutes), because an
    unchanged balance means nothing is being spent. Any change snaps the interval
    back. Configurable via `peakRateClock.usage.backoffWhenUnchanged`.
  - Polls are chained rather than fixed-interval, so a slow request cannot overlap
    the next one, and the tooltip and panel say when the tracker is backing off or
    paused.
- Spend is now reported as a single running total in the tooltip, and every
  time-scoped figure — the burn rate, the window it was measured over and the runway
  that follows — is confined to the forecast line, which always names its basis
  (`≈ CNY 2.40/h over the last 30m`).
- The burn rate and runway are scoped to the most recent readings — the newest
  reading measured against the newest one at least 30 minutes old — rather than
  averaged over the whole day or session. Stepping away no longer leaves a stale
  average inflating the runway: with nothing burning recently the runway reads
  `none`, and the rate is stated rather than implied. Spend windows are unchanged
  and still exact, and the window table keeps the 24-hour, 7-day and 30-day
  breakdowns.

## 0.1.0

- Initial release.
- Status bar shows an identifying label, the current rate (peak or off-peak) and a
  countdown to the next change, in a configurable time zone (US Central by default).
- Status bar text is updated only when it actually changes, at most every 30 seconds
  and always just after the next minute boundary or rate flip — the hover preview no
  longer strobes.
- Hover tooltip and quick pick list the upcoming rate blocks and the next peak
  window.
- Chinese public holidays are excluded from peak using `chinese-days`; the
  extension warns once the published schedule runs out.
- DeepSeek balance polling every 60 seconds by default (15 s minimum), with the
  balance shown in the status bar.
- Readings carry a cumulative spend total, so spend over 24 hours, 7 and 30 days
  stays exact while old readings are thinned for storage. Burn rate and runway are
  estimated from the same history, and a webview charts it.
