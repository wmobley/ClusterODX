'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const config = require('../config');
const Node = require('../libs/classes/Node');
const utils = require('../libs/utils');
const statusCodes = require('../libs/statusCodes');

const TASK_ID = 'e0ad8aa1-a44f-4311-8517-f28846bfabae';
const INPUT = '/corral/webodm/media/project/9/task/images';

// Only replace external effects. Exercise the actual task submission/options/path
// logic without the optional native libcurl binding or a live processing worker.
function fixture({ rejectStage = null, switchWorker = false, fileCount = 0, pathImport = INPUT, v1 = false, parentToken = 'task-owner-token', crossAllocation = false, capable = true, spoof = false, accepted = false } = {}) {
    const requests = [];
    const records = new Map();
    const routes = [];
    const cleanups = [];
    const cancellations = [];
    const output = [];
    const workers = ['worker-a', 'worker-b'].map(hostname => new Node(hostname, 3001, 'worker-token'));
    workers.forEach(worker => { worker.nodeData.info = { maxParallelTasks: 1, taskQueueCount: 0 }; });
    workers.forEach(worker => { worker.taskInfo = async () => accepted ? {uuid: TASK_ID, status: {code: statusCodes.RUNNING}} : {error: 'not found'}; worker.taskCancel = async uuid => { cancellations.push(uuid); return {success: true}; }; });
    workers.forEach(worker => { worker.isOnline = () => true; worker.nodeData.tapisJobUuid = crossAllocation ? 'other-job' : 'source-job'; worker.nodeData.info.capabilities = {shared_submodel_v1: capable}; });
    let selected = 0;
    let rejected = false;
    let response;

    class Curl extends EventEmitter {
        static option = {
            URL: 'url', HTTPPOST: 'body', HTTPHEADER: 'headers',
            LOW_SPEED_TIME: 'lowSpeedTime', LOW_SPEED_LIMIT: 'lowSpeedLimit'
        };
        constructor() { super(); this.options = {}; }
        setOpt(key, value) { this.options[key] = value; }
        close() {}
        perform() {
            const url = new URL(this.options.url);
            const stage = url.pathname.split('/')[3];
            const fields = this.options.body;
            requests.push({ stage, hostname: url.hostname, fields, headers: this.options.headers, token: url.searchParams.get('token') });
            let body = stage === 'init' ? { uuid: TASK_ID } : { success: true };
            if (stage === rejectStage && (!switchWorker || !rejected)) {
                rejected = true;
                body = { error: 'Worker rejected task' };
            }
            setImmediate(() => this.emit('end', 200, JSON.stringify(body), {}));
        }
    }

    const mocks = {
        'node-libcurl': { Curl },
        './nodes': {
            updateInfo: async () => {},
            filter: predicate => workers.filter(predicate),
            findBestAvailableNode: async () => workers[switchWorker ? Math.min(selected++, 1) : 0]
        },
        './asrProvider': {
            get: () => ({ getDriverName: () => 'tapis' }),
            isAllowedToCreateNewNodes() { throw new Error('An available worker must not trigger autoscaling'); }
        },
        './utils': { ...utils, sleep: async () => {}, rmdir: directory => cleanups.push(directory) },
        './logger': { warn: message => output.push(message) },
        './tasktable': {
            add: async (uuid, record, token) => records.set(uuid, { ...record, token }),
            lookup: async uuid => records.get(uuid),
            delete: async uuid => records.delete(uuid)
        },
        './routetable': {
            lookup: async () => ({token: parentToken, node: {nodeData: {tapisJobUuid: 'source-job'}}}),
            add: async (uuid, node, token) => {
                assert.strictEqual(requests[requests.length - 1].stage, 'commit', 'route must follow commit');
                routes.push({ uuid, node, token });
            }
        }
    };
    const helperFile = require.resolve('../libs/sharedSubmodel');
    const helper = new Module(helperFile, module);
    helper.filename = helperFile;
    helper.paths = module.paths;
    const helperRequire = Module.createRequire(helperFile);
    helper.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : helperRequire(name);
    helper._compile(fs.readFileSync(helperFile, 'utf8'), helperFile);
    mocks['./sharedSubmodel'] = helper.exports;
    const filename = require.resolve('../libs/taskNew');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = module.paths;
    const realRequire = Module.createRequire(filename);
    loaded.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : realRequire(name);
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);

    const run = async () => {
        let timer;
        try {
            await Promise.race([
                loaded.exports.process({ headers: { host: 'cluster.example' } }, {
                    writeHead: code => assert.strictEqual(code, 200),
                    end: data => { response = JSON.parse(data); }
                }, { approveNewTask: async () => ({ approved: true }) }, TASK_ID, {
                    options: [], taskName: 'Flight', skipPostProcessing: v1 ? 'true' : true,
                    ...(v1 ? {shared_submodel_version: '1', seed_path: '/corral/webodm/media/seed.zip', parent_task_uuid: TASK_ID, attempt_id: TASK_ID, ...(spoof ? {shared_source_job_uuid: 'source-job'} : {})} : {}),
                    outputs: v1 ? '["all.zip"]' : 'all.zip', dateCreated: 1700000000000,
                    webhook: 'https://callback.example/complete', pathImport,
                    fileNames: Array.from({ length: fileCount }, (_, i) => `image-${i}.jpg`),
                    imagesCount: fileCount
                }, 'task-owner-token', {}, async () => []),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Submission did not finish (empty upload hang)')), 2000);
                })
            ]);
            // handleError records failure asynchronously after the forwarding loop.
            await new Promise(resolve => setImmediate(resolve));
        } finally {
            clearTimeout(timer);
        }
    };
    return { run, requests, records, routes, cleanups, cancellations, output, workers, response: () => response };
}

