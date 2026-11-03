'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../libs/logger');
const TapisProvider = require('../libs/asr-providers/tapis');
const TapisJobRegistry = require('../libs/tapisJobRegistry');

const { STATES } = TapisJobRegistry;

const makeJwt = (username, tenant = 'portals') => {
    const payload = Buffer.from(JSON.stringify({
        'tapis/username': username, 'tapis/tenant_id': tenant, exp: Math.floor(Date.now() / 1000) + 3600
    })).toString('base64url');
    return `header.${payload}.signature`;
};

const timeoutError = () => { const e = new Error('timeout of 1ms exceeded'); e.code = 'ECONNABORTED'; return e; };
const httpError = status => { const e = new Error(`Request failed with status code ${status}`); e.response = { status, data: {} }; return e; };

const makeProvider = async (overrides = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clusterodx-reconcile-'));
    const provider = new TapisProvider({
        tapis: Object.assign({
            baseUrl: 'https://example.tapis.io', tenantId: 'portals', registryPath: path.join(dir, 'registry.json'),
            submitReconcileSeconds: 1, reconcilePollMs: 5, submitTimeoutMs: 50
        }, overrides),
        app: { appId: 'nodeodx-ls6', appVersion: '1.0.18' },
        system: { executionSystemId: 'ls6', archiveSystemId: 'ls6' },
        imageSizeMapping: [{ maxImages: 100, nodeCount: 1, logicalQueue: 'vm-small' }]
    });
    await provider.initialize();
    provider.validateToken = async () => true;
    return provider;
};

(async () => {
    const messages = [];
    const originalInfo = logger.info, originalWarn = logger.warn;
    logger.info = m => messages.push(String(m));
    logger.warn = m => messages.push(String(m));
    const token = makeJwt('alice');

    try {
        // 1. Timeout, then the job shows up by name: treated as accepted.
        let provider = await makeProvider();
        let searches = 0;
        provider.createApiClient = () => ({
            post: async () => { throw timeoutError(); },
            get: async (url, options) => {
                assert.strictEqual(url, '/v3/jobs/search');
                searches++;
                if (searches < 2) return { data: { result: [] } };
                const name = options.params.search.replace('name.eq.', '');
                return { data: { result: [
                    { uuid: 'other-uuid', name: 'clusterodx-0-other', owner: 'alice', appId: 'nodeodx-ls6', appVersion: '1.0.18' },
                    { uuid: 'found-uuid', name, owner: 'alice', appId: 'nodeodx-ls6', appVersion: '1.0.18', status: 'QUEUED', created: new Date().toISOString() }
                ] } };
            }
        });
        let result = await provider.createNode({}, 10, token, 'clusterodx-10-recon', { aborted: false }, [], [], null, 'task-recon', '/corral/x', {});
        assert.strictEqual(result, null);
        assert.ok(searches >= 2, 'polled more than once');
        const pending = provider.findPendingTask('task-recon');
        assert.ok(pending && pending.tapisJobId === 'found-uuid', 'reconciled uuid becomes the pending job');
        assert.ok(messages.some(m => m.includes('Job submission reconciled') && m.includes('"user":"alice@portals"')));
        await provider.registry.flush();
        let record = provider.registry.get('found-uuid');
        assert.strictEqual(record.state, STATES.SUBMITTED);
        assert.strictEqual(record.reconciled, true);
        assert.strictEqual(record.taskId, 'task-recon');
        assert.ok(record.submittedAt <= record.acceptedAt);

        // 2. Timeout and nothing found: fails as before, write-ahead record is kept.
        provider = await makeProvider();
        provider.createApiClient = () => ({
            post: async () => { throw timeoutError(); },
            get: async () => ({ data: { result: [] } })
        });
        await assert.rejects(
            provider.createNode({}, 10, token, 'clusterodx-10-lost', { aborted: false }, [], [], null, 'task-lost', '/corral/x', {}),
            /timeout/);
        assert.strictEqual(provider.findPendingTask('task-lost'), null);
        await provider.registry.flush();
        record = provider.registry.get('clusterodx-10-lost');
        assert.strictEqual(record.state, STATES.SUBMITTING, 'ambiguous outcome stays open for the vacuum');
        assert.ok(record.submitFailedAt);
        assert.strictEqual(record.lastError.code, 'ECONNABORTED');

        // 3. Definite 4xx: no lookup, record closed as rejected.
        provider = await makeProvider();
        let lookups = 0;
        provider.createApiClient = () => ({
            post: async () => { throw httpError(403); },
            get: async () => { lookups++; return { data: { result: [] } }; }
        });
        await assert.rejects(provider.createNode({}, 10, token, 'clusterodx-10-denied', { aborted: false }, [], [], null, 'task-denied', '/corral/x', {}), /403/);
        assert.strictEqual(lookups, 0, 'a rejected request is not reconciled');
        await provider.registry.flush();
        record = provider.registry.get('clusterodx-10-denied');
        assert.strictEqual(record.state, STATES.DONE);
        assert.strictEqual(record.doneReason, 'rejected');

        // 4. Abort while reconciling: the found job is cancelled.
        provider = await makeProvider();
        const status = { aborted: false };
        let cancels = 0;
        provider.createApiClient = () => ({
            post: async url => {
                if (url.endsWith('/cancel')) { cancels++; return { status: 200 }; }
                status.aborted = true; // the user cancels while Tapis is slow
                throw timeoutError();
            },
            get: async (url, options) => ({ data: { result: [{ uuid: 'late-uuid', name: options.params.search.replace('name.eq.', ''), owner: 'alice' }] } })
        });
        await assert.rejects(provider.createNode({}, 10, token, 'clusterodx-10-abort', status, [], [], null, 'task-abort', '/corral/x', {}), /Aborted/);
        assert.strictEqual(cancels, 1, 'reconciled-then-aborted job is cancelled');
        assert.strictEqual(provider.findPendingTask('task-abort'), null);
        await provider.registry.flush();
        assert.strictEqual(provider.registry.get('late-uuid').state, STATES.DONE);

        // 5. Accepted normally: timeout option honoured, registry submitted.
        provider = await makeProvider();
        let seenTimeout = null;
        provider.createApiClient = () => ({
            post: async (url, body, options) => { seenTimeout = options.timeout; return { status: 200, data: { result: { uuid: 'ok-uuid' } } }; },
            get: async () => ({ data: { result: [] } })
        });
        await provider.createNode({}, 10, token, 'clusterodx-10-ok', { aborted: false }, [], [], null, 'task-ok', '/corral/x', {});
        assert.strictEqual(seenTimeout, 50, 'tapis.submitTimeoutMs is used');
        await provider.registry.flush();
        assert.strictEqual(provider.registry.get('ok-uuid').state, STATES.SUBMITTED);
        assert.ok(messages.some(m => m.includes('Job submission accepted') && m.includes('"user":"alice@portals"')));

        // Hygiene: no token anywhere in logs or on disk.
        assert.ok(messages.every(m => !m.includes(token)), 'no log line contains the token');
        assert.ok(!fs.readFileSync(provider.registry.filePath, 'utf8').includes(token), 'registry never contains the token');
    } finally {
        logger.info = originalInfo;
        logger.warn = originalWarn;
    }
    console.log('TAPIS RECONCILIATION TEST PASSED');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
