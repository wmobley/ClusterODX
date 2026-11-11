'use strict';
// Admin removal: task records, idle workers, and the "open node" link.
const assert = require('assert');
const http = require('http');
const adminweb = require('../adminweb');
const logger = require('../libs/logger');
const nodes = require('../libs/nodes');
const tasktable = require('../libs/tasktable');
const routetable = require('../libs/routetable');
const asrProvider = require('../libs/asrProvider');
const { removeTasks, parseRemoveRequest, sanitizeError } = require('../libs/adminTasks');
const { nodeUrlWithToken } = require('../libs/nodeLink');
const { isNodeBusy } = require('../libs/nodeBusy');

const jwtFor = (username, tenant = 'portals') => `h.${Buffer.from(JSON.stringify({
    'tapis/username': username, 'tapis/tenant_id': tenant })).toString('base64url')}.sig-sig-sig`;
const LONG_JWT = `${'a'.repeat(12)}.${'b'.repeat(40)}.${'c'.repeat(12)}`;

class FakeNode {
    constructor(name, { autoSpawned = true, queue = 0, transients = 0, jobId = `job-${name}`, token = 'node-secret-token', removeError = null } = {}) {
        Object.assign(this, { name, autoSpawned, queue, transients, jobId, token, removeError, locked: false, removed: [], lockLog: [] });
    }
    hostname() { return `${this.name}.example`; }
    port() { return 3001; }
    getToken() { return this.token; }
    isAutoSpawned() { return this.autoSpawned; }
    isLocked() { return this.locked; }
    setLocked(flag) { this.locked = flag; this.lockLog.push(flag); }
    getTapisJobId() { return this.jobId; }
    getInfoProperty(property, fallback) { return property === 'taskQueueCount' ? this.queue : fallback; }
    async taskRemove(uuid) {
        if (this.removeError) throw new Error(this.removeError);
        this.removed.push(uuid);
        return { success: true };
    }
    isOnline() { return true; }
}

// Fully in-memory dependencies recording every effect in call order.
function world({ routes = {}, summaries = [], pendings = {}, tokens = {} } = {}) {
    const events = [];
    const lines = [];
    const table = new Map(summaries.map(summary => [summary.uuid, { ...summary, abort: () => events.push(`abort ${summary.uuid}`) }]));
    const routeMap = { ...routes };
    const destroyed = [];
    const provider = {
        activeJobs: new Map(Object.entries(tokens).map(([job, token]) => [job, { token }])),
        findPendingTask: key => pendings[key] || null,
        cancelPendingTask: async uuid => { events.push(`cancel ${uuid}`); await new Promise(resolve => setImmediate(resolve)); return true; },
        destroyNode: async node => { destroyed.push(node.name); events.push(`destroy ${node.name}`); return !!tokens[node.jobId] && tokens[node.jobId] !== 'refused'; }
    };
    const deps = {
        tasktable: {
            listSummaries: async () => Array.from(table.values()).map(({ abort, ...rest }) => rest),
            take: async uuid => { const entry = table.get(uuid); table.delete(uuid); events.push(`take ${uuid}`); return entry || null; }
        },
        routetable: {
            findByNode: async node => node ? Object.fromEntries(Object.entries(routeMap).filter(([, entry]) => entry.node === node)) : routeMap,
            remove: async uuid => { events.push(`route ${uuid}`); return delete routeMap[uuid]; },
            removeByNode: async node => { for (const [uuid, entry] of Object.entries(routeMap)) if (entry.node === node) delete routeMap[uuid]; },
            saveToDisk: async () => { events.push('save'); }
        },
        nodes: { remove: node => events.push(`nodes.remove ${node.name}`), saveToDisk: async () => events.push('nodes.save') },
        netutils: { removeAndCleanupNode: async node => { events.push(`cleanup ${node.name}`); return true; } },
        utils: { rmdir: dir => events.push(`rmdir ${dir}`) },
        logger: { info: line => lines.push(line), warn: line => lines.push(line) },
        provider
    };
    return { deps, events, lines, routeMap, table, destroyed };
}
const summary = (uuid, owner = 'ann@portals') => ({ uuid, name: `Flight ${uuid}`, statusCode: 20, owner, accessed: 1, imagesCount: 3, dateCreated: 1 });
const route = (node, token = jwtFor('ann')) => ({ node, token, accessed: 1 });
const admin = { label: 'op@portals', remoteAddress: '10.0.0.1' };

