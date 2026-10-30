'use strict';
// The NodeSplat profile can live in its own file (--splat-config), like --asr.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-config-'));
const probe = path.join(dir, 'probe.js');
fs.writeFileSync(probe, `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(root, 'config'))}).splat));`);
const run = (...args) => spawnSync(process.execPath, [probe, ...args], {cwd: root, encoding: 'utf8'});

const file = path.join(dir, 'splat-config.json');
fs.writeFileSync(file, JSON.stringify({enabled: true, instanceId: 'from-file', profile: {appId: 'nodesplat-ls6'}}));

// Default: disabled, no file needed
let result = run();
assert.strictEqual(result.status, 0, result.stderr);
assert.strictEqual(JSON.parse(result.stdout).enabled, false);

// File is loaded and merged over defaults
result = run('--splat-config', file);
assert.strictEqual(result.status, 0, result.stderr);
let splat = JSON.parse(result.stdout);
assert.strictEqual(splat.enabled, true);
assert.strictEqual(splat.instanceId, 'from-file');
assert.strictEqual(splat.profile.appId, 'nodesplat-ls6');
assert.strictEqual(splat.maxConcurrentRuns, 1, 'defaults still apply');

// File wins over an inline block in --config; inline still works alone
const inline = path.join(dir, 'inline.json');
fs.writeFileSync(inline, JSON.stringify({splat: {enabled: false, instanceId: 'inline', maxConcurrentRuns: 1}}));
splat = JSON.parse(run('--config', inline).stdout);
assert.strictEqual(splat.instanceId, 'inline');
splat = JSON.parse(run('--config', inline, '--splat-config', file).stdout);
assert.strictEqual(splat.instanceId, 'from-file');

// A named but missing/invalid file stops startup instead of silently disabling NodeSplat
result = run('--splat-config', path.join(dir, 'missing.json'));
assert.strictEqual(result.status, 1);
fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
assert.strictEqual(run('--splat-config', path.join(dir, 'bad.json')).status, 1);

console.log('NodeSplat config file tests passed');
