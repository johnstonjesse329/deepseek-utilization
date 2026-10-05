import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Guards on the manifest, which the unit tests otherwise never touch. The
 * `baseUrl` scope in particular is a security boundary rather than a
 * preference: an ordinary setting can be overridden by a workspace, and a
 * workspace-supplied origin would receive the API key the extension holds.
 */
const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as {
  name: string;
  displayName: string;
  repository?: { url?: string };
  contributes: {
    configuration: {
      properties: Record<string, { type?: string; scope?: string; default?: unknown }>;
    };
  };
};

test('the base URL cannot be redirected by a workspace', () => {
  const baseUrl = manifest.contributes.configuration.properties['peakRateClock.usage.baseUrl'];
  assert.ok(baseUrl, 'the base URL setting still exists');
  assert.equal(
    baseUrl.scope,
    'application',
    'only user settings may set the DeepSeek origin, or a workspace could redirect the API key',
  );
});

test('the manifest names the extension and points at its repo', () => {
  assert.equal(manifest.name, 'deepseek-utilization');
  assert.equal(manifest.displayName, 'DeepSeek Utilization');
  assert.match(
    manifest.repository?.url ?? '',
    /deepseek-utilization\.git$/,
    'the repository field matches the extension name',
  );
});