async function testRemoveFlow() {
    // Routed task: worker told to remove it, route deleted synchronously, one save per request.
    const worker = new FakeNode('w1', { autoSpawned: false });
    let w = world({ routes: { t1: route(worker), t2: route(worker) } });
    let out = await removeTasks({ uuids: ['t1', 't2'], admin, deps: w.deps });
    assert.deepStrictEqual(worker.removed.sort(), ['t1', 't2']);
    assert.deepStrictEqual(Object.keys(w.routeMap), []);
    assert.strictEqual(w.events.filter(event => event === 'save').length, 1, 'routes persisted once per request');
    assert.deepStrictEqual(out.results.map(result => [result.uuid, result.outcome, result.owner]), [['t1', 'removed', 'ann@portals'], ['t2', 'removed', 'ann@portals']]);
    assert.strictEqual(out.persist, 'ok');

    // Unknown uuid does not fail the batch; no save when nothing was routed.
    w = world();
    out = await removeTasks({ uuids: ['nope'], admin, deps: w.deps });
    assert.strictEqual(out.results[0].outcome, 'not_found');
    assert.ok(!w.events.includes('save'));
    // Prototype keys are plain unknown ids, not hits on Object.prototype.
    out = await removeTasks({ uuids: ['__proto__', 'constructor'], admin, deps: world().deps });
    assert.deepStrictEqual(out.results.map(result => result.outcome), ['not_found', 'not_found']);

    // Offline worker: failure is reported (and redacted) but the route is still removed.
    const dead = new FakeNode('dead', { autoSpawned: false, removeError: `connect ECONNREFUSED ${LONG_JWT} ?token=abc123 secret` });
    w = world({ routes: { gone: route(dead) } });
    out = await removeTasks({ uuids: ['gone'], admin, deps: w.deps });
    assert.match(out.results[0].steps.workerRemove, /^failed: /);
    assert.ok(!out.results[0].steps.workerRemove.includes(LONG_JWT) && !out.results[0].steps.workerRemove.includes('abc123'));
    assert.strictEqual(out.results[0].steps.routeRemoved, true);
    assert.strictEqual(out.results[0].outcome, 'removed');

    // Pending task: Tapis cancel is awaited before the table record is taken; abort and tmp cleanup follow.
    w = world({ summaries: [summary('p1')], pendings: { p1: { taskId: 'p1', tapisJobId: 'tj1', tapisJobOwner: 'ann', tapisJobOwnerTenant: 'portals' } } });
    out = await removeTasks({ uuids: ['p1'], admin, deps: w.deps });
    assert.deepStrictEqual(w.events.slice(0, 4), ['cancel p1', 'take p1', 'abort p1', 'rmdir tmp/p1']);
    assert.strictEqual(out.results[0].steps.pendingCancelled, true);
    assert.strictEqual(out.results[0].steps.tasktableRemoved, true);

    // A uuid that is really a Tapis job id or job name must never cancel that job.
    w = world({ pendings: { 'tapis-job-uuid': { taskId: 'someone-elses-task', tapisJobId: 'tapis-job-uuid' } } });
    out = await removeTasks({ uuids: ['tapis-job-uuid'], admin, deps: w.deps });
    assert.strictEqual(out.results[0].outcome, 'not_found');
    assert.ok(!w.events.some(event => event.startsWith('cancel')));
}

