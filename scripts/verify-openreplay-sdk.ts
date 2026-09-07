import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { openReplayPrivacyOptions } from '../src/client/openreplay';

// Verify actual SDK emission without adding the tracker as a package dependency.
// See docs/openreplay.md for the pinned SDK download command.
const sdkRoot = process.argv[2];
assert.ok(sdkRoot, 'Usage: npx tsx scripts/verify-openreplay-sdk.ts /path/to/extracted/package');
const source = fs.readFileSync(`${sdkRoot}/dist/lib/index.js`, 'utf8');
const version = JSON.parse(fs.readFileSync(`${sdkRoot}/package.json`, 'utf8')).version;
assert.equal(version, '18.1.5');
function extractFunction(name: string) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `SDK function ${name} exists`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start);
  return source.slice(start, end + 2);
}
const wiperStart = source.indexOf('const stringWiper = ');
const wiperEnd = source.indexOf('\nclass Sanitizer', wiperStart);
assert.ok(wiperStart >= 0 && wiperEnd > wiperStart);
const sdkCode = source.slice(wiperStart, wiperEnd) + '\n' + extractFunction('Viewport ') + '\nthis.Viewport = Viewport;';
function capture(privateMode: boolean) {
  const preset = openReplayPrivacyOptions();
  const starts: (() => void)[] = [], ticks: (() => void)[] = [], locations: unknown[][] = [];
  const document = { URL: 'https://app.test/invite/SECRET_PATH?token=SECRET_QUERY#SECRET_FRAGMENT', referrer: 'https://app.test/previous?token=SECRET_INITIAL', title: 'SECRET_TITLE' };
  const app = {
    safe: (fn: () => void) => fn,
    sanitizer: { privateMode },
    send() {},
    attachStartCallback: (fn: () => void) => starts.push(fn),
    attachEventListener() {},
    ticker: { attach: (fn: () => void) => ticks.push(fn) },
  };
  const context = vm.createContext({
    document, window: { innerWidth: 800, innerHeight: 600 },
    SetPageLocation: (...args: unknown[]) => locations.push(args),
    SetViewportSize() {}, SetPageVisibility() {}, getTimeOrigin: () => 0,
  });
  vm.runInContext(sdkCode, context);
  context.Viewport(app, preset.urls);
  starts.forEach(fn => fn());
  document.URL = 'https://app.test/dashboard';
  ticks.forEach(fn => fn());
  assert.equal(locations.length, 2);
  return locations;
}
const defaults = openReplayPrivacyOptions();
assert.equal(defaults.privateMode, true);
const actual = capture(defaults.privateMode);
assert.equal(JSON.stringify(actual).includes('SECRET'), false, 'actual preset must not emit raw current/referrer/title secrets');
const negative = capture(false);
assert.equal(JSON.stringify(negative).includes('SECRET_INITIAL'), true, 'negative control must demonstrate initial-referrer exposure');
assert.equal(JSON.stringify(negative).includes('SECRET_QUERY'), true, 'negative control must demonstrate previous-SPA-URL exposure');
console.log(`OpenReplay ${version}: private navigation metadata PASS; negative control reproduced exposure.`);
