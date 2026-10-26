const assert = require('assert');
const fs = require('fs');
const http = require('http');
const adminweb = require('../adminweb');
const asrProvider = require('../libs/asrProvider');
const nodes = require('../libs/nodes');

const request = (port, path, options = {}) => new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: {
            ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
            ...(options.headers || {}),
        },
    }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
});

const makeJwt = (username, tenant = 'portals') => {
    const payload = Buffer.from(JSON.stringify({
        'tapis/tenant_id': tenant,
        'tapis/username': username,
        exp: Math.floor(Date.now() / 1000) + 300
    })).toString('base64url');
    return `header.${payload}.signature`;
};

(async () => {
    const originalNodes = fs.readFileSync('data/nodes.json', 'utf8');
    const jwt = makeJwt('worker-owner');
    const otherJwt = makeJwt('other-owner');
    let pendingLookups = 0;
    const provider = {
        getDriverName: () => 'tapis',
        getConfig: key => key === 'worker.registrationSecret' ? 'worker-secret' : '',
        validateToken: async token => {
            if (token === 'invalid-token') {
                const error = new Error('invalid token');
                error.response = { status: 401 };
                throw error;
            }
        },
        findPendingTask: () => {
            pendingLookups++;
            return null;
        },
        findPendingTaskByUser: () => ({ task: null, count: 0 })
    };
    const originalGet = asrProvider.get;
    asrProvider.get = () => provider;
    const server = await adminweb.create({ port: 0 });
    const port = server.address().port;
    const workerHeaders = { authorization: `Bearer ${jwt}` };

    try {
        const missingAuth = await request(port, '/webhook/register-node', {
            method: 'POST',
            body: { hostname: 'legacy-worker-missing-auth', port: 61011, role: 'worker' }
        });
        assert.strictEqual(missingAuth.status, 401);

        const invalidAuth = await request(port, '/webhook/register-node', {
            method: 'POST',
            headers: { authorization: 'Bearer invalid-token' },
            body: { hostname: 'legacy-worker-invalid-auth', port: 61012, role: 'worker' }
        });
        assert.strictEqual(invalidAuth.status, 401);

        const legacyJwt = await request(port, '/webhook/register-node', {
            method: 'POST',
            headers: workerHeaders,
            body: {
                hostname: 'legacy-worker-jwt',
                port: 61013,
                token: 'node-token',
                role: 'worker',
                tapisJobUuid: 'not-pending-job',
                registrationUuid: 'not-pending-task'
            }
        });
        assert.strictEqual(legacyJwt.status, 200);
        assert.strictEqual(JSON.parse(legacyJwt.body).registrationMode, 'legacy-worker');
        const jwtNode = nodes.find(node => node.hostname() === 'legacy-worker-jwt' && node.port() === 61013);
        assert.ok(jwtNode);
        assert.strictEqual(jwtNode.getTapisJobId(), undefined);
        assert.strictEqual(jwtNode.nodeData.tapisJobOwner, 'worker-owner');
        assert.strictEqual(jwtNode.nodeData.tapisJobOwnerTenant, 'portals');

        const legacySecret = await request(port, '/webhook/register-node', {
            method: 'POST',
            body: {
                hostname: 'legacy-worker-secret',
                port: 61014,
                role: 'worker',
                registrationSecret: 'worker-secret',
                tapisJobOwner: 'forged-owner'
            }
        });
        assert.strictEqual(legacySecret.status, 200);
        assert.strictEqual(JSON.parse(legacySecret.body).authMethod, 'registration-secret');
        const secretNode = nodes.find(node => node.hostname() === 'legacy-worker-secret' && node.port() === 61014);
        assert.ok(secretNode);
        assert.strictEqual(secretNode.nodeData.tapisJobOwner, null);

        const duplicate = await request(port, '/webhook/register-node', {
            method: 'POST',
            headers: workerHeaders,
            body: { hostname: 'legacy-worker-jwt', port: 61013, role: 'worker' }
        });
        assert.strictEqual(duplicate.status, 200);

        const differentOwner = await request(port, '/webhook/register-node', {
            method: 'POST',
            headers: { authorization: `Bearer ${otherJwt}` },
            body: { hostname: 'legacy-worker-jwt', port: 61013, role: 'worker' }
        });
        assert.strictEqual(differentOwner.status, 403);
        assert.strictEqual(jwtNode.nodeData.tapisJobOwner, 'worker-owner');

        const taskBound = await request(port, '/webhook/register-node', {
            method: 'POST',
            headers: workerHeaders,
            body: { hostname: 'task-bound-worker', port: 61015, role: 'admin', tapisJobUuid: 'missing-job' }
        });
        assert.strictEqual(taskBound.status, 404);
        assert.strictEqual(pendingLookups, 2);

        const secretTaskBound = await request(port, '/webhook/register-node', {
            method: 'POST',
            body: {
                hostname: 'secret-task-bound-worker',
                port: 61018,
                role: 'admin',
                tapisJobUuid: 'secret-task',
                registrationSecret: 'worker-secret'
            }
        });
        assert.strictEqual(secretTaskBound.status, 401);

        let ownerPending = {
            taskId: 'owner-task',
            tapisJobId: 'owner-job',
            token: 'different-token',
            tapisJobOwner: 'worker-owner',
            tapisJobOwnerTenant: 'portals',
            registrationMeta: {}
        };
        provider.findPendingTaskByUser = identity => identity.username === 'worker-owner'
            ? { task: ownerPending, count: 1 }
            : { task: null, count: 0 };
        provider.findPendingTask = identifier => identifier === 'owner-job' ? ownerPending : null;

        const ownerBound = await request(port, '/webhook/register-node', {
            method: 'POST',
            headers: workerHeaders,
            body: {
                hostname: 'owner-bound-worker',
                port: 61017,
                role: 'admin',
                tapisJobUuid: 'worker-job-id-does-not-match'
            }
        });
        // The fake provider cannot perform the actual task handoff, but the
        // user-bound lookup must get past the old 404/token-equality gate.
        assert.strictEqual(ownerBound.status, 502);

        const autoSpawned = nodes.addUnique('legacy-worker-autospawned', 61016, 'node-token');
        assert.ok(autoSpawned);
        autoSpawned.setTapisJob('managed-job');
        await nodes.saveToDisk();
        const autoSpawnedRegistration = await request(port, '/webhook/register-node', {
            method: 'POST',
            headers: workerHeaders,
            body: { hostname: 'legacy-worker-autospawned', port: 61016, role: 'worker' }
        });
        assert.strictEqual(autoSpawnedRegistration.status, 409);
    } finally {
        await new Promise(resolve => server.close(resolve));
        asrProvider.get = originalGet;
        for (const node of nodes.all().filter(node => node.hostname().startsWith('legacy-worker-') || node.hostname() === 'task-bound-worker')) {
            nodes.remove(node);
        }
        await nodes.saveToDisk();
        fs.writeFileSync('data/nodes.json', originalNodes);
    }

    console.log('WEBHOOK REGISTRATION TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
