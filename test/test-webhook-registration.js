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

        // Sibling hosts share a Tapis job but must join as distinct ordinary workers.
        const lookupsBeforeSiblings = pendingLookups;
        for (const workerId of [1, 2, 3]) {
            const payload = {hostname: 'legacy-worker-sibling', port: 61100 + workerId,
                role: 'worker', tapisJobUuid: 'shared-allocation',
                registrationUuid: `shared-allocation-worker-${workerId}`, workerId,
                childIndex: `${workerId + 1}-worker`, hostId: workerId + 1};
            for (let attempt = 0; attempt < 2; attempt++) {
                const sibling = await request(port, '/webhook/register-node', {
                    method: 'POST', headers: workerHeaders, body: payload
                });
                assert.strictEqual(sibling.status, 200);
            }
            const registered = nodes.find(node => node.hostname() === payload.hostname && node.port() === payload.port);
            assert.ok(registered);
            assert.strictEqual(registered.isAutoSpawned(), false);
            assert.strictEqual(registered.nodeData.workerId, workerId);
        }
        assert.strictEqual(pendingLookups, lookupsBeforeSiblings, 'worker arrival must not claim the parent task');
        assert.strictEqual(nodes.all().filter(node => node.hostname() === 'legacy-worker-sibling').length, 3);

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

        // Trusted-cluster opt-in: exact allocation identity, both arrival orders,
        // and an actual local /task/new handoff without live Tapis writes.
        const routetable = require('../libs/routetable');
        const tasktable = require('../libs/tasktable');
        const originalAdd = routetable.add;
        const originalDelete = tasktable.delete;
        let submitted = 0;
        let failSubmit = true;
        let consumed = false;
        let claimed = false;
        const allocation = { taskId: 'secret-task', tapisJobId: 'secret-job',
            tapisJobOwner: 'trusted-owner', tapisJobOwnerTenant: 'portals',
            token: 'expired-owner-token', pathImport: '/corral/webodm/media/images', taskOptions: [] };
        provider.getConfig = key => ({ 'worker.registrationSecret': 'worker-secret',
            'worker.allowSharedSecretPrimaryRegistration': true })[key];
        provider.findPendingTask = id => !consumed && ['secret-job', 'secret-task'].includes(id) ? allocation : null;
        provider.findRegistrationJob = id => id === 'secret-job' ? allocation : null;
        provider.claimPendingTask = () => { if (claimed) return false; claimed = true; return true; };
        provider.releasePendingTask = () => { claimed = false; };
        provider.consumePendingTask = () => { consumed = true; };
        const worker = http.createServer((req, res) => {
            req.resume();
            if (req.url.startsWith('/task/new')) submitted++;
            res.writeHead(failSubmit ? 500 : 200, {'content-type': 'application/json'});
            res.end(JSON.stringify(failSubmit ? {error: 'fixture rejection'} : {uuid: 'secret-task'}));
        });
        await new Promise(resolve => worker.listen(0, '127.0.0.1', resolve));
        const payload = { hostname: '127.0.0.1', port: worker.address().port, role: 'admin',
            tapisJobUuid: 'secret-job', registrationSecret: 'worker-secret', tapisJobOwner: 'forged' };
        const register = body => request(port, '/webhook/register-node', {method: 'POST', body});
        routetable.add = async (id, node) => {
            assert.strictEqual(id, 'secret-task');
            assert.strictEqual(node.nodeData.tapisJobOwner, 'trusted-owner');
            assert.strictEqual(node.nodeData.tapisJobOwnerTenant, 'portals');
        };
        tasktable.delete = async () => {};
        try {
            assert.strictEqual((await register({...payload, registrationSecret: 'wrong'})).status, 401);
            assert.strictEqual((await register({...payload, registrationSecret: undefined})).status, 401);
            assert.strictEqual((await register({...payload, tapisJobUuid: 'secret-task'})).status, 403);
            allocation.tapisJobOwnerTenant = null;
            assert.strictEqual((await register(payload)).status, 403);
            allocation.tapisJobOwnerTenant = 'portals';
            const sibling = {...payload, hostname: 'legacy-worker-secret-bound', port: 61100, role: 'worker'};
            assert.strictEqual((await register(sibling)).status, 200);
            assert.strictEqual(nodes.find(n => n.hostname() === sibling.hostname).nodeData.tapisJobOwner, 'trusted-owner');
            assert.strictEqual((await register({...sibling, tapisJobUuid: 'unknown-job'})).status, 403);
            claimed = true;
            assert.strictEqual((await register(payload)).status, 409);
            claimed = false;
            assert.strictEqual((await register(payload)).status, 502);
            assert.strictEqual(claimed, false, 'failed handoff releases the claim');
            assert.ok(!nodes.find(n => n.hostname() === '127.0.0.1' && n.port() === payload.port));
            failSubmit = false;
            const accepted = await register(payload);
            assert.strictEqual(accepted.status, 200, accepted.body);
            assert.strictEqual(JSON.parse(accepted.body).authMethod, 'registration-secret');
            assert.strictEqual(consumed, true);
            assert.strictEqual(submitted, 2);
            assert.strictEqual((await register(payload)).status, 200, 'lost-response retry is idempotent');
            assert.strictEqual((await register({...payload, port: payload.port + 1})).status, 403);
            assert.strictEqual(submitted, 2, 'retry must not resubmit work');
            assert.strictEqual((await register({...sibling, port: 61101})).status, 200,
                'sibling can arrive after primary consumes pending work');
            const badBearer = await request(port, '/webhook/register-node', {method: 'POST',
                headers: {authorization: 'Bearer invalid-token'}, body: payload});
            assert.strictEqual(badBearer.status, 401, 'invalid bearer does not fall back');
        } finally {
            routetable.add = originalAdd;
            tasktable.delete = originalDelete;
            nodes.remove(nodes.find(n => n.hostname() === '127.0.0.1' && n.port() === payload.port));
            await new Promise(resolve => worker.close(resolve));
        }
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
