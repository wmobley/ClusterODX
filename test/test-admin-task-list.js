const assert = require('assert');
const http = require('http');
const { listTasks } = require('../libs/adminTasks');
const tasktable = require('../libs/tasktable');
const routetable = require('../libs/routetable');
const asrProvider = require('../libs/asrProvider');
const adminweb = require('../adminweb');

const SECRET = 'seeded-private-credential';
const rowKeys = ['uuid', 'name', 'source', 'state', 'statusCode', 'imagesCount',
    'dateCreated', 'accessed', 'tapisJobId', 'node'].sort();
const assertSafe = rows => {
    assert.ok(!JSON.stringify(rows).includes(SECRET), 'private records must not be serialized');
    for (const row of rows) {
        assert.deepStrictEqual(Object.keys(row).sort(), rowKeys);
        for (const field of ['uuid', 'name', 'source', 'state']) assert.strictEqual(typeof row[field], 'string');
        for (const field of ['statusCode', 'imagesCount', 'dateCreated', 'accessed']) {
            assert.ok(row[field] === null || (typeof row[field] === 'number' && Number.isFinite(row[field])), field);
        }
        assert.ok(row.tapisJobId === null || typeof row.tapisJobId === 'string');
        if (row.node) assert.deepStrictEqual(Object.keys(row.node).sort(), ['hostname', 'port']);
    }
};
const makeNode = (job = 'tapis-routed') => Object.freeze({
    hostname: () => 'worker.example', port: () => 3001, getTapisJobId: () => job,
    token: SECRET, nodeData: { privateKey: SECRET },
    taskInfo: () => { throw new Error('must not contact workers'); },
    updateInfo: () => { throw new Error('must not contact workers'); }
});
const summarize = (uuid, statusCode, extra = {}) => Object.freeze({
    uuid, name: `Flight ${uuid}`, statusCode, imagesCount: 12,
    dateCreated: 1000, accessed: 2000, ...extra
});
const aggregate = (pending = [], routes = {}, provider = null) => listTasks({
    tasktable: { listSummaries: async () => pending },
    routetable: { findByNode: async () => routes }, provider
});
const request = (port, authorization) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/r/task/list',
        headers: authorization ? { authorization } : {} }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
});
const close = server => new Promise(resolve => server.close(resolve));
const assertNoStore = response => assert.strictEqual(response.headers['cache-control'], 'no-store');

