'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../libs/logger');
const TapisProvider = require('../libs/asr-providers/tapis');
const TapisJobRegistry = require('../libs/tapisJobRegistry');

const { STATES } = TapisJobRegistry;
const HOUR = 3600 * 1000;
const makeJwt = (username, tenant = 'portals', ttlSeconds = 3600) => {
    const payload = Buffer.from(JSON.stringify({ 'tapis/username': username, 'tapis/tenant_id': tenant, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
    return `header.${payload}.signature`;
};
const httpError = status => { const e = new Error(`Request failed with status code ${status}`); e.response = { status, data: {} }; return e; };

const fakeNode = (tapisJobId, { online = true, queue = 0, lastRefreshed = Date.now() } = {}) => ({
    tapisJobId, transients: 0,
    getTapisJobId: () => tapisJobId,
    isOnline: () => online,
    getInfoProperty: (key, fallback) => key === 'taskQueueCount' ? queue : fallback,
    getLastRefreshed: () => lastRefreshed,
    toString: () => `node-${tapisJobId}`
});

const makeProvider = async (extra = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clusterodx-vacuum-'));
    const provider = new TapisProvider({
        tapis: Object.assign({ baseUrl: 'https://example.tapis.io', tenantId: 'portals', registryPath: path.join(dir, 'registry.json'), vacuumIntervalSeconds: 0 }, extra.tapis || {}),
        app: { appId: 'nodeodx-ls6', appVersion: '1.0.18' },
        system: { executionSystemId: 'ls6', archiveSystemId: 'ls6' },
        maxUploadTime: 3600,
        worker: extra.worker || {},
        imageSizeMapping: [{ maxImages: 100, nodeCount: 1, logicalQueue: 'vm-small' }]
    });
    await provider.initialize();
    return provider;
};

(async () => {
    const messages = [];
    const errors = [];
    const original = { info: logger.info, warn: logger.warn, error: logger.error };
    logger.info = m => messages.push(String(m));
    logger.warn = m => messages.push(String(m));
    logger.error = m => { errors.push(String(m)); messages.push(String(m)); };
    const token = makeJwt('alice');

    try {
        const provider = await makeProvider();
        const tapisJobs = new Map(); // uuid -> job object returned by GET
        const cancels = [];
        provider.createApiClient = () => ({
            get: async url => {
                const uuid = decodeURIComponent(url.split('/').pop());
                if (!tapisJobs.has(uuid)) throw httpError(404);
                return { data: { result: tapisJobs.get(uuid) } };
            },
            post: async url => { cancels.push(url); return { status: 200 }; }
        });
        const nodeList = [];
        const routes = new Map();
        const removed = [];
        const deps = {
            nodes: { find: fn => nodeList.find(fn), remove: n => { nodeList.splice(nodeList.indexOf(n), 1); } },
            routetable: { findByNode: async n => routes.get(n) || {}, removeByNode: async () => {} },
            removeAndCleanupNode: async node => { removed.push(node.tapisJobId); nodeList.splice(nodeList.indexOf(node), 1); return true; }
        };
        const seed = (jobName, uuid, state, fields = {}, withToken = true) => {
            provider.registry.upsert(Object.assign({ jobName, tapisJobId: uuid, taskId: `task-${jobName}`, state, owner: 'alice', ownerTenant: 'portals', queue: 'vm-small', submittedAt: Date.now() }, fields));
            if (uuid && withToken) provider.activeJobs.set(uuid, { jobId: jobName, token, status: 'SUBMITTING' });
        };
        const stateOf = name => provider.registry.get(name).state;

        // a. queued within the allowed wait: untouched.
        seed('clusterodx-0-queued', 'u-queued', STATES.SUBMITTED); tapisJobs.set('u-queued', { status: 'QUEUED' });
        // b. queued far too long: cancelled.
        seed('clusterodx-0-stale', 'u-stale', STATES.SUBMITTED, { submittedAt: Date.now() - 10 * HOUR }); tapisJobs.set('u-stale', { status: 'QUEUED' });
        // c. running, first seen now: only recorded.
        seed('clusterodx-0-running', 'u-running', STATES.SUBMITTED); tapisJobs.set('u-running', { status: 'RUNNING' });
        // c2. running for an hour without registering: cancelled.
        seed('clusterodx-0-ghost', 'u-ghost', STATES.SUBMITTED, { runningSeenAt: Date.now() - HOUR }); tapisJobs.set('u-ghost', { status: 'RUNNING' });
        // d. registered, node online and idle for two hours: removed only after three ticks.
        seed('clusterodx-0-idle', 'u-idle', STATES.REGISTERED, { idleSince: Date.now() - 2 * HOUR }); tapisJobs.set('u-idle', { status: 'RUNNING' });
        nodeList.push(fakeNode('u-idle'));
        // e. registered and busy (has a route): ticks reset.
        seed('clusterodx-0-busy', 'u-busy', STATES.REGISTERED, { idleTicks: 2, idleSince: Date.now() - 2 * HOUR }); tapisJobs.set('u-busy', { status: 'RUNNING' });
        const busyNode = fakeNode('u-busy'); nodeList.push(busyNode); routes.set(busyNode, { 'task-x': {} });
        // f. registered but node vanished: cancelled.
        seed('clusterodx-0-gone', 'u-gone', STATES.REGISTERED); tapisJobs.set('u-gone', { status: 'RUNNING' });
        // g. no token, old: operator error line, unreachable.
        seed('clusterodx-0-notoken', 'u-notoken', STATES.SUBMITTED, { submittedAt: Date.now() - 10 * HOUR }, false); tapisJobs.set('u-notoken', { status: 'QUEUED' });
        // h. token expired: unreachable.
        seed('clusterodx-0-expired', 'u-expired', STATES.SUBMITTED, { bearerExpiresAt: Date.now() - 1000 }); tapisJobs.set('u-expired', { status: 'QUEUED' });
        // i. earlier cancel failed: retried and closed.
        seed('clusterodx-0-retry', 'u-retry', STATES.CANCEL_FAILED); tapisJobs.set('u-retry', { status: 'RUNNING' });
        // j. finished on the Tapis side: closed, node dropped.
        seed('clusterodx-0-finished', 'u-finished', STATES.REGISTERED); tapisJobs.set('u-finished', { status: 'FINISHED' });
        nodeList.push(fakeNode('u-finished'));
        // k. never confirmed and ancient: closed.
        seed('clusterodx-0-never', null, STATES.SUBMITTING, { submittedAt: Date.now() - 10 * HOUR });
        // l. closed long ago: pruned.
        provider.registry.upsert({ jobName: 'clusterodx-0-old', state: STATES.DONE, updatedAt: Date.now() - 30 * 24 * HOUR, createdAt: Date.now() - 30 * 24 * HOUR });
        provider.registry.records.get('clusterodx-0-old').updatedAt = Date.now() - 30 * 24 * HOUR;

        let result = await provider.vacuum(deps);
        await provider.registry.flush();
        assert.strictEqual(result.dryRun, false);
        assert.strictEqual(stateOf('clusterodx-0-queued'), STATES.SUBMITTED, 'queued within wait is untouched');
        assert.strictEqual(stateOf('clusterodx-0-stale'), STATES.DONE, 'queued too long is cancelled');
        assert.ok(cancels.includes('/v3/jobs/u-stale/cancel'));
        assert.strictEqual(stateOf('clusterodx-0-running'), STATES.SUBMITTED);
        assert.ok(provider.registry.get('clusterodx-0-running').runningSeenAt, 'first RUNNING observation is recorded');
        assert.ok(!cancels.includes('/v3/jobs/u-running/cancel'), 'freshly running job gets its grace period');
        assert.strictEqual(stateOf('clusterodx-0-ghost'), STATES.DONE, 'running without registration past grace is cancelled');
        assert.strictEqual(provider.registry.get('clusterodx-0-idle').idleTicks, 1);
        assert.ok(!removed.includes('u-idle'), 'one idle tick is not enough');
        assert.strictEqual(provider.registry.get('clusterodx-0-busy').idleTicks, 0, 'busy node resets idle ticks');
        assert.strictEqual(stateOf('clusterodx-0-gone'), STATES.DONE);
        assert.ok(cancels.includes('/v3/jobs/u-gone/cancel'));
        assert.strictEqual(stateOf('clusterodx-0-notoken'), STATES.UNREACHABLE);
        assert.strictEqual(stateOf('clusterodx-0-expired'), STATES.UNREACHABLE);
        assert.strictEqual(errors.filter(e => e.includes('orphan requires operator action')).length, 2);
        assert.ok(errors.every(e => e.includes('"user":"alice@portals"')));
        assert.strictEqual(stateOf('clusterodx-0-retry'), STATES.DONE);
        assert.ok(cancels.includes('/v3/jobs/u-retry/cancel'));
        assert.strictEqual(stateOf('clusterodx-0-finished'), STATES.DONE);
        assert.ok(!nodeList.some(n => n.tapisJobId === 'u-finished'), 'finished job node is dropped');
        assert.ok(!cancels.includes('/v3/jobs/u-finished/cancel'), 'finished job is not cancelled');
        assert.strictEqual(stateOf('clusterodx-0-never'), STATES.DONE);
        assert.strictEqual(provider.registry.get('clusterodx-0-old'), null, 'old closed record pruned');

        // Two more ticks: the idle worker goes; unreachable is logged once only.
        await provider.vacuum(deps);
        await provider.vacuum(deps);
        await provider.registry.flush();
        assert.ok(removed.includes('u-idle'), 'idle worker removed after three ticks past maxUploadTime');
        assert.strictEqual(errors.filter(e => e.includes('orphan requires operator action')).length, 2, 'operator line is emitted once per orphan');

        // Dry run: logs intentions, touches nothing.
        const dry = await makeProvider({ tapis: { vacuumDryRun: true } });
        dry.createApiClient = provider.createApiClient;
        dry.registry.upsert({ jobName: 'clusterodx-0-dry', tapisJobId: 'u-dry', state: STATES.SUBMITTED, owner: 'alice', ownerTenant: 'portals', queue: 'vm-small', submittedAt: Date.now() - 10 * HOUR });
        dry.activeJobs.set('u-dry', { token });
        tapisJobs.set('u-dry', { status: 'QUEUED' });
        const before = cancels.length;
        result = await dry.vacuum(deps);
        assert.strictEqual(result.dryRun, true);
        assert.strictEqual(result.actions.length, 1);
        assert.strictEqual(cancels.length, before, 'dry run issues no cancel');
        assert.ok(messages.some(m => m.includes('vacuum would cancel job queued too long')));
        assert.strictEqual(dry.registry.get('clusterodx-0-dry').state, STATES.SUBMITTED);

        // Unknown-job cancellation: flag off, verification, rate limiting.
        const identity = { username: 'alice', tenantId: 'portals' };
        tapisJobs.set('u-unknown', { uuid: 'u-unknown', name: 'clusterodx-0-xyz', owner: 'alice', appId: 'nodeodx-ls6', appVersion: '1.0.18', status: 'RUNNING' });
        let off = await provider.cancelUnknownJob(token, identity, 'u-unknown');
        assert.deepStrictEqual(off, { handled: false, reason: 'disabled' });

        const on = await makeProvider({ worker: { cancelUnknownJobs: true } });
        on.createApiClient = provider.createApiClient;
        const cancelsBefore = cancels.length;
        let r = await on.cancelUnknownJob(token, identity, 'u-unknown');
        assert.strictEqual(r.handled, true);
        assert.strictEqual(cancels.length, cancelsBefore + 1);
        await on.registry.flush();
        assert.strictEqual(on.registry.get('u-unknown').state, STATES.DONE);
        r = await on.cancelUnknownJob(token, identity, 'u-unknown');
        assert.strictEqual(r.handled, true, 'repeat registration is still answered 410');
        assert.strictEqual(cancels.length, cancelsBefore + 1, 'but no second cancel is sent');

        tapisJobs.set('u-foreign', { name: 'clusterodx-0-f', owner: 'bob', appId: 'nodeodx-ls6', status: 'RUNNING' });
        r = await on.cancelUnknownJob(token, identity, 'u-foreign');
        assert.strictEqual(r.handled, false, 'another owner\'s job is never cancelled');
        tapisJobs.set('u-otherapp', { name: 'clusterodx-0-o', owner: 'alice', appId: 'something-else', status: 'RUNNING' });
        assert.strictEqual((await on.cancelUnknownJob(token, identity, 'u-otherapp')).handled, false);
        tapisJobs.set('u-notours', { name: 'my-own-job', owner: 'alice', appId: 'nodeodx-ls6', status: 'RUNNING' });
        assert.strictEqual((await on.cancelUnknownJob(token, identity, 'u-notours')).handled, false, 'non clusterodx names are left alone');
        tapisJobs.set('u-finished2', { name: 'clusterodx-0-d', owner: 'alice', appId: 'nodeodx-ls6', status: 'FINISHED' });
        assert.strictEqual((await on.cancelUnknownJob(token, identity, 'u-finished2')).handled, false, 'terminal jobs are left alone');
        assert.strictEqual((await on.cancelUnknownJob(token, identity, 'u-missing')).handled, false);
        on.registry.upsert({ jobName: 'clusterodx-0-inflight', tapisJobId: 'u-inflight', state: STATES.SUBMITTED });
        assert.strictEqual((await on.cancelUnknownJob(token, identity, 'u-inflight')).reason, 'job is being submitted or reconciled');
        assert.strictEqual(cancels.length, cancelsBefore + 1, 'none of the rejected cases sent a cancel');

        for (let i = 0; i < 12; i++) tapisJobs.set(`u-flood${i}`, { name: `clusterodx-0-f${i}`, owner: 'alice', appId: 'nodeodx-ls6', status: 'RUNNING' });
        const results = [];
        for (let i = 0; i < 12; i++) results.push(await on.cancelUnknownJob(token, identity, `u-flood${i}`));
        assert.strictEqual(results.filter(x => x.reason === 'rate limited').length, 3, 'per-owner limit of 10 per minute (one used above)');

        // Instance tag.
        const tagged = await makeProvider({ tapis: { instanceId: 'prod1' }, worker: { cancelUnknownJobs: true } });
        assert.match(tagged.generateHostname(7), /^clusterodx-7-prod1-/);
        assert.ok(tagged.jobNameBelongsHere('clusterodx-7-prod1-abc'));
        assert.ok(!tagged.jobNameBelongsHere('clusterodx-7-dev-abc'));
        assert.ok(!tagged.jobNameBelongsHere('clusterodx-7-abc'));

        // QA fixes.
        // Adopting a fresh bearer refreshes the expiry and revives an unreachable record.
        const fix = await makeProvider();
        fix.createApiClient = provider.createApiClient;
        fix.registry.upsert({ jobName: 'clusterodx-0-revive', tapisJobId: 'u-revive', taskId: 'task-revive', state: STATES.UNREACHABLE, owner: 'alice', ownerTenant: 'portals', queue: 'vm-small', bearerExpiresAt: Date.now() - HOUR });
        fix.activeJobs.set('u-revive', { jobId: 'clusterodx-0-revive', token: null });
        fix.adoptToken('u-revive', makeJwt('alice'));
        assert.strictEqual(fix.registry.get('u-revive').state, STATES.SUBMITTED);
        assert.ok(fix.registry.get('u-revive').bearerExpiresAt > Date.now(), 'expiry follows the adopted token');
        assert.strictEqual(typeof fix.activeJobs.get('u-revive').token, 'string', 'adopted token is held in memory');

        // A record whose handoff is in progress is left alone even if it looks orphaned.
        fix.registry.upsert({ jobName: 'clusterodx-0-claimed', tapisJobId: 'u-claimed', taskId: 'task-claimed', state: STATES.SUBMITTED, owner: 'alice', ownerTenant: 'portals', queue: 'vm-small', submittedAt: Date.now() - 2 * HOUR, runningSeenAt: Date.now() - HOUR });
        fix.activeJobs.set('u-claimed', { token });
        fix.pendingTasks.set('u-claimed', { tapisJobId: 'u-claimed', taskId: 'task-claimed', token, registrationClaimed: true });
        tapisJobs.set('u-claimed', { status: 'RUNNING' });
        // No status from Tapis: no decision.
        fix.registry.upsert({ jobName: 'clusterodx-0-nostatus', tapisJobId: 'u-nostatus', state: STATES.SUBMITTED, owner: 'alice', ownerTenant: 'portals', queue: 'vm-small', submittedAt: Date.now() - 10 * HOUR });
        fix.activeJobs.set('u-nostatus', { token });
        tapisJobs.set('u-nostatus', {});
        // Repeatedly unauthorized cancel: give up and alert the operator.
        fix.registry.upsert({ jobName: 'clusterodx-0-denied', tapisJobId: 'u-denied', state: STATES.CANCEL_FAILED, owner: 'alice', ownerTenant: 'portals', queue: 'normal', unauthorizedCount: 3 });
        fix.activeJobs.set('u-denied', { token });
        const cancelsBeforeFix = cancels.length;
        const errorsBeforeFix = errors.length;
        await fix.vacuum(deps);
        await fix.registry.flush();
        assert.strictEqual(fix.registry.get('u-claimed').state, STATES.SUBMITTED, 'claimed record untouched');
        assert.ok(!cancels.includes('/v3/jobs/u-claimed/cancel'));
        assert.strictEqual(fix.registry.get('u-nostatus').state, STATES.SUBMITTED, 'empty status is not treated as running');
        assert.ok(!fix.registry.get('u-nostatus').runningSeenAt);
        assert.ok(!cancels.includes('/v3/jobs/u-nostatus/cancel'));
        assert.strictEqual(fix.registry.get('u-denied').state, STATES.UNREACHABLE);
        assert.ok(!cancels.includes('/v3/jobs/u-denied/cancel'), 'no further cancel after repeated 401/403');
        assert.strictEqual(cancels.length, cancelsBeforeFix);
        assert.strictEqual(errors.length - errorsBeforeFix, 1);
        assert.ok(errors[errors.length - 1].includes('"queue":"normal"'));

        // Teardown without a token produces the operator line with owner and queue.
        fix.registry.upsert({ jobName: 'clusterodx-0-lostnode', tapisJobId: 'u-lostnode', state: STATES.REGISTERED, owner: 'carol', ownerTenant: 'portals', queue: 'vm-small' });
        assert.strictEqual(await fix.destroyNode({ getTapisJobId: () => 'u-lostnode', toString: () => 'n' }), false);
        const operatorLine = errors[errors.length - 1];
        assert.ok(operatorLine.includes('orphan requires operator action') && operatorLine.includes('"user":"carol@portals"') && operatorLine.includes('"queue":"vm-small"'));
        assert.strictEqual(fix.registry.get('u-lostnode').state, STATES.UNREACHABLE);
        // Unauthorized outcomes are counted on the record.
        fix.createApiClient = () => ({ post: async () => { throw httpError(403); }, get: provider.createApiClient().get });
        fix.registry.upsert({ jobName: 'clusterodx-0-count', tapisJobId: 'u-count', state: STATES.REGISTERED, owner: 'alice', ownerTenant: 'portals' });
        fix.activeJobs.set('u-count', { token });
        await fix.destroyNode({ getTapisJobId: () => 'u-count', toString: () => 'n' });
        await fix.destroyNode({ getTapisJobId: () => 'u-count', toString: () => 'n' });
        assert.strictEqual(fix.registry.get('u-count').unauthorizedCount, 2);
        assert.strictEqual(fix.registry.get('u-count').state, STATES.CANCEL_FAILED);

        assert.ok(messages.every(m => !m.includes(token)), 'no log line contains the token');
    } finally {
        Object.assign(logger, original);
    }
    console.log('TAPIS VACUUM TEST PASSED');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
