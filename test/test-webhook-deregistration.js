const assert = require('assert');
const fs = require('fs');
const http = require('http');
const adminweb = require('../adminweb');
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
    const jwt = makeJwt('operator');
    const otherJwt = makeJwt('other-user');
    let destroyed = 0;
    const provider = {
        validateToken: async token => {
            if (token === 'invalid-token') {
                const error = new Error('invalid token');
                error.response = { status: 401 };
                throw error;
            }
        },
        destroyNode: async () => { destroyed++; }
    };

    const jwtServer = await adminweb.create({
        port: 0,
        useTapisJwt: true,
        tapisProvider: provider
    });
    const jwtPort = jwtServer.address().port;

    try {
        const missingAuth = await request(jwtPort, '/webhook/deregister-node', {
            method: 'POST',
            body: { nodeId: 1 }
        });
        assert.strictEqual(missingAuth.status, 401);

        const node = nodes.addUnique('deregistration-test.example', 61001, 'node-token');
        assert.ok(node);
        node.setTapisJob('tapis-job-1');
        node.nodeData.tapisJobOwner = 'operator';
        node.nodeData.tapisJobOwnerTenant = 'portals';
        await nodes.saveToDisk();
        const nodeId = nodes.all().indexOf(node) + 1;

        const wrongOwner = await request(jwtPort, '/webhook/deregister-node', {
            method: 'POST',
            headers: { authorization: `Bearer ${otherJwt}` },
            body: { nodeId }
        });
        assert.strictEqual(wrongOwner.status, 403);
        assert.ok(nodes.all().includes(node));

        const invalidToken = await request(jwtPort, '/webhook/deregister-node', {
            method: 'POST',
            headers: { authorization: 'Bearer invalid-token' },
            body: { nodeId }
        });
        assert.strictEqual(invalidToken.status, 401);

        const missingIdentifier = await request(jwtPort, '/webhook/deregister-node', {
            method: 'POST',
            headers: { authorization: `Bearer ${jwt}` },
            body: {}
        });
        assert.strictEqual(missingIdentifier.status, 400);

        const removed = await request(jwtPort, '/webhook/deregister-node', {
            method: 'POST',
            headers: { authorization: `Bearer ${jwt}` },
            body: { nodeId }
        });
        assert.strictEqual(removed.status, 200);
        assert.strictEqual(JSON.parse(removed.body).success, true);
        assert.ok(!nodes.all().includes(node));
        assert.strictEqual(destroyed, 1);
    } finally {
        await new Promise(resolve => jwtServer.close(resolve));
    }

    const secretNode = nodes.addUnique('deregistration-secret.example', 61002, 'node-token');
    assert.ok(secretNode);
    await nodes.saveToDisk();
    const secretServer = await adminweb.create({
        port: 0,
        registrationSecret: 'test-registration-secret'
    });
    try {
        const removed = await request(secretServer.address().port, '/webhook/deregister-node', {
            method: 'POST',
            body: {
                hostname: secretNode.hostname(),
                port: secretNode.port(),
                registrationSecret: 'test-registration-secret'
            }
        });
        assert.strictEqual(removed.status, 200);
    } finally {
        await new Promise(resolve => secretServer.close(resolve));
        for (const node of nodes.all().filter(candidate => candidate.hostname().startsWith('deregistration-'))) {
            nodes.remove(node);
        }
        await nodes.saveToDisk();
        fs.writeFileSync('data/nodes.json', originalNodes);
    }

    console.log('WEBHOOK DEREGISTRATION TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