async function testAggregation() {
    assert.deepStrictEqual(await aggregate(), []);
    assert.deepStrictEqual(await aggregate([], null), []);
    const pending = [summarize('queued', 10), summarize('launching', 20),
        summarize('waiting', 20), summarize('failed', 30), summarize('completed', 40),
        summarize('canceled', 50), summarize('unknown', null)];
    const privatePending = Object.freeze({ tapisJobId: 'tapis-waiting', token: SECRET,
        options: { token: SECRET }, tmpPath: SECRET });
    const provider = { findPendingTask: uuid => uuid === 'waiting' ? privatePending : null };
    const rows = await aggregate(Object.freeze(pending), {}, provider);
    assertSafe(rows);
    assert.deepStrictEqual(Object.fromEntries(rows.map(row => [row.uuid, row.state])), {
        queued: 'queued', launching: 'submitting', waiting: 'waiting_registration',
        failed: 'failed', completed: 'completed', canceled: 'canceled', unknown: 'unknown'
    });
    assert.strictEqual(rows.find(row => row.uuid === 'waiting').tapisJobId, 'tapis-waiting');
    assert.ok(rows.every(row => row.source === 'pending' && row.node === null));
    assert.strictEqual((await aggregate([summarize('other-provider', 20)], {}, {}))[0].state, 'submitting');

    const routes = Object.freeze({
        waiting: Object.freeze({ node: makeNode(), accessed: 3000, token: SECRET }),
        failed: Object.freeze({ node: makeNode(), accessed: 3001, token: SECRET }),
        completed: Object.freeze({ node: makeNode(), accessed: 3002, token: SECRET }),
        canceled: Object.freeze({ node: makeNode(), accessed: 3003, token: SECRET }),
        'route-only': Object.freeze({ node: makeNode(null), accessed: 3004, token: SECRET })
    });
    const merged = await aggregate(pending, routes, provider);
    assertSafe(merged);
    assert.strictEqual(merged.length, 8, 'handoff duplicates must appear once');
    const assigned = merged.find(row => row.uuid === 'waiting');
    assert.deepStrictEqual(assigned, {
        uuid: 'waiting', name: 'Flight waiting', source: 'route', state: 'assigned',
        statusCode: 20, imagesCount: 12, dateCreated: 1000, accessed: 3000,
        tapisJobId: 'tapis-routed', node: { hostname: 'worker.example', port: 3001 }
    });
    for (const state of ['failed', 'completed', 'canceled']) {
        assert.strictEqual(merged.find(row => row.uuid === state).state, state,
            'local terminal state must take precedence over a route');
    }
    assert.deepStrictEqual(merged.find(row => row.uuid === 'route-only'), {
        uuid: 'route-only', name: 'route-only', source: 'route', state: 'assigned',
        statusCode: null, imagesCount: null, dateCreated: null, accessed: 3004,
        tapisJobId: null, node: { hostname: 'worker.example', port: 3001 }
    });
    const routeWithoutJob = await aggregate([summarize('waiting', 20)], {
        waiting: { node: makeNode(null), accessed: 3000 }
    }, provider);
    assert.strictEqual(routeWithoutJob[0].tapisJobId, 'tapis-waiting');

    const calls = [];
    const duringHandoff = await listTasks({
        tasktable: { listSummaries: async () => { calls.push('pending'); return [summarize('handoff', 20)]; } },
        routetable: { findByNode: async () => {
            assert.deepStrictEqual(calls, ['pending'], 'snapshot pending before routes');
            calls.push('routes');
            return { handoff: { node: makeNode(), accessed: 3000, token: SECRET } };
        } }, provider: null
    });
    assert.strictEqual(duringHandoff.length, 1);
    assert.strictEqual(duringHandoff[0].source, 'route');
    assert.strictEqual(pending[2].statusCode, 20, 'aggregation must not mutate source summaries');
    assert.strictEqual(routes.waiting.token, SECRET);

    const malformed = await aggregate([{
        uuid: 'malformed', name: { token: SECRET }, statusCode: Infinity,
        imagesCount: NaN, dateCreated: { token: SECRET }, accessed: 'bad', token: SECRET
    }], { 'no-endpoint': { node: { token: SECRET }, accessed: Infinity } });
    assertSafe(malformed);
    assert.strictEqual(malformed.find(row => row.uuid === 'malformed').name, 'malformed');
    assert.strictEqual(malformed.find(row => row.uuid === 'malformed').statusCode, null);
    assert.strictEqual(malformed.find(row => row.uuid === 'no-endpoint').node, null);
}

async function testRealSummaries() {
    assert.deepStrictEqual(await tasktable.listSummaries(), [], 'uninitialized table should be empty');
    const originalSetInterval = global.setInterval;
    let cleanup;
    try {
        global.setInterval = (callback, delay) => {
            assert.strictEqual(delay, 60 * 60 * 1000);
            cleanup = callback;
            return 1;
        };
        await tasktable.initialize();
    } finally {
        global.setInterval = originalSetInterval;
    }
    const obj = { taskInfo: { name: 'Flight', status: { code: 20 }, imagesCount: 0,
        dateCreated: 1000, options: [{ token: SECRET }] }, output: [SECRET], tmpPath: SECRET };
    await tasktable.add('real-task', obj, SECRET);
    const first = await tasktable.listSummaries();
    assert.deepStrictEqual(Object.keys(first[0]).sort(),
        ['uuid', 'name', 'statusCode', 'imagesCount', 'dateCreated', 'accessed'].sort());
    assert.ok(!JSON.stringify(first).includes(SECRET));
    assert.strictEqual(first[0].imagesCount, 0);
    first[0].name = 'client mutation';
    assert.strictEqual((await tasktable.listSummaries())[0].name, 'Flight');
    await tasktable.add('malformed', { taskInfo: { name: { token: SECRET }, status: { code: Infinity },
        imagesCount: NaN, dateCreated: { token: SECRET } } }, SECRET);
    await tasktable.add('missing-info', { token: SECRET }, SECRET);
    const malformed = (await tasktable.listSummaries()).find(row => row.uuid === 'malformed');
    assert.strictEqual(malformed.name, 'malformed');
    assert.strictEqual(malformed.statusCode, null);
    assert.strictEqual(malformed.imagesCount, null);
    assert.strictEqual(malformed.dateCreated, null);
    assert.ok(!JSON.stringify(await tasktable.listSummaries()).includes(SECRET));
    // Reading summaries must not renew the task's two-day retention period.
    const originalDate = global.Date;
    try {
        const future = new originalDate().getTime() + 3 * 24 * 60 * 60 * 1000;
        global.Date = class extends originalDate { constructor(...args) { super(...(args.length ? args : [future])); } };
        await tasktable.listSummaries();
        cleanup();
        assert.deepStrictEqual(await tasktable.listSummaries(), []);
    } finally {
        global.Date = originalDate;
    }
}

