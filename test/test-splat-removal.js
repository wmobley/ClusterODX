'use strict';
// Splat records must be removable (admin delete) and expire (vacuum) once finished; active ones must be kept.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {SplatTasks} = require('../libs/splatTasks');
const {SplatTaskStore} = require('../libs/splatTaskStore');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-removal-'));
    const store = new SplatTaskStore(dir);
    const service = Object.create(SplatTasks.prototype);
    service.config = {retentionDays: 7};
    service.store = store;
    service.sessions = new Map();
    service.operations = new Map();
    const now = Date.now();
    const id = n => `00000000-0000-4000-8000-00000000000${n}`;
    const add = (n, extra) => store.save(Object.assign({version: 1, uuid: id(n), run_id: `run-${n}`, owner: {username: 'u', tenant: 't'},
        state: 'running', lease_expires_at: now + 3600e3}, extra));
    add(1, {state: 'failed'});                       // terminal
    add(2, {lease_expires_at: now - 1000});          // lease ran out, never finished
    add(3, {lease_expires_at: now + 30 * 86400e3});  // active
    assert.deepStrictEqual(service.adminList().map(r => [r.uuid, r.removable]).sort(), [[id(1), true], [id(2), true], [id(3), false]]);

    await assert.rejects(service.removeRecord(id(3)), e => e.status === 409 && e.code === 'not_removable');
    await assert.rejects(service.removeRecord(id(9)), e => e.status === 404);
    assert.deepStrictEqual(await service.removeRecord(id(1)), {success: true, uuid: id(1)});
    assert.ok(!fs.existsSync(path.join(dir, `${id(1)}.json`)), 'record file unlinked');

    // Vacuum: recent finished records stay, stale ones go, active ones never go.
    assert.strictEqual(service.vacuum(now), 0);
    assert.strictEqual(service.vacuum(now + 8 * 86400e3), 1);
    assert.ok(!store.get(id(2)) && store.get(id(3)), 'only the finished record expired');
    store.close();
    const reopened = new SplatTaskStore(dir);
    assert.deepStrictEqual(reopened.all().map(r => r.uuid), [id(3)], 'deletes survive a restart');
    reopened.close();
    fs.rmSync(dir, {recursive: true, force: true});
    console.log('splat removal ok');
})().catch(error => { console.error(error); process.exit(1); });
