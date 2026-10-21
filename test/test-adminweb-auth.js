const assert = require('assert');
const http = require('http');
const adminweb = require('../adminweb');

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
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
});

const basicAuth = `Basic ${Buffer.from('admin:test-password').toString('base64')}`;

(async () => {
    const server = await adminweb.create({port: 0, password: 'test-password'});
    const port = server.address().port;

    try {
        const shellUnauthenticated = await request(port, '/');
        assert.strictEqual(shellUnauthenticated.status, 401);

        const shellAuthenticated = await request(port, '/', {
            headers: { authorization: basicAuth }
        });
        assert.strictEqual(shellAuthenticated.status, 200);

        const unauthenticated = await request(port, '/r/info');
        assert.strictEqual(unauthenticated.status, 401);

        const authenticated = await request(port, '/r/info', {
            headers: { authorization: basicAuth }
        });
        assert.strictEqual(authenticated.status, 200);

        const foreignOrigin = await request(port, '/r/node/lock', {
            method: 'POST',
            headers: { authorization: basicAuth, origin: 'https://evil.example' },
            body: { number: 1 }
        });
        assert.strictEqual(foreignOrigin.status, 403);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }

    const jwtPayload = Buffer.from(JSON.stringify({
        'tapis/tenant_id': 'portals',
        'tapis/username': 'operator',
        exp: Math.floor(Date.now() / 1000) + 300
    })).toString('base64url');
    const jwt = `header.${jwtPayload}.signature`;
    const jwtProvider = {
        validateToken: async token => {
            if (token === 'invalid-token') {
                const error = new Error('invalid token');
                error.response = { status: 401 };
                throw error;
            }
            assert.strictEqual(token, jwt);
            return true;
        }
    };
    const jwtServer = await adminweb.create({
        port: 0,
        useTapisJwt: true,
        tapisProvider: jwtProvider,
        allowedTenants: ['portals'],
        allowedUsers: ['operator']
    });
    const jwtPort = jwtServer.address().port;
    const jwtAuth = `Bearer ${jwt}`;

    try {
        const shell = await request(jwtPort, '/');
        assert.strictEqual(shell.status, 200);
        assert.ok(!shell.headers['www-authenticate']);

        const protectedWithoutToken = await request(jwtPort, '/r/info');
        assert.strictEqual(protectedWithoutToken.status, 401);

        const missingLoginToken = await request(jwtPort, '/r/auth/validate', { method: 'POST' });
        assert.strictEqual(missingLoginToken.status, 401);

        const login = await request(jwtPort, '/r/auth/validate', {
            method: 'POST',
            headers: { authorization: jwtAuth }
        });
        assert.strictEqual(login.status, 200);
        assert.ok(!login.body.includes(jwt));

        const authenticated = await request(jwtPort, '/r/info', {
            headers: { authorization: jwtAuth }
        });
        assert.strictEqual(authenticated.status, 200);

        const invalid = await request(jwtPort, '/r/auth/validate', {
            method: 'POST',
            headers: { authorization: 'Bearer invalid-token' }
        });
        assert.strictEqual(invalid.status, 401);
    } finally {
        await new Promise(resolve => jwtServer.close(resolve));
    }

    const unconfigured = await adminweb.create({port: 0});
    try {
        const shell = await request(unconfigured.address().port, '/');
        assert.strictEqual(shell.status, 503);
        const response = await request(unconfigured.address().port, '/r/info');
        assert.strictEqual(response.status, 503);
    } finally {
        await new Promise(resolve => unconfigured.close(resolve));
    }

    console.log('ADMIN WEB AUTH TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
