'use strict';

/**
 * Activation smoke test.
 *
 * Unit tests cover the pure logic, but nothing else proves the extension host
 * wiring works. This script stubs the `vscode` module, points the DeepSeek base
 * URL at a local HTTP server, activates the real compiled `out/extension.js`,
 * and drives every registered command.
 *
 *   npm run test:smoke
 *   node test/activation.smoke.cjs <path-to-extension-root>
 */

const Module = require('module');
const http = require('http');
const path = require('path');
const assert = require('assert');

const ROOT = process.argv[2] || path.join(__dirname, '..');

const state = {
  statusBar: null,
  output: null,
  panels: [],
  commands: new Map(),
  configListeners: [],
  secretListeners: [],
  windowStateListeners: [],
  quickPicks: [],
  inputBoxes: [],
  warnings: [],
  infos: [],
  inputBoxResult: undefined,
  counters: { text: 0, tooltip: 0 },
};

const disposable = (fn) => ({ dispose: fn || (() => {}) });

class MarkdownString {
  constructor(value = '') {
    this.value = value;
    this.supportThemeIcons = false;
    this.isTrusted = false;
  }
}
class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return disposable(() => {});
    };
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners = [];
  }
}

const configValues = {};

const secretStore = new Map();
const secrets = {
  async get(key) {
    return secretStore.get(key);
  },
  async store(key, value) {
    secretStore.set(key, value);
  },
  async delete(key) {
    secretStore.delete(key);
  },
  onDidChange(cb) {
    state.secretListeners.push(cb);
    return disposable();
  },
};

const globalStore = new Map();

const vscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, One: 1 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  MarkdownString,
  ThemeColor,
  ThemeIcon,
  EventEmitter,
  window: {
    state: { focused: true, active: true },
    onDidChangeWindowState(cb) {
      state.windowStateListeners.push(cb);
      return disposable();
    },
    createStatusBarItem(alignment, priority) {
      const item = {
        alignment,
        priority,
        _text: '',
        _tooltip: undefined,
        color: undefined,
        command: undefined,
        name: undefined,
        visible: false,
        get text() {
          return this._text;
        },
        set text(value) {
          state.counters.text++;
          this._text = value;
        },
        get tooltip() {
          return this._tooltip;
        },
        set tooltip(value) {
          state.counters.tooltip++;
          this._tooltip = value;
        },
        show() {
          this.visible = true;
        },
        hide() {
          this.visible = false;
        },
        dispose() {
          this.disposed = true;
        },
      };
      state.statusBar = item;
      return item;
    },
    createOutputChannel(name) {
      const channel = {
        name,
        lines: [],
        appendLine(line) {
          this.lines.push(line);
        },
        append(value) {
          this.lines.push(String(value));
        },
        show() {},
        clear() {},
        dispose() {},
      };
      state.output = channel;
      return channel;
    },
    createWebviewPanel(viewType, title, column, options) {
      const panel = {
        viewType,
        title,
        viewColumn: column,
        options,
        webview: { html: '' },
        disposeHandlers: [],
        onDidDispose(cb) {
          this.disposeHandlers.push(cb);
          return disposable();
        },
        reveal() {},
        dispose() {
          for (const cb of this.disposeHandlers) cb();
        },
      };
      state.panels.push(panel);
      return panel;
    },
    async showQuickPick(items, options) {
      state.quickPicks.push({ items, options });
      return undefined;
    },
    async showInputBox(options) {
      state.inputBoxes.push(options);
      return state.inputBoxResult;
    },
    async showWarningMessage(message, ...actions) {
      state.warnings.push({ message, actions });
      return undefined;
    },
    async showInformationMessage(message, ...actions) {
      state.infos.push({ message, actions });
      return undefined;
    },
  },
  workspace: {
    getConfiguration(section) {
      return {
        get(key, fallback) {
          const value = configValues[section ? `${section}.${key}` : key];
          return value === undefined ? fallback : value;
        },
      };
    },
    onDidChangeConfiguration(cb) {
      state.configListeners.push(cb);
      return disposable();
    },
  },
  commands: {
    registerCommand(id, callback) {
      state.commands.set(id, callback);
      return disposable(() => state.commands.delete(id));
    },
    async executeCommand(id, ...args) {
      const callback = state.commands.get(id);
      return callback ? callback(...args) : undefined;
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const context = {
  subscriptions: [],
  secrets,
  globalState: {
    get(key) {
      return globalStore.get(key);
    },
    async update(key, value) {
      globalStore.set(key, value);
    },
    keys() {
      return [...globalStore.keys()];
    },
  },
  extensionUri: { scheme: 'file' },
};

const STORAGE_KEY = 'deepseekUtilization.usageSamples';
const API_KEY_SECRET = 'deepseekUtilization.deepseekApiKey';

async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function setWindowFocus(focused) {
  vscode.window.state = { focused, active: focused };
  for (const listener of state.windowStateListeners) listener(vscode.window.state);
}

async function main() {
  const requests = [];
  const balance = {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    ],
  };
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(balance));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  configValues['deepseekUtilization.timeZone'] = 'America/Chicago';
  configValues['deepseekUtilization.usage.enabled'] = true;
  configValues['deepseekUtilization.usage.pollIntervalSeconds'] = 60;
  configValues['deepseekUtilization.usage.baseUrl'] = `http://127.0.0.1:${server.address().port}`;

  const extension = require(path.join(ROOT, 'out', 'extension.js'));
  await extension.activate(context);

  assert.ok(state.statusBar, 'status bar item was created');
  assert.ok(state.statusBar.visible, 'status bar item is visible');
  assert.match(
    state.statusBar.text,
    /^\$\(circle-filled\) DeepSeek: (?:Off-peak · ½ price|Peak · full price) · /,
    state.statusBar.text,
  );
  assert.equal(state.statusBar.command, 'deepseekUtilization.showSchedule');
  assert.match(state.statusBar.color.id, /^charts\.(green|red)$/);
  assert.match(state.statusBar.tooltip.value, /DeepSeek Utilization/);
  assert.match(state.statusBar.tooltip.value, /01:00–04:00 UTC and 06:00–10:00 UTC/);
  assert.match(state.statusBar.tooltip.value, /Not connected\. Add a DeepSeek API key/);
  console.log('status bar         :', state.statusBar.text);

  const { statusBarText } = require(path.join(ROOT, 'out', 'tooltip.js'));
  const now = Date.now();
  const peakText = statusBarText(
    { at: new Date(now), isPeak: true, nextChange: new Date(now + 45 * 60_000), nextChangeToPeak: false, scheduleUnknown: false },
    now,
  );
  const offPeakText = statusBarText(
    { at: new Date(now), isPeak: false, nextChange: new Date(now + 2 * 3_600_000 + 14 * 60_000), nextChangeToPeak: true, scheduleUnknown: false },
    now,
  );
  assert.equal(peakText, '$(circle-filled) Peak · full price · 45m');
  assert.equal(offPeakText, '$(circle-filled) Off-peak · ½ price · 2h 14m');
  assert.equal(
    statusBarText(
      { at: new Date(now), isPeak: false, nextChange: new Date(now + 2 * 3_600_000), nextChangeToPeak: true, scheduleUnknown: false },
      now,
      { label: 'DeepSeek', balance: 'CNY 110.00' },
    ),
    '$(circle-filled) DeepSeek: Off-peak · ½ price · 2h · CNY 110.00',
  );
  console.log('peak / off-peak    :', peakText, '|', offPeakText);

  await state.commands.get('deepseekUtilization.showSchedule')();
  assert.equal(state.quickPicks.length, 1, 'quick pick was shown');
  const labels = state.quickPicks[0].items.map((item) => item.label).join('\n');
  assert.match(labels, /Peak windows/);
  assert.match(state.quickPicks[0].items[0].label, /Off-peak — ½ price|Peak — full price/);

  await state.commands.get('deepseekUtilization.refreshUsage')();
  assert.equal(state.warnings.length, 1, 'warned about the missing key');
  assert.match(state.warnings[0].message, /set a DeepSeek API key/);
  assert.equal(requests.length, 0, 'no API call without a key');

  state.inputBoxResult = 'sk-smoke-test-key';
  await state.commands.get('deepseekUtilization.setApiKey')();
  assert.equal(secretStore.get(API_KEY_SECRET), 'sk-smoke-test-key');

  const polled = await waitFor(() => (globalStore.get(STORAGE_KEY) || []).length > 0);
  assert.ok(polled, 'a balance reading was stored');
  assert.equal(requests[0].url, '/user/balance');
  assert.equal(requests[0].auth, `Bearer ${state.inputBoxResult}`);

  const samples = globalStore.get(STORAGE_KEY);
  assert.deepEqual(samples[0], {
    at: samples[0].at,
    currency: 'CNY',
    total: 110,
    granted: 10,
    toppedUp: 100,
    spent: 0,
  });
  await waitFor(() => state.statusBar.tooltip.value.includes('CNY 110.00'));
  assert.match(state.statusBar.tooltip.value, /CNY 110\.00/);
  assert.match(state.statusBar.tooltip.value, /Last checked/);
  await waitFor(() => state.statusBar.text.includes('CNY 110.00'));
  assert.match(state.statusBar.text, /CNY 110\.00/, 'balance is in the bar, not just the hover');
  console.log('status bar w/ balance:', state.statusBar.text);
  console.log('stored reading     :', JSON.stringify(samples));

  await state.commands.get('deepseekUtilization.showUsage')();
  assert.equal(state.panels.length, 1, 'usage panel opened');
  const html = state.panels[0].webview.html;
  assert.match(html, /<h1>DeepSeek usage<\/h1>/);
  assert.match(html, /CNY 110\.00/);
  assert.match(html, /Recent readings/);
  assert.match(html, /Content-Security-Policy/);
  assert.equal(html.includes('<script'), false, 'the panel ships no scripts');
  console.log('usage panel bytes  :', html.length);

  await state.commands.get('deepseekUtilization.refreshUsage')();
  assert.equal(requests.length >= 2, true, 'manual refresh polled again');

  // Pacing: an unchanged balance stretches the interval, and an unfocused window
  // stops polling until it comes back, which reads the balance immediately.
  assert.match(
    state.statusBar.tooltip.value,
    /Backing off to 2 minutes: the balance has not changed in the last 1 reading\./,
    state.statusBar.tooltip.value,
  );

  const requestsWhileUnfocused = requests.length;
  setWindowFocus(false);
  assert.match(state.statusBar.tooltip.value, /Polling is paused while no VS Code window is focused/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(requests.length, requestsWhileUnfocused, 'an unfocused window makes no requests');

  setWindowFocus(true);
  assert.ok(
    await waitFor(() => requests.length > requestsWhileUnfocused),
    'regaining focus reads the balance immediately',
  );
  assert.doesNotMatch(state.statusBar.tooltip.value, /Polling is paused/);
  console.log('poll pacing        : backoff while unchanged, paused while unfocused');

  configValues['deepseekUtilization.extraHolidays'] = ['2027-01-04'];
  configValues['deepseekUtilization.timeZone'] = 'UTC';
  for (const listener of state.configListeners) {
    listener({ affectsConfiguration: (section) => section.startsWith('deepseekUtilization') });
  }
  assert.match(state.statusBar.tooltip.value, /`UTC`/, 'time zone change was picked up');

  await state.commands.get('deepseekUtilization.clearApiKey')();
  assert.equal(secretStore.has(API_KEY_SECRET), false);
  assert.match(state.statusBar.tooltip.value, /Not connected/);
  assert.equal(state.infos.length, 1);

  // The tracker's own view of its schedule: a real countdown while it is polling,
  // and no timer at all while the window is unfocused.
  const { UsageTracker } = require(path.join(ROOT, 'out', 'usageTracker.js'));
  const probe = new UsageTracker(context, state.output);
  probe.applySettings({
    enabled: true,
    intervalMs: 60_000,
    maxBackoffMs: 900_000,
    backoffWhenUnchanged: true,
    pauseWhenUnfocused: true,
    baseUrl: configValues['deepseekUtilization.usage.baseUrl'],
    apiKey: 'sk-schedule-probe',
  });
  const scheduled = probe.pollStatus();
  assert.equal(scheduled.tier, 'active');
  assert.ok(scheduled.nextPollInMs > 0 && scheduled.nextPollInMs <= 60_000, 'a poll is scheduled');

  setWindowFocus(false);
  const paused = probe.pollStatus();
  assert.equal(paused.tier, 'paused');
  assert.equal(paused.nextPollInMs, null, 'a paused tracker schedules nothing');
  probe.dispose();
  setWindowFocus(true);
  console.log('poll schedule      : countdown while active, no timer while paused');

  // Regression guard for the strobing hover preview: re-rendering identical
  // content must not write to the status bar item at all.
  const { ClockStatusBar } = require(path.join(ROOT, 'out', 'statusBar.js'));
  const bar = new ClockStatusBar('right');
  const textWritesBefore = state.counters.text;
  const tooltipWritesBefore = state.counters.tooltip;
  for (let render = 0; render < 120; render++) {
    bar.update({ text: 'steady', tooltip: 'steady markdown', isPeak: false });
  }
  assert.equal(state.counters.text - textWritesBefore, 1, 'text is written once, not per render');
  assert.equal(
    state.counters.tooltip - tooltipWritesBefore,
    1,
    'tooltip is written once across 120 identical renders',
  );

  bar.update({ text: 'changed', tooltip: 'steady markdown', isPeak: false });
  assert.equal(state.counters.text - textWritesBefore, 2, 'a real change still writes');
  bar.dispose();
  console.log('render churn guard : 1 tooltip write across 120 renders');

  for (const subscription of context.subscriptions) {
    if (subscription && typeof subscription.dispose === 'function') subscription.dispose();
  }
  extension.deactivate();
  await new Promise((resolve) => server.close(resolve));

  console.log('\nActivation smoke test passed.');
}

main().catch((error) => {
  console.error('\nActivation smoke test FAILED');
  console.error(error);
  if (state.output) console.error('extension log:', state.output.lines.join('\n'));
  process.exit(1);
});