async function testStopWorker() {
    const tokens = (...nodes) => Object.fromEntries(nodes.map(node => [node.jobId, 'owner-token']));

    // Idle auto-spawned worker: locked, cancelled via destroyNode, removed from the registry.
    let idle = new FakeNode('idle');
    let w = world({ routes: { a: route(idle), b: route(idle) }, tokens: tokens(idle) });
    let out = await removeTasks({ uuids: ['a', 'b'], stopWorker: true, admin, deps: w.deps });
    assert.deepStrictEqual(w.destroyed, ['idle'], 'two tasks on one worker stop it once');
    assert.deepStrictEqual(out.results.map(result => result.steps.workerStopped), ['cancelled', 'cancelled']);
    assert.ok(w.events.includes('nodes.remove idle') && w.events.includes('nodes.save'));
    assert.strictEqual(idle.lockLog[0], true);

    // Busy workers are left alone and unlocked again: queue, in-flight reservation, other routes.
    for (const [label, node] of [['queue', new FakeNode('q', { queue: 2 })], ['transients', new FakeNode('t', { transients: 1 })]]) {
        w = world({ routes: { a: route(node) }, tokens: tokens(node) });
        out = await removeTasks({ uuids: ['a'], stopWorker: true, admin, deps: w.deps });
        assert.strictEqual(out.results[0].steps.workerStopped, 'skipped: worker busy', label);
        assert.deepStrictEqual(w.destroyed, []);
        assert.strictEqual(node.isLocked(), false, `${label}: lock released`);
    }
    const shared = new FakeNode('shared');
    w = world({ routes: { a: route(shared), other: route(shared, jwtFor('bob')) }, tokens: tokens(shared) });
    out = await removeTasks({ uuids: ['a'], stopWorker: true, admin, deps: w.deps });
    assert.strictEqual(out.results[0].steps.workerStopped, 'skipped: worker busy', "another user's task keeps the worker alive");
    assert.deepStrictEqual(Object.keys(w.routeMap), ['other']);

    // Not auto-spawned: never stopped, even when idle.
    const manual = new FakeNode('manual', { autoSpawned: false });
    w = world({ routes: { a: route(manual) } });
    out = await removeTasks({ uuids: ['a'], stopWorker: true, admin, deps: w.deps });
    assert.strictEqual(out.results[0].steps.workerStopped, 'skipped: not auto-spawned');

    // stopWorker false leaves the worker running.
    idle = new FakeNode('keep');
    w = world({ routes: { a: route(idle) }, tokens: tokens(idle) });
    out = await removeTasks({ uuids: ['a'], admin, deps: w.deps });
    assert.strictEqual(out.results[0].steps.workerStopped, null);
    assert.deepStrictEqual(w.destroyed, []);

    // Tapis cancel outcomes map to distinct results.
    const refused = new FakeNode('refused');
    const nokey = new FakeNode('nokey');
    w = world({ routes: { r1: route(refused), r2: route(nokey) }, tokens: { [refused.jobId]: 'refused' } });
    out = await removeTasks({ uuids: ['r1', 'r2'], stopWorker: true, admin, deps: w.deps });
    assert.deepStrictEqual(out.results.map(result => result.steps.workerStopped), ['cancel_failed', 'unreachable']);

    // Non-Tapis auto-spawned nodes go through the generic cleanup.
    const plain = new FakeNode('plain', { jobId: null });
    w = world({ routes: { a: route(plain) } });
    out = await removeTasks({ uuids: ['a'], stopWorker: true, admin, deps: w.deps });
    assert.strictEqual(out.results[0].steps.workerStopped, 'removed');
    assert.ok(w.events.includes('cleanup plain'));

    // At most 10 distinct workers per request.
    const many = Array.from({ length: 11 }, (_, index) => new FakeNode(`m${index}`));
    w = world({ routes: Object.fromEntries(many.map((node, index) => [`k${index}`, route(node)])), tokens: tokens(...many) });
    out = await removeTasks({ uuids: many.map((_, index) => `k${index}`), stopWorker: true, admin, deps: w.deps });
    assert.strictEqual(w.destroyed.length, 10);
    assert.strictEqual(out.results.filter(result => result.steps.workerStopped === 'skipped: worker cap').length, 1);
}

