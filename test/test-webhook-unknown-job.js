'use strict';

const assert = require('assert');
const http = require('http');
const adminweb = require('../adminweb');
const asrProvider = require('../libs/asrProvider');

const request = (port, path, options = {}) => new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({
        hostname: '127.0.0.1', port, path, method: options.method || 'GET',
        headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...(options.headers || {}) }
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
    const payload = Buffer.from(JSON.stringify({ 'tapis/tenant_id': tenant, 'tapis/username': username, exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
    return `header.${payload}.signature`;
};

(async () => {
    const jwt = makeJwt('worker-owner');
    const calls = [];
    let handled = true;
    const provider = {
        getDriverName: () => 'tapis',
        getConfig: () => '',
        validateToken: async token => { if (token === 'invalid-token') { const e = new Error('invalid'); e.response = { status: 401 }; throw e; } },
        findPendingTask: () => null,
        findPendingTaskByUser: () => ({ task: null, count: 0 }),
        cancelUnknownJob: async (token, identity, uuid) => { calls.push({ token, identity, uuid }); return { handled }; }
    };
    const routetable = require('../libs/routetable');
    const originalLookup = routetable.lookup;
    routetable.lookup = async () => null; // the table is not initialised in this test
    const originalGet = asrProvider.get;
    asrProvider.get = () => provider;
    const server = await adminweb.create({ port: 0 });
    const port = server.address().port;

    try {
        // Verified unknown job: fixed 410 body, cancel attempted with the request bearer.
        let res = await request(port, '/webhook/register-node', {
            method: 'POST', headers: { authorization: `Bearer ${jwt}` },
            body: { hostname: 'orphan-worker', port: 61021, role: 'admin', tapisJobUuid: 'orphan-job' }
        });
        assert.strictEqual(res.status, 410);
        assert.deepStrictEqual(JSON.parse(res.body), { error: 'No task for this job', terminate: true });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].token, jwt);
        assert.deepStrictEqual(calls[0].identity, { username: 'worker-owner', tenantId: 'portals' });
        assert.strictEqual(calls[0].uuid, 'orphan-job');

        // Verification failed (or flag off): the old 404 is unchanged.
        handled = false;
        res = await request(port, '/webhook/register-node', {
            method: 'POST', headers: { authorization: `Bearer ${jwt}` },
            body: { hostname: 'orphan-worker', port: 61022, role: 'admin', tapisJobUuid: 'someone-elses-job' }
        });
        assert.strictEqual(res.status, 404);

        // No job uuid: nothing to verify, no call.
        res = await request(port, '/webhook/register-node', {
            method: 'POST', headers: { authorization: `Bearer ${jwt}` },
            body: { hostname: 'orphan-worker', port: 61023, role: 'admin', registrationUuid: '4f1b1e2a-0000-4000-8000-000000000000' }
        });
        assert.strictEqual(res.status, 404);
        assert.strictEqual(calls.length, 2);

        // Invalid token never reaches the cancel path.
        res = await request(port, '/webhook/register-node', {
            method: 'POST', headers: { authorization: 'Bearer invalid-token' },
            body: { hostname: 'orphan-worker', port: 61024, role: 'admin', tapisJobUuid: 'orphan-job' }
        });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(calls.length, 2);
    } finally {
        server.close();
        asrProvider.get = originalGet;
        routetable.lookup = originalLookup;
    }
    console.log('WEBHOOK UNKNOWN JOB TEST PASSED');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
