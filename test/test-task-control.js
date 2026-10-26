'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const config = require('../config');
const utils = require('../libs/utils');
const statusCodes = require('../libs/statusCodes');

const UUID = '9ef37fe9-807c-45da-9276-63dc6ee96ab1';
const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
const close = server => new Promise(resolve => server.close(resolve));

const post = (port, action, body, contentType, token = 'owner-token') => new Promise((resolve, reject) => {
    const req = http.request({
        hostname: '127.0.0.1', port, path: `/task/${action}?token=${token}`, method: 'POST',
        headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
            try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
            catch (error) { reject(error); }
        });
    });
    req.setTimeout(2000, () => req.destroy(new Error('Task control request timed out')));
    req.on('error', reject);
    req.end(body);
});

(async () => {
    const forwarded = [];
    const pending = new Map();
    const cleanups = [];
    const warnings = [];
    let aborts = 0;
    let decreases = 0;
    let routed = false;
    const worker = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            forwarded.push({ url: req.url, type: req.headers['content-type'], body });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
    });
    await listen(worker);
    const node = { getToken: () => 'worker-token', proxyTargetUrl: () => `http://127.0.0.1:${worker.address().port}` };
    const mocks = {
        '../config': { ...config, use_ssl: false, debug: false },
        './taskNew': {}, // Task creation/native Curl is not involved in control requests.
        './classes/ValueCache': class {},
        './utils': { ...utils, cleanupTemporaryDirectory() {}, rmdir: dir => cleanups.push(dir) },
        './accessLog': () => {},
        './logger': { warn: message => warnings.push(message), info() {} },
        './routetable': { initialize: async () => {}, lookupNode: async uuid => routed && uuid === UUID ? node : null },
        './tasktable': {
            initialize: async () => {}, lookup: async uuid => pending.get(uuid),
            add: async (uuid, record) => pending.set(uuid, record), delete: async uuid => pending.delete(uuid)
        },
        './concurrencyMonitor': { decreaseCount() { decreases++; } }
    };
    const filename = require.resolve('../libs/proxy');
    const loaded = new Module(filename, module);
    const realRequire = Module.createRequire(filename);
    loaded.filename = filename;
    loaded.paths = module.paths;
    loaded.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : realRequire(name);
    loaded._compile('const setInterval = () => {};\n' + fs.readFileSync(filename, 'utf8'), filename);
    const servers = await loaded.exports.initialize({ validate: async token => ({ valid: token === 'owner-token', limits: {} }) });
    const server = servers[0].server;
    try {
        await listen(server);
        const port = server.address().port;
        const seed = () => pending.set(UUID, {
            taskInfo: { status: { code: statusCodes.RUNNING } }, abort() { aborts++; }
        });

        seed();
        let result = await post(port, 'cancel', JSON.stringify({ uuid: UUID }), 'application/json; charset=utf-8');
        assert.deepStrictEqual(result, { status: 200, body: { success: true } });
        assert.strictEqual(aborts, 1);
        assert.strictEqual(pending.get(UUID).taskInfo.status.code, statusCodes.CANCELED);
        assert.deepStrictEqual(cleanups, [`tmp/${UUID}`]);

        seed();
        result = await post(port, 'remove', JSON.stringify({ uuid: UUID }), 'application/json');
        assert.strictEqual(result.body.success, true);
        assert.strictEqual(pending.has(UUID), false);
        assert.strictEqual(aborts, 2);

        seed();
        result = await post(port, 'restart', JSON.stringify({ uuid: UUID }), 'application/json');
        assert.match(result.body.error, /Please create a new task/);
        assert.strictEqual(aborts, 2);

        routed = true;
        for (const action of ['cancel', 'restart', 'remove']) {
            const body = JSON.stringify({ uuid: UUID, options: '[{"name":"dsm","value":true}]' });
            result = await post(port, action, body, 'application/json');
            assert.strictEqual(result.body.success, true);
            assert.deepStrictEqual(forwarded[forwarded.length - 1], {
                url: `/task/${action}?token=worker-token`, type: 'application/json', body
            });
        }
        const forms = [
            { type: 'application/x-www-form-urlencoded', body: `uuid=${UUID}` },
            { type: 'multipart/form-data; boundary=task-control-test',
                body: `--task-control-test\r\nContent-Disposition: form-data; name="uuid"\r\n\r\n${UUID}\r\n--task-control-test--\r\n` }
        ];
        for (const form of forms) {
            result = await post(port, 'cancel', form.body, form.type);
            assert.strictEqual(result.body.success, true);
            assert.strictEqual(forwarded[forwarded.length - 1].body, form.body);
            assert.strictEqual(forwarded[forwarded.length - 1].type, form.type);
        }

        const before = { forwards: forwarded.length, decreases, cleanups: cleanups.length };
        for (const [body, type] of [['{broken', 'application/json'], ['uuid=x', 'text/plain'], ['x', 'multipart/form-data']]) {
            result = await post(port, 'cancel', body, type);
            assert.strictEqual(result.status, 400);
            assert.deepStrictEqual(result.body, { error: 'Invalid task control request body' });
        }
        for (const payload of [{}, { uuid: {} }, null]) {
            result = await post(port, 'cancel', JSON.stringify(payload), 'application/json');
            assert.match(result.body.error, /No uuid found/);
        }
        result = await post(port, 'cancel', JSON.stringify({ uuid: UUID }), 'application/json', 'invalid-token');
        assert.strictEqual(result.status, 401);
        assert.deepStrictEqual({ forwards: forwarded.length, decreases, cleanups: cleanups.length }, before);
        assert.deepStrictEqual(warnings, [], 'valid JSON and rejected input must not hit the exception handler');
        console.log('TASK CONTROL TEST PASSED');
    } finally {
        await close(server);
        await close(worker);
    }
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
