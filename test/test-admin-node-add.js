const assert = require('assert');
const http = require('http');
const fs = require('fs');
const adminweb = require('../adminweb');
const nodes = require('../libs/nodes');

const request = (port, body, authenticated = true) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
        hostname: '127.0.0.1', port, path: '/r/node/add', method: 'POST',
        headers: {
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
            ...(authenticated ? { Authorization: `Basic ${Buffer.from('admin:test-password').toString('base64')}` } : {})
        }
    }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
            try {
                resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
            } catch (error) {
                reject(error);
            }
        });
    });
    req.on('error', reject);
    req.end(data);
});

async function testApi() {
    const original = nodes.addUnique;
    const calls = [];
    let duplicate = false;
    let refreshed = 0;
    nodes.addUnique = (...args) => {
        calls.push(args);
        return duplicate ? false : { updateInfo() { refreshed++; } };
    };
    const server = await adminweb.create({ port: 0, password: 'test-password' });
    try {
        const port = server.address().port;
        const payload = { hostname: 'ls6.tacc.utexas.edu', port: 60191, token: 'test-worker-token' };
        for (const hostname of [undefined, null, {}, '', 'https://ls6.tacc.utexas.edu',
            'http://ls6.tacc.utexas.edu', 'ls6.tacc.utexas.edu:60191', 'host/path',
            'host?token=secret', 'user@host', 'host#fragment', 'bad host', 'host\\path']) {
            const result = await request(port, { ...payload, hostname });
            assert.strictEqual(result.status, 400);
            assert.match(result.body.error, /hostname or IP address only/);
        }
        for (const invalidPort of [undefined, null, '', 0, 65536, -1, 3.5, 'abc', true, []]) {
            const result = await request(port, { ...payload, port: invalidPort });
            assert.strictEqual(result.status, 400);
            assert.match(result.body.error, /port between 1 and 65535/);
        }
        assert.strictEqual(calls.length, 0, 'invalid endpoints must not reach node storage');
        const unauthenticated = await request(port, payload, false);
        assert.strictEqual(unauthenticated.status, 401);
        assert.strictEqual(calls.length, 0);
        for (const hostname of [' ls6.tacc.utexas.edu ', '127.0.0.1', '::1']) {
            const result = await request(port, { ...payload, hostname, port: '60191' });
            assert.strictEqual(result.status, 200);
            assert.strictEqual(result.body.success, true);
            assert.deepStrictEqual(calls[calls.length - 1], [hostname.trim(), 60191, payload.token]);
        }
        assert.strictEqual(refreshed, 3);
        duplicate = true;
        const result = await request(port, payload);
        assert.strictEqual(result.status, 409);
        assert.match(result.body.error, /already exists/);
    } finally {
        nodes.addUnique = original;
        await new Promise(resolve => server.close(resolve));
    }
}

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const read = path => fs.readFileSync(require.resolve(path), 'utf8');
const descendants = node => Array.isArray(node) ? node.flatMap(descendants)
    : node && typeof node === 'object' ? [node, ...descendants(node.props.children)] : [];

async function testForm() {
    const { default: htm } = await import(moduleUrl(read('../public/lib/htm.module.js')));
    const html = htm.bind((type, props, ...children) => ({ type, props: { ...props, children } }));
    const slots = [];
    let cursor = 0;
    let refreshes = 0;
    let reply;
    const fields = {
        '#hostname': { value: 'https://ls6.tacc.utexas.edu' },
        '#port': { value: '60191' }, '#token': { value: 'test-worker-token' }
    };
    const event = { currentTarget: { closest: () => ({ querySelector: id => fields[id] }) } };
    const AddInstanceDialog = () => {};
    global.__nodeAdd = {
        html, AddInstanceDialog,
        useState(initial) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = initial;
            return [slots[index], value => { slots[index] = value; }];
        },
        postFetch: async () => {
            if (reply instanceof Error) throw reply;
            return reply;
        }
    };
    try {
        const source = read('../public/component/addInstanceButton.mjs')
            .replace(/^import .*;\r?$/gm, '');
        const { AddInstanceButton } = await import(moduleUrl(
            'const { html, AddInstanceDialog, useState, postFetch } = globalThis.__nodeAdd;\n' + source));
        const render = () => {
            cursor = 0;
            return descendants(AddInstanceButton({ getNodes() { refreshes++; } }));
        };
        render().find(node => node.type === 'button').props.onClick();
        const dialog = () => render().find(node => node.type === AddInstanceDialog).props;
        for (const failure of [
            { ok: false, json: async () => ({ error: 'Enter a hostname only.' }) },
            { ok: true, json: async () => ({ error: 'Node already exists.' }) },
            new Error('Network unavailable')
        ]) {
            reply = failure;
            await dialog().handlerApply(event);
            assert.strictEqual(dialog().open, true);
            assert.ok(dialog().error);
            assert.strictEqual(fields['#hostname'].value, 'https://ls6.tacc.utexas.edu');
            assert.strictEqual(fields['#token'].value, 'test-worker-token');
            assert.strictEqual(refreshes, 0);
        }
        fields['#hostname'].value = 'ls6.tacc.utexas.edu';
        reply = { ok: true, json: async () => ({ success: true }) };
        await dialog().handlerApply(event);
        assert.strictEqual(dialog().open, false);
        assert.strictEqual(dialog().error, '');
        assert.strictEqual(refreshes, 1);
        assert.ok(Object.values(fields).every(field => field.value === ''));

        const dialogSource = read('../public/component/dialog.mjs').replace(/^import .*;\r?$/gm, '');
        const dialogs = await import(moduleUrl('const { html } = globalThis.__nodeAdd;\n' + dialogSource));
        const rendered = dialogs.AddInstanceDialog({ error: 'Enter a hostname only.' });
        const alert = descendants(rendered.props.modalBody).find(node => node.props.role === 'alert');
        assert.ok(alert, 'the error must be visible in the dialog');
        assert.deepStrictEqual(alert.props.children, ['Enter a hostname only.']);
    } finally {
        delete global.__nodeAdd;
    }
}

(async () => {
    await testApi();
    await testForm();
    console.log('ADMIN NODE ADD TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
