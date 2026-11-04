'use strict';

// A WebODM user's Tapis token lives about an hour; a job can sit in a Slurm queue far
// longer. Every authenticated request WebODM makes for a task carries the owner's current
// token. The provider must adopt a newer owner token so cancel and the vacuum keep
// working, and must never adopt a stranger's token or an older/expired one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../libs/logger');
const TapisProvider = require('../libs/asr-providers/tapis');

const makeJwt = (username, expiresInSeconds, tenant = 'portals') => {
    const payload = Buffer.from(JSON.stringify({
        'tapis/username': username,
        'tapis/tenant_id': tenant,
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds
    })).toString('base64url');
    return `header.${payload}.signature`;
};

(async () => {
    const registryPath = path.join(os.tmpdir(), `clusterodx-token-refresh-registry-${process.pid}.json`);
    const messages = [];
    const originalInfo = logger.info;
    const originalWarn = logger.warn;
    logger.info = message => messages.push(String(message));
    logger.warn = message => messages.push(String(message));

    try {
        const provider = new TapisProvider({
            tapis: { baseUrl: 'https://example.tapis.io', tenantId: 'portals', registryPath },
            app: { appId: 'nodeodx-ls6', appVersion: '1.0.18' },
            system: { executionSystemId: 'ls6', archiveSystemId: 'ls6' },
            imageSizeMapping: [{ maxImages: 100, nodeCount: 1, logicalQueue: 'vm-small' }]
        });
        await provider.initialize();

        const oldToken = makeJwt('alice', 300);
        const seed = (taskId, tapisJobId, token = oldToken) => {
            const pending = { taskId, jobId: `clusterodx-0-${taskId}`, tapisJobId, token, tapisJobOwner: 'alice', tapisJobOwnerTenant: 'portals' };
            provider.pendingTasks.set(taskId, pending);
            provider.pendingTasks.set(pending.jobId, pending);
            provider.pendingTasks.set(tapisJobId, pending);
            provider.activeJobs.set(tapisJobId, { tapisJobId, token, tapisJobOwner: 'alice', tapisJobOwnerTenant: 'portals' });
            provider.recordUpsert({ jobName: pending.jobId, tapisJobId, taskId, owner: 'alice', ownerTenant: 'portals', state: 'unreachable', reason: 'token expired' });
            return pending;
        };

        // Rejected: someone else's token, an older token, an expired token, garbage.
        const pending = seed('task-a', 'tapis-a');
        assert.strictEqual(provider.refreshOwnerToken('task-a', makeJwt('mallory', 7200)), false, 'another user cannot hand in a token');
        assert.strictEqual(provider.refreshOwnerToken('task-a', makeJwt('alice', 60)), false, 'an older token is ignored');
        assert.strictEqual(provider.refreshOwnerToken('task-a', makeJwt('alice', -60)), false, 'an expired token is ignored');
        assert.strictEqual(provider.refreshOwnerToken('task-a', 'not-a-jwt'), false);
        assert.strictEqual(provider.refreshOwnerToken('unknown-task', makeJwt('alice', 7200)), false);
        assert.strictEqual(pending.token, oldToken, 'rejected tokens leave the stored token alone');
        assert.strictEqual(provider.registry.get('tapis-a').state, 'unreachable');

        // Adopted: the owner's newer token, looked up by task id or by Tapis job id.
        const newer = makeJwt('alice', 7200);
        assert.strictEqual(provider.refreshOwnerToken('task-a', newer), true);
        assert.strictEqual(pending.token, newer, 'pending task carries the newer token');
        assert.strictEqual(provider.activeJobs.get('tapis-a').token, newer, 'active job carries the newer token');
        const record = provider.registry.get('tapis-a');
        assert.strictEqual(record.state, 'submitted', 'an unreachable job becomes reachable again');
        assert.strictEqual(record.unauthorizedCount, 0);
        assert.ok(record.bearerExpiresAt > Date.now() + 3600 * 1000, 'registry records the new expiry');
        assert.strictEqual(provider.refreshOwnerToken('tapis-a', newer), false, 'the same token is not adopted twice');
        assert.strictEqual(provider.tokenFor('tapis-a'), newer);

        // cancelPendingTask uses the token on the cancelling request, not the stale one.
        const used = [];
        provider.cancelJob = async (token, tapisJobId) => { used.push([token, tapisJobId]); return { outcome: 'cancelled', status: 200 }; };
        seed('task-b', 'tapis-b');
        const freshest = makeJwt('alice', 9000);
        assert.strictEqual(await provider.cancelPendingTask('task-b', freshest), true);
        assert.deepStrictEqual(used, [[freshest, 'tapis-b']], 'the cancel goes out with the request token');
        assert.strictEqual(provider.findPendingTask('task-b'), null);

        // A stranger's token on the cancel request falls back to the stored owner token.
        seed('task-c', 'tapis-c');
        await provider.cancelPendingTask('task-c', makeJwt('mallory', 9000));
        assert.deepStrictEqual(used[used.length - 1], [oldToken, 'tapis-c']);

        // destroyMachine forwards the request token the same way.
        seed('task-d', 'tapis-d');
        const viaMachine = makeJwt('alice', 9000);
        await provider.destroyMachine('task-d', viaMachine);
        assert.deepStrictEqual(used[used.length - 1], [viaMachine, 'tapis-d']);

        // Adoption restores the state the job had when its token ran out, so the vacuum
        // neither cancels a live worker as "never registered" nor forgets a pending cancel.
        for (const [from, expected] of [['registered', 'registered'], ['cancelFailed', 'cancelFailed'], ['submitted', 'submitted']]) {
            const taskId = `task-${from}`;
            const tapisJobId = `tapis-${from}`;
            seed(taskId, tapisJobId);
            provider.recordUpsert({ jobName: `clusterodx-0-${taskId}`, state: from });
            provider.markUnreachable(tapisJobId, 'token expired');
            assert.strictEqual(provider.registry.get(tapisJobId).state, 'unreachable');
            assert.strictEqual(provider.refreshOwnerToken(taskId, makeJwt('alice', 7200)), true);
            assert.strictEqual(provider.registry.get(tapisJobId).state, expected, `unreachable ${from} job returns to ${expected}`);
        }
        // Records marked unreachable before unreachableFrom existed fall back to submitted.
        seed('task-legacy', 'tapis-legacy');
        provider.recordUpsert({ jobName: 'clusterodx-0-task-legacy', state: 'unreachable', unreachableFrom: undefined });
        assert.strictEqual(provider.refreshOwnerToken('task-legacy', makeJwt('alice', 7200)), true);
        assert.strictEqual(provider.registry.get('tapis-legacy').state, 'submitted');

        // The comparison uses the newest token in memory, wherever it is held.
        const activeNewer = seed('task-e', 'tapis-e');
        provider.activeJobs.get('tapis-e').token = makeJwt('alice', 7200);
        assert.strictEqual(provider.refreshOwnerToken('task-e', makeJwt('alice', 3600)), false, 'older than the active token: ignored');
        assert.strictEqual(activeNewer.token, oldToken);
        assert.strictEqual(provider.refreshOwnerToken('task-e', makeJwt('alice', 9000)), true);

        // A token without exp is never adopted.
        seed('task-f', 'tapis-f');
        const noExp = `header.${Buffer.from(JSON.stringify({ 'tapis/username': 'alice', 'tapis/tenant_id': 'portals' })).toString('base64url')}.sig`;
        assert.strictEqual(provider.refreshOwnerToken('task-f', noExp), false);

        // After the pending entry was consumed (cancel in flight) only the registry record
        // remains; a fresh owner token is still adopted and reaches tokenFor().
        provider.recordUpsert({ jobName: 'clusterodx-0-task-g', tapisJobId: 'tapis-g', taskId: 'task-g', owner: 'alice', ownerTenant: 'portals', state: 'cancelFailed' });
        assert.strictEqual(provider.tokenFor('tapis-g'), null);
        assert.strictEqual(provider.refreshOwnerToken('task-g', makeJwt('mallory', 7200)), false, 'registry owner still guards adoption');
        const forG = makeJwt('alice', 7200);
        assert.strictEqual(provider.refreshOwnerToken('task-g', forG), true);
        assert.strictEqual(provider.tokenFor('tapis-g'), forG);
        assert.strictEqual(provider.registry.get('tapis-g').state, 'cancelFailed');

        // Log hygiene: adoption is logged with the user, never with the token.
        assert.ok(messages.some(m => m.includes('adopted a newer token') && m.includes('alice@portals')));
        const jwtShaped = /[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}/;
        assert.ok(messages.every(m => !jwtShaped.test(m)), 'no log line contains a JWT');
    } finally {
        logger.info = originalInfo;
        logger.warn = originalWarn;
        try { fs.unlinkSync(registryPath); } catch (_) { /* nothing to clean */ }
    }

    console.log('TAPIS TOKEN REFRESH TEST PASSED');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