async function testDryRunAndAudit() {
    const worker = new FakeNode('dry');
    const w = world({ routes: { d1: route(worker) }, summaries: [summary('d2')],
        pendings: { d2: { taskId: 'd2', tapisJobId: 'tj' } }, tokens: { [worker.jobId]: 'owner-token' } });
    const out = await removeTasks({ uuids: ['d1', 'd2'], stopWorker: true, dryRun: true, admin, deps: w.deps });
    assert.strictEqual(out.dryRun, true);
    assert.deepStrictEqual(w.events, [], 'dry run must not mutate, cancel, persist or call a worker');
    assert.deepStrictEqual(worker.removed, []);
    assert.strictEqual(worker.isLocked(), false, 'dry run leaves the lock as found');
    assert.strictEqual(out.results[0].steps.wouldStopWorker, true);
    assert.strictEqual(out.results[0].steps.routeRemoved, true);
    assert.strictEqual(out.results[1].steps.pendingCancelled, true);
    assert.ok(!('workerStopped' in out.results[0].steps));

    // Audit lines name the admin and owner, never credentials.
    const secretNode = new FakeNode('audit', { autoSpawned: false, removeError: `boom ${LONG_JWT} ?token=hunter2` });
    const audited = world({ routes: { z: route(secretNode, jwtFor('ann')) } });
    await removeTasks({ uuids: ['z'], admin, deps: audited.deps });
    assert.strictEqual(audited.lines.length, 1);
    assert.match(audited.lines[0], /^\[ADMIN\] task remove \{/);
    const record = JSON.parse(audited.lines[0].slice('[ADMIN] task remove '.length));
    assert.strictEqual(record.admin, 'op@portals');
    assert.strictEqual(record.owner, 'ann@portals');
    assert.strictEqual(record.remoteAddress, '10.0.0.1');
    assert.ok(!audited.lines[0].includes(LONG_JWT) && !audited.lines[0].includes('hunter2') && !/token=/i.test(audited.lines[0]));
    assert.ok(!audited.lines[0].includes(jwtFor('ann')));
    assert.ok(!audited.lines[0].includes('Flight'), 'task names are user controlled and not logged');
}

function testValidation() {
    const ok = parseRemoveRequest({ uuids: ['a', 'a', 'b'], stopWorker: true, dryRun: false });
    assert.deepStrictEqual(ok, { uuids: ['a', 'b'], stopWorker: true, dryRun: false });
    assert.deepStrictEqual(parseRemoveRequest({ uuids: ['a'] }), { uuids: ['a'], stopWorker: false, dryRun: false });
    for (const body of [null, [], 'x', {}, { uuids: [] }, { uuids: 'a' }, { uuids: [1] }, { uuids: ['has space'] }, { uuids: ['../x'] },
        { uuids: ['a'.repeat(65)] }, { uuids: Array.from({ length: 26 }, (_, i) => `t${i}`) },
        { uuids: ['a'], stopWorker: 'yes' }, { uuids: ['a'], dryRun: 1 }]) {
        assert.ok(parseRemoveRequest(body).error, JSON.stringify(body));
    }
    assert.strictEqual(parseRemoveRequest({ uuids: Array.from({ length: 25 }, (_, i) => `t${i}`) }).uuids.length, 25);
    assert.ok(sanitizeError(new Error(`x${'y'.repeat(500)}`)).length <= 200);
    assert.ok(!sanitizeError(`bad\u0000\nline ${LONG_JWT}`).match(/[\u0000\n]/));
    assert.strictEqual(isNodeBusy(new FakeNode('n'), 0), false);
    assert.strictEqual(isNodeBusy(new FakeNode('n'), 1), true);
    assert.strictEqual(isNodeBusy(new FakeNode('n', { queue: 1 }), 0), true);
    assert.strictEqual(isNodeBusy(new FakeNode('n', { transients: 1 }), 0), true);
    // Node links carry the worker token only when built for an admin; bad addresses give no link.
    assert.strictEqual(nodeUrlWithToken(new FakeNode('w', { token: 'tok' })), 'http://w.example:3001/?token=tok');
    assert.strictEqual(nodeUrlWithToken(new FakeNode('w', { token: '' })), 'http://w.example:3001/');
    assert.strictEqual(nodeUrlWithToken({ hostname: () => 'bad host', port: () => 3001 }), null);
    assert.strictEqual(nodeUrlWithToken({ hostname: () => 'h', port: () => 99999 }), null);
    assert.strictEqual(nodeUrlWithToken(null), null);
    assert.strictEqual(nodeUrlWithToken({ hostname: () => 'h.example', port: () => 443, getToken: () => 'a&b' }), 'https://h.example/?token=a%26b');
}

const call = (port, { method = 'POST', path, headers = {}, body }) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path,
        headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
});
const close = server => new Promise(resolve => server.close(resolve));

