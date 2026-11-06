'use strict';

// GET /task/<uuid>/tapis answers which Tapis job runs (or ran) a task: from the live
// worker while it is routed, else from the job registry; only the owning token may ask.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const config = require('../config');
const utils = require('../libs/utils');

const UUID = '9ef37fe9-807c-45da-9276-63dc6ee96ab1';
const OTHER = '1ef37fe9-807c-45da-9276-63dc6ee96ab2';
const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
const close = server => new Promise(resolve => server.close(resolve));

const get = (port, uuid, token) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: `/task/${uuid}/tapis?token=${token}`, method: 'GET' }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
            try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
            catch (error) { reject(error); }
        });
    });
    req.setTimeout(2000, () => req.destroy(new Error('Tapis lookup request timed out')));
    req.on('error', reject);
    req.end();
});

(async () => {
    let routed = true;
    const node = { getToken: () => 'worker-token', proxyTargetUrl: () => 'http://127.0.0.1:1', getTapisJobId: () => 'live-job-uuid' };
    const record = { jobName: 'nodeodx-abc', taskId: UUID, tapisJobId: 'registry-job-uuid', state: 'done',
        queue: 'normal', nodeCount: 2, maxMinutes: 360, submittedAt: 1700000000000 };
    const mocks = {
        '../config': { ...config, use_ssl: false, debug: false },
        './taskNew': {},
        './classes/ValueCache': class {},
        './utils': { ...utils, cleanupTemporaryDirectory() {}, rmdir() {} },
        './accessLog': () => {},
        './logger': { warn() {}, info() {}, error() {}, debug() {} },
        './routetable': {
            initialize: async () => {},
            lookupNode: async uuid => routed && uuid === UUID ? node : null,
            lookupToken: async uuid => uuid === UUID ? 'owner-token' : null
        },
        './tasktable': { initialize: async () => {}, lookup: async () => null, add: async () => {}, delete: async () => {} },
        './concurrencyMonitor': { decreaseCount() {} },
        './asrProvider': {
            initialize: async () => {},
            get: () => ({ registry: { get: id => (id === UUID ? record : null) }, getDriverName: () => 'tapis' }),
            downloadsPath: () => null,
            onCommit: async () => {},
            cleanup: async () => {}
        }
    };
    const filename = require.resolve('../libs/proxy');
    const loaded = new Module(filename, module);
    const realRequire = Module.createRequire(filename);
    loaded.filename = filename;
    loaded.paths = module.paths;
    loaded.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : realRequire(name);
    loaded._compile('const setInterval = () => {};\n' + fs.readFileSync(filename, 'utf8'), filename);
    const servers = await loaded.exports.initialize({
        validate: async token => ({ valid: ['owner-token', 'other-token'].indexOf(token) !== -1, limits: {} })
    });
    const server = servers[0].server;
    try {
        await listen(server);
        const port = server.address().port;

        // Live worker wins.
        let result = await get(port, UUID, 'owner-token');
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.body.tapisJobId, 'live-job-uuid');
        assert.strictEqual(result.body.jobName, 'nodeodx-abc');
        assert.strictEqual(result.body.queue, 'normal');
        assert.strictEqual(result.body.nodeCount, 2);
        assert.strictEqual(result.body.maxMinutes, 360);

        // Worker gone: the registry answers.
        routed = false;
        result = await get(port, UUID, 'owner-token');
        assert.strictEqual(result.body.tapisJobId, 'registry-job-uuid');
        assert.strictEqual(result.body.state, 'done');
        assert.strictEqual(result.body.submittedAt, 1700000000000);

        // A valid token that does not own the task learns nothing.
        result = await get(port, UUID, 'other-token');
        assert.match(result.body.error, /no task found for this token/);
        assert.strictEqual(result.body.tapisJobId, undefined);

        // Unknown task.
        result = await get(port, OTHER, 'owner-token');
        assert.match(result.body.error, /no task found for this token/);

        console.log('TASK TAPIS LOOKUP TEST PASSED');
    } finally {
        await close(server);
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