async function testHttp() {
    const originals = { list: tasktable.listSummaries, routes: routetable.findByNode, get: asrProvider.get };
    let fail = false;
    let reads = 0;
    tasktable.listSummaries = async () => {
        reads++;
        if (fail) throw new Error(SECRET);
        return [summarize('http-task', 20)];
    };
    routetable.findByNode = async () => ({});
    asrProvider.get = () => ({ findPendingTask: () => ({ tapisJobId: 'tapis-http', token: SECRET }) });
    const basic = `Basic ${Buffer.from('admin:test-password').toString('base64')}`;
    let basicServer;
    let jwtServer;
    try {
        basicServer = await adminweb.create({ port: 0, password: 'test-password' });
        let response = await request(basicServer.address().port);
        assert.strictEqual(response.status, 401);
        assertNoStore(response);
        assert.strictEqual(reads, 0, 'unauthenticated requests must not read task data');
        response = await request(basicServer.address().port, basic);
        assert.strictEqual(response.status, 200);
        assertNoStore(response);
        const rows = JSON.parse(response.body);
        assertSafe(rows);
        assert.strictEqual(rows[0].state, 'waiting_registration');
        assert.strictEqual(rows[0].tapisJobId, 'tapis-http');
        fail = true;
        response = await request(basicServer.address().port, basic);
        assert.strictEqual(response.status, 500);
        assertNoStore(response);
        assert.ok(JSON.parse(response.body).error);
        assert.ok(!response.body.includes(SECRET), 'errors must not reveal private exception text');
        fail = false;

        const claims = Buffer.from(JSON.stringify({ 'tapis/tenant_id': 'portals',
            'tapis/username': 'operator', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
        const jwt = `header.${claims}.signature`;
        jwtServer = await adminweb.create({ port: 0, useTapisJwt: true,
            allowedTenants: ['portals'], allowedUsers: ['operator'],
            tapisProvider: { validateToken: async token => {
                if (token !== jwt) { const error = new Error(SECRET); error.response = { status: 401 }; throw error; }
            } }
        });
        const port = jwtServer.address().port;
        for (const auth of [undefined, 'Bearer invalid-token', basic]) {
            const before = reads;
            response = await request(port, auth);
            assert.strictEqual(response.status, 401);
            assertNoStore(response);
            assert.ok(!response.body.includes(SECRET));
            assert.strictEqual(reads, before);
        }
        response = await request(port, `Bearer ${jwt}`);
        assert.strictEqual(response.status, 200);
        assertNoStore(response);
        assertSafe(JSON.parse(response.body));
        assert.ok(!response.body.includes(jwt));
    } finally {
        if (basicServer) await close(basicServer);
        if (jwtServer) await close(jwtServer);
        tasktable.listSummaries = originals.list;
        routetable.findByNode = originals.routes;
        asrProvider.get = originals.get;
    }
}

(async () => {
    await testAggregation();
    await testRealSummaries();
    await testHttp();
    console.log('ADMIN TASK LIST TEST PASSED');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