async function testHttp() {
    const saved = { nth: nodes.nth, list: tasktable.listSummaries, take: tasktable.take, find: routetable.findByNode,
        remove: routetable.remove, save: routetable.saveToDisk, get: asrProvider.get, warn: logger.warn, info: logger.info };
    const warnings = [];
    const infos = [];
    logger.warn = line => warnings.push(String(line));
    logger.info = line => infos.push(String(line));
    const node = new FakeNode('open-me', { autoSpawned: false, token: 'worker-secret-token' });
    let gate = null;
    const pending = { taskId: 'held', tapisJobId: 'tj-held' };
    tasktable.listSummaries = async () => [];
    tasktable.take = async () => null;
    routetable.findByNode = async () => ({});
    routetable.remove = async () => false;
    routetable.saveToDisk = async () => {};
    nodes.nth = number => Number(number) === 1 ? node : null;
    asrProvider.get = () => ({
        findPendingTask: key => key === 'held' ? pending : null,
        cancelPendingTask: async () => { await gate; return true; }
    });
    const operatorJwt = jwtFor('operator');
    const validate = async token => { if (token !== operatorJwt) { const error = new Error('nope'); error.response = { status: 401 }; throw error; } };
    const servers = [];
    try {
        // JWT mode with no allowlists: sign-in works but every dangerous action fails closed.
        const open = await adminweb.create({ port: 0, useTapisJwt: true, tapisProvider: { validateToken: validate } });
        servers.push(open);
        const openPort = open.address().port;
        assert.ok(warnings.some(line => /no admin-web-allowed/.test(line)), 'startup warning when JWT mode has no allowlist');
        const bearer = { authorization: `Bearer ${operatorJwt}` };
        for (const path of ['/r/task/remove', '/r/node/open']) {
            const denied = await call(openPort, { path, headers: bearer, body: { uuids: ['a'], number: 1 } });
            assert.strictEqual(denied.status, 403, path);
            assert.match(denied.json().error, /admin-web-allowed/);
            assert.strictEqual(denied.headers['cache-control'], 'no-store');
        }
        warnings.length = 0;
        const anon = await call(openPort, { path: '/r/task/remove', body: { uuids: ['a'] } });
        assert.strictEqual(anon.status, 401);
        assert.ok(warnings.some(line => /\[ADMIN\] denied POST \/r\/task\/remove/.test(line)), 'denied attempts are logged');
        assert.ok(!warnings.join('\n').includes(operatorJwt));

        // JWT mode with an allowlist.
        const jwtServer = await adminweb.create({ port: 0, useTapisJwt: true, allowedUsers: ['operator'], tapisProvider: { validateToken: validate } });
        servers.push(jwtServer);
        const port = jwtServer.address().port;
        const post = (path, body, headers = bearer) => call(port, { path, headers, body });

        assert.strictEqual((await post('/r/task/remove', { uuids: [] })).status, 400);
        assert.strictEqual((await post('/r/task/remove', { uuids: ['a b'] })).status, 400);
        assert.strictEqual((await post('/r/task/remove', { uuids: Array.from({ length: 26 }, (_, i) => `t${i}`) })).status, 400);
        assert.strictEqual((await post('/r/task/remove', 'uuids=a', { ...bearer, 'content-type': 'text/plain' })).status, 400, 'non-JSON bodies are rejected');
        const dry = await post('/r/task/remove', { uuids: ['ghost'], dryRun: true });
        assert.strictEqual(dry.status, 200);
        assert.strictEqual(dry.headers['cache-control'], 'no-store');
        assert.deepStrictEqual(dry.json().results.map(result => result.outcome), ['not_found']);
        assert.ok(infos.some(line => /\[ADMIN\] task remove .*"admin":"operator@portals"/.test(line)), 'audit line names the validated admin');

        // Single-flight: a second request while one runs gets 409, then the lock clears.
        let release;
        gate = new Promise(resolve => { release = resolve; });
        tasktable.listSummaries = async () => [{ uuid: 'held', name: 'held', statusCode: 20, owner: 'x@portals' }];
        const first = post('/r/task/remove', { uuids: ['held'] });
        await new Promise(resolve => setTimeout(resolve, 50));
        const second = await post('/r/task/remove', { uuids: ['other'] });
        assert.strictEqual(second.status, 409);
        release();
        assert.strictEqual((await first).status, 200);
        gate = null;
        assert.strictEqual((await post('/r/task/remove', { uuids: ['other'], dryRun: true })).status, 200, 'lock released after completion');
        tasktable.listSummaries = async () => [];

        // Open node: token only in this authenticated response, never in the node list.
        const opened = await post('/r/node/open', { number: 1 });
        assert.strictEqual(opened.status, 200);
        assert.strictEqual(opened.json().url, 'http://open-me.example:3001/?token=worker-secret-token');
        assert.strictEqual(opened.headers['cache-control'], 'no-store');
        assert.ok(!infos.concat(warnings).join('\n').includes('worker-secret-token'), 'worker token must not be logged');
        assert.ok(infos.some(line => /\[ADMIN\] node open/.test(line)));
        assert.strictEqual((await post('/r/node/open', { number: 9 })).status, 404);
        assert.strictEqual((await call(port, { path: '/r/node/open', body: { number: 1 } })).status, 401);

        // Basic mode needs an explicit same-origin signal because browsers attach credentials automatically.
        const basicServer = await adminweb.create({ port: 0, password: 'pw' });
        servers.push(basicServer);
        const basic = { authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}` };
        const basicPort = basicServer.address().port;
        assert.strictEqual((await call(basicPort, { path: '/r/task/remove', headers: basic, body: { uuids: ['a'] } })).status, 403);
        assert.strictEqual((await call(basicPort, { path: '/r/task/remove', headers: { ...basic, 'sec-fetch-site': 'cross-site' }, body: { uuids: ['a'] } })).status, 403);
        assert.strictEqual((await call(basicPort, { path: '/r/task/remove', headers: { ...basic, 'sec-fetch-site': 'same-origin' }, body: { uuids: ['ghost'], dryRun: true } })).status, 200);
        assert.strictEqual((await call(basicPort, { path: '/r/task/remove', headers: { ...basic, origin: `http://127.0.0.1:${basicPort}` }, body: { uuids: ['ghost'], dryRun: true } })).status, 200);
        assert.strictEqual((await call(basicPort, { path: '/r/task/remove', body: { uuids: ['a'] } })).status, 401);
        assert.ok(infos.some(line => /\[ADMIN\] task remove .*"admin":"basic"/.test(line)));
    } finally {
        for (const server of servers) await close(server);
        Object.assign(nodes, { nth: saved.nth });
        Object.assign(tasktable, { listSummaries: saved.list, take: saved.take });
        Object.assign(routetable, { findByNode: saved.find, remove: saved.remove, saveToDisk: saved.save });
        asrProvider.get = saved.get;
        logger.warn = saved.warn;
        logger.info = saved.info;
    }
}

async function testTables() {
    // routetable.remove is a safe no-op before initialisation and for unknown ids.
    assert.strictEqual(await routetable.remove('missing', { persist: false }), false);
    // tasktable.take hands back the record, removes it, and does not renew retention.
    // initialize() starts an hourly cleanup timer that would keep the process alive.
    const realSetInterval = global.setInterval;
    global.setInterval = () => 1;
    try { await tasktable.initialize(); } finally { global.setInterval = realSetInterval; }
    await tasktable.add('taken', { taskInfo: { name: 'T' }, abort: () => {} }, 'tok');
    const entry = await tasktable.take('taken');
    assert.strictEqual(entry.taskInfo.name, 'T');
    assert.strictEqual(await tasktable.take('taken'), null);
    assert.strictEqual(await tasktable.take('__proto__'), null);
}

(async () => {
    await testRemoveFlow();
    await testStopWorker();
    await testDryRunAndAudit();
    testValidation();
    await testTables();
    await testHttp();
    console.log('ADMIN TASK REMOVE TEST PASSED');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