const field = (request, name) => request.fields.find(part => part.name === name)?.contents;

async function main() {
    const shared = fixture();
    await shared.run();
    assert.deepStrictEqual(shared.requests.map(request => request.stage), ['init', 'commit']);
    const init = shared.requests[0];
    assert.strictEqual(field(init, 'import_path'), '/worker-a/shared/project/9/task/images');
    assert.strictEqual(field(init, 'name'), 'Flight');
    assert.strictEqual(field(init, 'dateCreated'), '1700000000000');
    assert.strictEqual(field(init, 'webhook'), 'https://callback.example/complete');
    assert.strictEqual(field(init, 'outputs'), 'all.zip');
    assert.strictEqual(field(init, 'skipPostProcessing'), 'true');
    assert.ok(init.headers.includes(`set-uuid: ${TASK_ID}`));
    assert.ok(shared.requests.every(request => request.token === 'worker-token'));
    assert.deepStrictEqual(shared.response(), { uuid: TASK_ID });
    assert.strictEqual(shared.routes.length, 1);
    assert.strictEqual(shared.routes[0].uuid, TASK_ID);
    assert.strictEqual(shared.routes[0].token, 'task-owner-token');
    assert.strictEqual(shared.records.size, 0);
    assert.deepStrictEqual(shared.cleanups, [path.join('tmp', TASK_ID)]);
    assert.strictEqual(shared.workers[0].transients, 0);

    const uploads = fixture({ fileCount: 45, pathImport: null });
    await uploads.run();
    assert.strictEqual(field(uploads.requests[0], 'import_path'), undefined);
    assert.strictEqual(uploads.requests[0].stage, 'init');
    assert.strictEqual(uploads.requests[uploads.requests.length - 1].stage, 'commit');
    const files = uploads.requests.filter(request => request.stage === 'upload').flatMap(request => request.fields);
    assert.strictEqual(files.length, 45, 'all uploaded files must reach the worker');
    assert.ok(files.every(part => part.name === 'images' && part.file.startsWith(path.join('tmp', TASK_ID))));
    assert.strictEqual(new Set(files.map(part => part.file)).size, 45);
    assert.strictEqual(uploads.routes.length, 1);
    assert.strictEqual(uploads.workers[0].transients, 0);

    const mixed = fixture({ fileCount: 1 });
    await mixed.run();
    assert.deepStrictEqual(mixed.requests.map(request => request.stage), ['init', 'upload', 'commit']);
    assert.strictEqual(field(mixed.requests[0], 'import_path'), '/worker-a/shared/project/9/task/images');

    for (const rejectStage of ['init', 'commit']) {
        const retry = fixture({ rejectStage, switchWorker: true });
        await retry.run();
        const inits = retry.requests.filter(request => request.stage === 'init');
        assert.deepStrictEqual(inits.map(request => request.hostname), ['worker-a', 'worker-b']);
        assert.deepStrictEqual(inits.map(request => field(request, 'import_path')), [
            '/worker-a/shared/project/9/task/images', '/worker-b/shared/project/9/task/images'
        ]);
        assert.strictEqual(retry.routes.length, 1);
        assert.strictEqual(retry.routes[0].node, retry.workers[1]);
        assert.ok(retry.workers.every(worker => worker.transients === 0));
    }

    const failed = fixture({ rejectStage: 'commit' });
    await failed.run();
    assert.strictEqual(failed.routes.length, 0, 'a rejected task must never get a route');
    assert.strictEqual(failed.records.get(TASK_ID).taskInfo.status.code, statusCodes.FAILED);
    assert.strictEqual(failed.requests.filter(request => request.stage === 'commit').length, 6);
    assert.strictEqual(failed.workers[0].transients, 0);

    const empty = fixture({ pathImport: null });
    await assert.rejects(empty.run(), /Not enough images/);
    assert.strictEqual(empty.requests.length, 0);

    const unchanged = fixture({ pathImport: '/scratch/shared/images' });
    await unchanged.run();
    assert.strictEqual(field(unchanged.requests[0], 'import_path'), '/scratch/shared/images');
    config.splitmerge = true;
    const v1 = fixture({v1: true});
    await v1.run();
    assert.deepStrictEqual(v1.requests.map(request => request.stage), ['init', 'commit']);
    for (const [name, value] of Object.entries({shared_submodel_version: '1', seed_path: '/worker-a/shared/seed.zip', parent_task_uuid: TASK_ID, attempt_id: TASK_ID, shared_source_job_uuid: 'source-job', outputs: '["all.zip"]'})) assert.strictEqual(field(v1.requests[0], name), value);
    for (const rejectStage of ['init', 'commit']) {
        const failure = fixture({v1: true, rejectStage});
        await failure.run();
        assert.strictEqual(failure.routes.length, 0);
        assert.strictEqual(failure.requests.filter(request => request.stage === rejectStage).length, 1);
        assert.strictEqual(failure.records.get(TASK_ID).taskInfo.status.code, statusCodes.FAILED);
        assert.deepStrictEqual(failure.cancellations, [TASK_ID]);
    }
    const lostAck = fixture({v1: true, rejectStage: 'commit', accepted: true});
    await lostAck.run();
    assert.strictEqual(lostAck.routes.length, 1, 'accepted UUID must be reconciled on the same worker');
    assert.strictEqual(lostAck.requests.filter(request => request.stage === 'init').length, 1);
    assert.deepStrictEqual(lostAck.cancellations, []);
    for (const settings of [{parentToken: 'someone-else'}, {crossAllocation: true}, {capable: false}, {spoof: true}]) {
        const rejected = fixture({v1: true, ...settings});
        await assert.rejects(rejected.run(), /ownership|capable|forbidden/);
        assert.strictEqual(rejected.requests.length, 0);
    }
    config.splitmerge = false;
    await assert.rejects(fixture({v1: true}).run(), /split-merge/);
    console.log('EXISTING WORKER SUBMISSION TEST PASSED');
}

const originalMappings = config.node_shared_path_mappings;
const originalSplitmerge = config.splitmerge;
config.splitmerge = false;
config.node_shared_path_mappings = {
    'worker-a': { '/corral/webodm/media': '/worker-a/shared' },
    'worker-b': { '/corral/webodm/media': '/worker-b/shared' }
};
main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
}).finally(() => {
    config.node_shared_path_mappings = originalMappings;
    config.splitmerge = originalSplitmerge;
});
