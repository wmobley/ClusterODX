'use strict';
// The admin page lists NodeSplat workers separately from NodeODX nodes and must never expose credentials.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {SplatTasks} = require('../libs/splatTasks');

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const read = file => fs.readFileSync(require.resolve(file), 'utf8');
const children = node => node && typeof node === 'object' ? node.props.children : [];
const text = node => Array.isArray(node) ? node.map(text).join('')
    : node && typeof node === 'object' ? text(children(node))
    : typeof node === 'string' || typeof node === 'number' ? String(node) : '';

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-admin-'));
    const service = Object.create(SplatTasks.prototype);
    const record = (uuid, extra) => Object.assign({version: 1, uuid, run_id: `run-${uuid}`, owner: {username: 'wmobley', tenant: 'portals'},
        state: 'running', phase: 'Training', tapis_job_uuid: `job-${uuid}`, api_hash: 'secret-hash', grant_hash: 'grant-secret',
        settings: {iterations: 100}, updated_at: '2026-11-03T10:00:00.000Z'}, extra);
    const rows = [
        record('a', {worker_url: 'http://c301-001.ls6.tacc.utexas.edu:3101/', last_heartbeat: 1}),
        record('b', {updated_at: '2026-11-03T11:00:00.000Z', state: 'queued', worker_url: null})
    ];
    service.store = {all: () => rows};
    service.sessions = new Map([['a', 'worker-token']]);

    const list = service.adminList();
    assert.deepStrictEqual(list.map(r => r.uuid), ['b', 'a'], 'newest first');
    assert.strictEqual(list[1].worker, 'c301-001.ls6.tacc.utexas.edu:3101');
    assert.strictEqual(list[1].registered, true);
    assert.strictEqual(list[0].registered, false);
    assert.strictEqual(list[0].worker, null);
    const serialized = JSON.stringify(list);
    for (const secret of ['secret-hash', 'grant-secret', 'worker-token', 'iterations']) assert.ok(!serialized.includes(secret), secret);

    const { default: htm } = await import(moduleUrl(read('../public/lib/htm.module.js')));
    global.__ui = {html: htm.bind((type, props, ...values) => ({type, props: {...props, children: values}}))};
    const loader = file => read(file).replace(/^import \{ html \}.*;\r?$/m, 'const { html } = globalThis.__ui;')
        .replace(/^import \{ formatTaskDate \}.*;\r?$/m, 'const formatTaskDate = value => (typeof value === "number" ? "date" : "—");');
    const {SplatList} = await import(moduleUrl(loader('../public/component/splatList.mjs')));
    assert.match(text(SplatList({})), /No NodeSplat workers/);
    const rendered = text(SplatList({workers: list}));
    assert.match(rendered, /NodeSplat Workers/);
    assert.match(rendered, /Registered/);
    assert.match(rendered, /Not registered/);
    assert.match(rendered, /c301-001\.ls6\.tacc\.utexas\.edu:3101/);
    fs.rmSync(root, {recursive: true, force: true});
    console.log('admin splat list ok');
})().catch(error => { console.error(error); process.exit(1); });
