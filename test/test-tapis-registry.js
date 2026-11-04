'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TapisJobRegistry = require('../libs/tapisJobRegistry');
const TapisProvider = require('../libs/asr-providers/tapis');

const { STATES } = TapisJobRegistry;
const quietLogger = { warn: () => {}, info: () => {} };
const tmpFile = name => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clusterodx-registry-')), name);

(async () => {
    // Round trip, atomic write, permissions, no sensitive keys.
    const file = tmpFile('tapis-jobs.json');
    const registry = new TapisJobRegistry(file, { logger: quietLogger }).load();
    assert.strictEqual(registry.all().length, 0);

    registry.upsert({
        jobName: 'clusterodx-0-abc', taskId: 'task-1', state: STATES.SUBMITTING, owner: 'alice', ownerTenant: 'portals',
        token: 'header.payload.signature', submissionParams: { name: 'demo', tapisToken: 'x', webhook: 'https://c/commit' }
    });
    registry.upsert({ jobName: 'clusterodx-0-abc', tapisJobId: 'uuid-1', state: STATES.SUBMITTED });
    await registry.flush();

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(onDisk.length, 1);
    assert.strictEqual(onDisk[0].tapisJobId, 'uuid-1');
    assert.strictEqual(onDisk[0].state, STATES.SUBMITTED);
    assert.strictEqual(onDisk[0].taskId, 'task-1', 'upsert merges into the existing record');
    assert.ok(!('token' in onDisk[0]), 'tokens are never persisted');
    assert.ok(!('tapisToken' in onDisk[0].submissionParams), 'nested sensitive keys are stripped');
    assert.strictEqual(onDisk[0].submissionParams.webhook, 'https://c/commit');
    registry.upsert({ jobName: 'clusterodx-0-values', state: STATES.SUBMITTING,
        submissionParams: { webhook: 'https://c/commit?token=abc123', name: 'ok' },
        taskOptions: [{ name: 'sm-cluster', value: 'https://cluster.example' }, { name: 'odd', value: 'aaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.cccccc' }] });
    await registry.flush();
    const values = JSON.parse(fs.readFileSync(file, 'utf8')).find(r => r.jobName === 'clusterodx-0-values');
    assert.strictEqual(values.submissionParams.webhook, '[redacted]', 'token-bearing URL value is redacted');
    assert.strictEqual(values.submissionParams.name, 'ok');
    assert.strictEqual(values.taskOptions[0].value, 'https://cluster.example');
    assert.strictEqual(values.taskOptions[1].value, '[redacted]', 'JWT-shaped value is redacted');
    registry.remove('clusterodx-0-values');
    assert.ok(!fs.existsSync(`${file}.${process.pid}.tmp`), 'temp file is renamed away');
    if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'registry file is owner-only');
    }

    // Lookup by every identifier; state changes; prune keeps open records.
    assert.strictEqual(registry.get('uuid-1').jobName, 'clusterodx-0-abc');
    assert.strictEqual(registry.get('task-1').jobName, 'clusterodx-0-abc');
    assert.strictEqual(registry.get('missing'), null);
    registry.setState('uuid-1', STATES.DONE, { doneReason: 'cancelled' });
    assert.strictEqual(registry.get('uuid-1').state, STATES.DONE);
    registry.upsert({ jobName: 'clusterodx-0-open', state: STATES.SUBMITTED, tapisJobId: 'uuid-2' });
    assert.strictEqual(registry.prune(-1), 1, 'only the closed record is pruned');
    assert.strictEqual(registry.open().length, 1);
    await registry.flush();

    // Reload from disk and from a corrupt file.
    const reloaded = new TapisJobRegistry(file, { logger: quietLogger }).load();
    assert.strictEqual(reloaded.all().length, 1);
    assert.strictEqual(reloaded.get('uuid-2').state, STATES.SUBMITTED);

    const corrupt = tmpFile('corrupt.json');
    fs.writeFileSync(corrupt, '{not json');
    const warnings = [];
    const fromCorrupt = new TapisJobRegistry(corrupt, { logger: { warn: m => warnings.push(m), info: () => {} } }).load();
    assert.strictEqual(fromCorrupt.all().length, 0);
    assert.ok(warnings.some(w => w.includes('unreadable')), 'corrupt registry is reported, not fatal');

    // Serialised writes: many rapid upserts end in a consistent file.
    for (let i = 0; i < 25; i++) reloaded.upsert({ jobName: `clusterodx-0-bulk${i}`, state: STATES.SUBMITTING });
    await reloaded.flush();
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).length, 26);

    // Provider rehydration: pending and active records come back without tokens.
    const providerFile = tmpFile('provider-registry.json');
    const seed = new TapisJobRegistry(providerFile, { logger: quietLogger }).load();
    seed.upsert({ jobName: 'clusterodx-5-restored', taskId: 'task-restored', tapisJobId: 'uuid-restored', state: STATES.SUBMITTED,
        owner: 'bob', ownerTenant: 'portals', imagesCount: 5, pathImport: '/corral/webodm/media/project/1/task/x', taskOptions: [{ name: 'dsm', value: true }], submissionParams: { name: 'restored' } });
    seed.upsert({ jobName: 'clusterodx-7-registered', taskId: 'task-reg', tapisJobId: 'uuid-reg', state: STATES.REGISTERED, owner: 'bob', ownerTenant: 'portals' });
    seed.upsert({ jobName: 'clusterodx-0-never', taskId: 'task-never', state: STATES.SUBMITTING });
    seed.upsert({ jobName: 'clusterodx-0-finished', tapisJobId: 'uuid-done', state: STATES.DONE });
    await seed.flush();

    const provider = new TapisProvider({
        tapis: { baseUrl: 'https://example.tapis.io', tenantId: 'portals', registryPath: providerFile },
        app: { appId: 'nodeodx-ls6', appVersion: '1.0.18' },
        system: { executionSystemId: 'ls6', archiveSystemId: 'ls6' },
        imageSizeMapping: [{ maxImages: 100, nodeCount: 1, logicalQueue: 'vm-small' }]
    });
    await provider.initialize();

    const restored = provider.findPendingTask('uuid-restored');
    assert.ok(restored, 'submitted job is pending again');
    assert.strictEqual(restored.taskId, 'task-restored');
    assert.strictEqual(restored.token, null);
    assert.strictEqual(restored.pathImport, '/corral/webodm/media/project/1/task/x');
    assert.deepStrictEqual(restored.taskOptions, [{ name: 'dsm', value: true }]);
    assert.strictEqual(provider.findPendingTask('task-restored'), restored);
    assert.strictEqual(provider.findPendingTask('clusterodx-5-restored'), restored);
    assert.strictEqual(provider.findPendingTaskByUser({ username: 'bob', tenantId: 'portals' }).count, 1);
    assert.ok(provider.activeJobs.has('uuid-reg'), 'registered job is active');
    assert.strictEqual(provider.findPendingTask('uuid-reg'), null, 'registered job is not pending');
    assert.ok(!provider.activeJobs.has('uuid-done'));
    assert.strictEqual(provider.findPendingTask('task-never'), null, 'never-accepted job has nothing to restore');

    // Without a token a restored job cannot be cancelled; it is marked for the operator.
    assert.strictEqual(await provider.cancelPendingTask('task-restored'), true);
    assert.strictEqual(provider.findPendingTask('task-restored'), null);
    await provider.registry.flush();
    assert.strictEqual(provider.registry.get('uuid-restored').state, STATES.UNREACHABLE);

    // Adopting the worker's bearer makes the registered job cancellable.
    provider.adoptToken('uuid-reg', 'header.payload.sig');
    assert.strictEqual(provider.activeJobs.get('uuid-reg').token, 'header.payload.sig');
    provider.markRegistered('uuid-reg', { hostname: () => 'ls6', port: () => 3001 });
    await provider.registry.flush();
    assert.deepStrictEqual(provider.registry.get('uuid-reg').node, { hostname: 'ls6', port: 3001 });

    console.log('TAPIS REGISTRY TEST PASSED');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
