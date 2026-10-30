'use strict';
// Splat shared-storage roots default from the NodeODX node_shared_path_mappings; explicit values win.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {SplatTasks, resolveRoots} = require('../libs/splatTasks');

const mappings = {'*': {'/corral/webodm/media': '/corral/utexas/BCS26030/webodm/media'}};

// Derived from the mapping, with no paths configured
assert.deepStrictEqual(resolveRoots({}, mappings), {
    inputRoot: '/corral/webodm/media/splats/staging',
    outputRoot: '/corral/webodm/media/splats/output',
    workerInputRoot: '/corral/utexas/BCS26030/webodm/media/splats/staging',
    workerOutputRoot: '/corral/utexas/BCS26030/webodm/media/splats/output'});

// Explicit values win; a worker root is translated when only the cluster-side root is given
const partial = resolveRoots({inputRoot: '/corral/webodm/media/custom/in', outputRoot: '/elsewhere/out'}, mappings);
assert.strictEqual(partial.workerInputRoot, '/corral/utexas/BCS26030/webodm/media/custom/in');
assert.strictEqual(partial.workerOutputRoot, '/elsewhere/out', 'outside the mapped tree: same view');
assert.strictEqual(resolveRoots({workerInputRoot: '/ls6/in'}, mappings).workerInputRoot, '/ls6/in');
// A look-alike prefix is not inside the mapped tree
assert.strictEqual(resolveRoots({inputRoot: '/corral/webodm/media-evil/in'}, mappings).workerInputRoot, '/corral/webodm/media-evil/in');

// No mapping and nothing configured: nothing to derive
assert.strictEqual(resolveRoots({}, {}).inputRoot, undefined);

// An enabled service needs no root keys when the mapping exists, and fails closed when it cannot derive them
const profile = {baseUrl: 'https://x.invalid', tenantId: 'portals', appId: 'a', appVersion: '1', executionSystemId: 'ls6',
    archiveSystemId: 'cloud.data', queue: 'q', allocation: 'A', coresPerNode: 1, memoryMB: 1, maxMinutes: 10,
    callbackUrl: 'https://c.invalid', workerBindHost: '0.0.0.0', workerPort: 3101};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-roots-'));
const service = new SplatTasks({enabled: true, instanceId: 'i', storeDir: path.join(dir, 'a'), profile}, {sharedPathMappings: mappings});
assert.strictEqual(service.profile.outputRoot, '/corral/webodm/media/splats/output');
assert.strictEqual(service.profile.workerOutputRoot, '/corral/utexas/BCS26030/webodm/media/splats/output');
const env = Object.fromEntries(service.buildJob({run_id: 'r', uuid: 'u', profile_id: 'p', lease_expires_at: Date.now() + 1000, job_name: 'j'}, 'tok')
    .parameterSet.envVariables.map(e => [e.key, e.value]));
assert.strictEqual(env.NODESPLAT_INPUT_ROOT, '/corral/utexas/BCS26030/webodm/media/splats/staging');
assert.strictEqual(env.NODESPLAT_OUTPUT_ROOT, '/corral/utexas/BCS26030/webodm/media/splats/output');
service.close();
assert.throws(() => new SplatTasks({enabled: true, instanceId: 'i', storeDir: path.join(dir, 'b'), profile}, {sharedPathMappings: {}}), /Incomplete/);

console.log('NodeSplat shared-root derivation tests passed');
