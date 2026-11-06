'use strict';

// Checkpoint helpers on the provider and in libs/tapisCheckpoint.js: scratch-root
// allow list, owner check, manifest path safety, the env a resume job receives.
const assert = require('assert');
const TapisProvider = require('../libs/asr-providers/tapis');
const checkpoint = require('../libs/tapisCheckpoint');

const makeToken = (username, tenant = 'portals') => {
    const payload = Buffer.from(JSON.stringify({
        'tapis/username': username,
        'tapis/tenant_id': tenant,
        exp: Math.floor(Date.now() / 1000) + 3600
    })).toString('base64url');
    return `header.${payload}.signature`;
};

const UUID = '9ef37fe9-807c-45da-9276-63dc6ee96ab1';
const AS_UUID = 'c0a8cbb3-0f4c-4c52-9a6f-3f2d4a8e1b77';

const provider = new TapisProvider({
    tapis: { checkpointScratchRoots: ['/scratch/06659/wmobley', '/work/06659/wmobley'] }
});

assert.strictEqual(provider.isAllowedScratchResumePath('/scratch/06659/wmobley/tapis/job/runtime/data/task'), true);
assert.strictEqual(provider.isAllowedScratchResumePath('/scratch/06659/wmobley2/tapis/job/runtime/data/task'), false);
assert.strictEqual(provider.isAllowedScratchResumePath('/corral/webodm/media/.nodeodm-checkpoints/task'), false);
assert.strictEqual(provider.isAllowedScratchResumePath('relative/path'), false);

// Owner check: matching user and tenant pass, a different user or tenant is refused,
// a recorded owner with an unreadable token fails closed, no recorded owner is not checked here.
provider.assertCheckpointOwner({ uuid: 'task', tapisJobOwner: 'wmobley' }, makeToken('wmobley'));
provider.assertCheckpointOwner({ uuid: 'task', tapisJobOwner: 'wmobley@portals' }, makeToken('wmobley'));
provider.assertCheckpointOwner({ uuid: 'task' }, 'not-a-jwt');
assert.throws(() => provider.assertCheckpointOwner({ uuid: 'task', tapisJobOwner: 'otheruser' }, makeToken('wmobley')), /belongs to otheruser/);
assert.throws(() => provider.assertCheckpointOwner({ uuid: 'task', tapisJobOwner: 'wmobley@other' }, makeToken('wmobley')), /not_owner/);
assert.throws(() => provider.assertCheckpointOwner({ uuid: 'task', tapisJobOwner: 'wmobley' }, 'not-a-jwt'), /not_owner/);

// Config defaults.
const defaults = new TapisProvider({});
assert.strictEqual(defaults.isResumeEnabled(), false);
assert.strictEqual(defaults.getResumeSyncTimeoutMs(), 600000);
assert.strictEqual(defaults.getCheckpointRoot(), '/corral/webodm/media/.nodeodm-checkpoints');
assert.strictEqual(defaults.getCheckpointNodeRoot(), '/corral/utexas/BCS26030/webodm/media/.nodeodm-checkpoints');

// Task ids become path segments; anything but a uuid is refused.
assert.throws(() => checkpoint.manifestPath('/root', '../etc'), /Invalid task UUID/);
assert.strictEqual(checkpoint.manifestPath('/root', UUID), `/root/${UUID}/manifest.json`);

// Env set: always the base set; AS_UUID only with a new version; cold start off.
const base = { taskId: UUID, options: [{ name: 'dsm', value: true }], nodeRoot: '/node/root', intervalSeconds: 900, retentionSeconds: 604800, allowedRoots: ['/scratch', '/work'] };
const keys = env => env.map(item => item.key);
const replace = checkpoint.buildResumeEnv(base);
assert.deepStrictEqual(keys(replace), [
    'NODEODM_CHECKPOINT_ROOT', 'NODEODM_CHECKPOINT_INTERVAL_SECONDS', 'NODEODM_CHECKPOINT_RETENTION_SECONDS',
    'NODEODM_RESUME_TASK_UUID', 'NODEODM_RESUME_CHECKPOINT_PATH', 'NODEODM_RESUME_OPTIONS_JSON',
    'NODEODM_RESUME_ALLOW_COLD_START', 'NODEODM_RESUME_ALLOWED_ROOTS']);
assert.strictEqual(replace.find(item => item.key === 'NODEODM_RESUME_ALLOW_COLD_START').value, '0');
assert.strictEqual(replace.find(item => item.key === 'NODEODM_RESUME_CHECKPOINT_PATH').value, `/node/root/${UUID}`);
const versioned = checkpoint.buildResumeEnv(Object.assign({}, base, { newUuid: AS_UUID, importPath: '/node/images' }));
assert.strictEqual(versioned.find(item => item.key === 'NODEODM_RESUME_AS_UUID').value, AS_UUID);
assert.strictEqual(versioned.find(item => item.key === 'NODEODM_RESUME_IMPORT_PATH').value, '/node/images');

console.log('TAPIS CHECKPOINT RESUME TEST PASSED');
