'use strict';

const assert = require('assert');
const logger = require('../libs/logger');
const { cancelTapisJob, isTerminalOutcome, OUTCOMES } = require('../libs/tapisCancel');
const TapisProvider = require('../libs/asr-providers/tapis');

const makeJwt = (username, tenant = 'portals') => {
    const payload = Buffer.from(JSON.stringify({
        'tapis/username': username,
        'tapis/tenant_id': tenant,
        exp: Math.floor(Date.now() / 1000) + 3600
    })).toString('base64url');
    return `header.${payload}.signature`;
};

const httpError = (status, message = 'error') => {
    const error = new Error(`Request failed with status code ${status}`);
    error.response = { status, data: { message } };
    return error;
};

const fakeClient = ({ post, get }) => {
    const calls = [];
    return {
        calls,
        post: async path => { calls.push(['post', path]); return post(path); },
        get: async path => { calls.push(['get', path]); return get ? get(path) : { status: 200, data: {} }; }
    };
};

(async () => {
    // Helper: documented endpoint and outcome classification.
    let client = fakeClient({ post: async () => ({ status: 200 }) });
    let result = await cancelTapisJob(client, 'job-1');
    assert.strictEqual(result.outcome, OUTCOMES.CANCELLED);
    assert.deepStrictEqual(client.calls, [['post', '/v3/jobs/job-1/cancel']]);
    assert.ok(isTerminalOutcome(result));

    client = fakeClient({ post: async () => { throw httpError(404); }, get: async () => { throw httpError(404); } });
    result = await cancelTapisJob(client, 'job-2');
    assert.strictEqual(result.outcome, OUTCOMES.NOT_FOUND, '404 on cancel and GET means the job is gone');
    assert.ok(isTerminalOutcome(result));

    client = fakeClient({ post: async () => { throw httpError(404); }, get: async () => ({ status: 200, data: { result: { status: 'RUNNING' } } }) });
    result = await cancelTapisJob(client, 'job-3');
    assert.strictEqual(result.outcome, OUTCOMES.FAILED, '404 on cancel but job still visible is a failure, not success');

    client = fakeClient({ post: async () => { throw httpError(403, 'forbidden'); } });
    result = await cancelTapisJob(client, 'job-4');
    assert.strictEqual(result.outcome, OUTCOMES.UNAUTHORIZED);
    assert.ok(!isTerminalOutcome(result));

    client = fakeClient({ post: async () => { throw httpError(500, 'internal'); } });
    result = await cancelTapisJob(client, 'job-5');
    assert.strictEqual(result.outcome, OUTCOMES.FAILED);
    assert.strictEqual(result.status, 500);

    client = fakeClient({ post: async () => { const e = new Error('timeout of 1ms exceeded'); e.code = 'ECONNABORTED'; throw e; } });
    result = await cancelTapisJob(client, 'job-6');
    assert.strictEqual(result.outcome, OUTCOMES.FAILED);
    assert.strictEqual(result.code, 'ECONNABORTED');

    // Provider: consume before cancel, park on failure, never throw, never log a token.
    const messages = [];
    const originalInfo = logger.info;
    const originalWarn = logger.warn;
    logger.info = message => messages.push(String(message));
    logger.warn = message => messages.push(String(message));

    try {
        const provider = new TapisProvider({
            tapis: { baseUrl: 'https://example.tapis.io', tenantId: 'portals', registryPath: require('path').join(require('os').tmpdir(), `clusterodx-cancel-test-registry-${process.pid}.json`) },
            app: { appId: 'nodeodx-ls6', appVersion: '1.0.18' },
            system: { executionSystemId: 'ls6', archiveSystemId: 'ls6' },
            imageSizeMapping: [{ maxImages: 100, nodeCount: 1, logicalQueue: 'vm-small' }]
        });
        await provider.initialize();
        const token = makeJwt('alice');
        const realClient = provider.createApiClient(token);
        assert.strictEqual(realClient.defaults.timeout, 30000, 'Tapis calls time out by default');
        assert.strictEqual(realClient.defaults.maxRedirects, 0);

        let cancelBehaviour = async () => ({ status: 200 });
        provider.createApiClient = () => ({
            post: async path => cancelBehaviour(path),
            get: async () => ({ status: 200, data: { result: { status: 'RUNNING' } } })
        });

        const seed = (jobId, tapisJobId) => {
            const pending = { taskId: jobId, jobId, tapisJobId, token, tapisJobOwner: 'alice', tapisJobOwnerTenant: 'portals' };
            provider.pendingTasks.set(jobId, pending);
            provider.pendingTasks.set(tapisJobId, pending);
            provider.activeJobs.set(tapisJobId, { jobId, token, status: 'SUBMITTING' });
            return pending;
        };

        // Success path.
        seed('clusterodx-0-a', 'tapis-a');
        assert.strictEqual(await provider.cancelPendingTask('clusterodx-0-a'), true);
        assert.strictEqual(provider.findPendingTask('clusterodx-0-a'), null);
        assert.strictEqual(provider.findPendingTask('tapis-a'), null);
        assert.ok(!provider.activeJobs.has('tapis-a'));

        // Failure path: pending is consumed anyway and the job is parked for retry.
        cancelBehaviour = async () => { throw httpError(500, 'internal'); };
        seed('clusterodx-0-b', 'tapis-b');
        assert.strictEqual(await provider.cancelPendingTask('clusterodx-0-b'), true, 'cancelPendingTask must not throw on Tapis failure');
        assert.strictEqual(provider.findPendingTask('clusterodx-0-b'), null, 'pending record must be consumed before the Tapis call');
        const parked = provider.activeJobs.get('tapis-b');
        assert.ok(parked, 'failed cancel keeps the job for retry');
        assert.strictEqual(parked.status, 'cancelFailed');
        assert.strictEqual(parked.cancelOutcome, OUTCOMES.FAILED);
        assert.strictEqual(parked.token, token, 'token stays in memory for the retry');

        // destroyNode without a token in memory returns false and says why.
        const node = { getTapisJobId: () => 'tapis-unknown', toString: () => 'ls6:1' };
        assert.strictEqual(await provider.destroyNode(node), false);
        assert.ok(messages.some(m => m.includes('no token in memory')), 'missing-token path is logged');

        // Log hygiene: user present, token absent.
        const cancelLines = messages.filter(m => m.includes('[TAPIS] job cancel'));
        assert.ok(cancelLines.length >= 2);
        assert.ok(cancelLines.every(m => m.includes('"user":"alice@portals"')), 'cancel events name the user');
        const jwtShaped = /[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}/;
        assert.ok(messages.every(m => !jwtShaped.test(m) && !m.includes(token)), 'no log line contains a JWT');
    } finally {
        logger.info = originalInfo;
        logger.warn = originalWarn;
    }

    console.log('TAPIS CANCEL TEST PASSED');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
