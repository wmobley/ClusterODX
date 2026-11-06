'use strict';

// Checkpoint resume end to end with stubs: manifest lookup, GET /task/<uuid>/resume,
// POST /task/resume, restart-as-resume, the registration hand-off, the teardown wait
// and Tapis failure forwarding. No network, no Tapis, no worker.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');
const config = require('../config');
const utils = require('../libs/utils');
const statusCodes = require('../libs/statusCodes');
const logger = require('../libs/logger');
const TapisJobRegistry = require('../libs/tapisJobRegistry');
const { completeResumeRegistration, normalizeRegistration } = require('../libs/tapisRegistration');
const checkpoint = require('../libs/tapisCheckpoint');

const { STATES } = TapisJobRegistry;
const makeJwt = (username, tenant = 'portals') => {
    const payload = Buffer.from(JSON.stringify({ 'tapis/username': username, 'tapis/tenant_id': tenant, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    return `header.${payload}.signature`;
};
const OWNER = makeJwt('alice');
const OTHER = makeJwt('mallory');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = server => new Promise(resolve => server.close(resolve));

const call = (port, method, route, token, body = null) => new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
        hostname: '127.0.0.1', port, path: `${route}${route.includes('?') ? '&' : '?'}token=${token}`, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); } catch (e) { reject(e); } });
    });
    req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(payload);
});

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clusterodx-resume-'));
    const root = path.join(dir, 'checkpoints');
    const cfgPath = path.join(dir, 'tapis.json');
    const providerConfig = {
        provider: 'tapis',
        tapis: {
            baseUrl: 'https://example.tapis.io', tenantId: 'portals', registryPath: path.join(dir, 'registry.json'),
            vacuumIntervalSeconds: 0, submitReconcileSeconds: 0,
            checkpointRoot: root, checkpointNodeRoot: '/node/checkpoints',
            resume: { enabled: true, syncTimeoutSeconds: 0.4, syncPollSeconds: 0.05 }
        },
        app: { appId: 'nodeodx-ls6', appVersion: '1.0.18' },
        system: { executionSystemId: 'ls6', archiveSystemId: 'ls6' },
        job: { maxNodesPerJob: 4, envVariables: [{ key: 'KEEP', value: 'yes' }] },
        maxUploadTime: 3600,
        imageSizeMapping: [{ maxImages: 100000, nodeCount: 1, logicalQueue: 'vm-small' }]
    };
    fs.writeFileSync(cfgPath, JSON.stringify(providerConfig));

    // Quiet the provider's own logging; keep warnings for assertions.
    const original = { info: logger.info, warn: logger.warn };
    const warnings = [];
    logger.info = () => {};
    logger.warn = m => warnings.push(String(m));

    const asrProvider = require('../libs/asrProvider');
    const provider = await asrProvider.initialize(cfgPath);
    assert.ok(provider && provider.isResumeEnabled());

    // Tapis stub: captures the submitted job and the registry as it was at submit time.
    const submits = [];
    const cancels = [];
    const tapisJobs = new Map();
    provider.createApiClient = () => ({
        get: async url => {
            if (url === '/v3/systems') return { data: {} };
            const uuid = decodeURIComponent(url.split('/').pop());
            if (!tapisJobs.has(uuid)) { const e = new Error('404'); e.response = { status: 404, data: {} }; throw e; }
            return { data: { result: tapisJobs.get(uuid) } };
        },
        post: async (url, job) => {
            if (url.endsWith('/cancel')) { cancels.push(url); return { status: 200 }; }
            const record = provider.registry.get(job.name);
            submits.push({ job, registryAtSubmit: record && JSON.parse(JSON.stringify(record)), env: Object.fromEntries(job.parameterSet.envVariables.map(v => [v.key, v.value])) });
            return { status: 200, data: { result: { uuid: `tapis-${submits.length}` } } };
        }
    });

    const manifestFor = uuid => path.join(root, uuid, 'manifest.json');
    const writeManifest = (uuid, overrides = {}) => {
        fs.mkdirSync(path.join(root, uuid), { recursive: true });
        fs.writeFileSync(manifestFor(uuid), JSON.stringify(Object.assign({
            schemaVersion: 2, state: 'synced', dataComplete: true, expiresAt: Date.now() + 3600e3,
            stagesCompleted: ['dataset', 'odm_meshing', 'odm_dem'], split: false, optimizeDiskSpace: false,
            engineVersion: '3.5.0', checkpointBytes: 1234, name: 'proj', imagesCount: 50, tapisJobOwner: 'alice'
        }, overrides)));
        return uuid;
    };
    const fresh = overrides => writeManifest(crypto.randomUUID(), overrides);

    // ---- 1. Lookup per manifest fixture --------------------------------------------
    const lookup = async uuid => provider.lookupResume(uuid, OWNER);
    let answer = await lookup(fresh());
    assert.deepStrictEqual(answer, { resumable: true, reason: null, expiresAt: answer.expiresAt, engineVersion: '3.5.0',
        stagesCompleted: ['dataset', 'odm_meshing', 'odm_dem'], checkpointBytes: 1234, split: false, resumableClasses: [], schemaVersion: 2 });
    assert.strictEqual(typeof answer.expiresAt, 'number');

    const reasonOf = async overrides => { const a = await lookup(fresh(overrides)); assert.strictEqual(a.resumable, false); return a.reason; };
    assert.strictEqual((await lookup(crypto.randomUUID())).reason, 'no_manifest');
    assert.strictEqual(await reasonOf({ state: 'partial' }), 'partial');
    assert.strictEqual(await reasonOf({ state: 'active' }), 'partial');
    assert.strictEqual(await reasonOf({ dataComplete: false }), 'partial');
    assert.strictEqual(await reasonOf({ state: 'write_failed' }), 'write_failed');
    assert.strictEqual(await reasonOf({ state: 'inconsistent' }), 'inconsistent');
    assert.strictEqual(await reasonOf({ expiresAt: Date.now() - 1000 }), 'expired');
    assert.strictEqual(await reasonOf({ expiresAt: new Date(Date.now() - 5000).toISOString() }), 'expired');
    assert.strictEqual(await reasonOf({ optimizeDiskSpace: true }), 'optimize_disk_space');
    assert.strictEqual(await reasonOf({ schemaVersion: 1 }), 'legacy_manifest');
    assert.strictEqual(await reasonOf({ stagesCompleted: undefined }), 'legacy_manifest');
    assert.strictEqual(await reasonOf({ tapisJobOwner: 'someone-else' }), 'not_owner');
    answer = await lookup(fresh({ split: true, submodelCloudsPresent: [true, true] }));
    assert.deepStrictEqual([answer.resumable, answer.split, answer.resumableClasses], [true, true, ['M', 'O']]);
    answer = await lookup(fresh({ split: true, submodelCloudsPresent: [true, false] }));
    assert.deepStrictEqual([answer.resumable, answer.resumableClasses, answer.classReason], [true, ['M'], 'submodel_clouds_missing']);
    answer = await lookup(fresh({ split: true }));
    assert.deepStrictEqual(answer.resumableClasses, ['M']);

    // Cached for 60 s: the decision does not change when the file does, until it ages out.
    const cached = fresh();
    assert.strictEqual((await lookup(cached)).resumable, true);
    writeManifest(cached, { state: 'partial' });
    assert.strictEqual((await lookup(cached)).resumable, true, 'cached decision');
    provider.resumeLookupCache.get(cached).at -= 61 * 1000;
    assert.strictEqual((await lookup(cached)).reason, 'partial', 'cache expired');
    // The owner check runs on every read, cached or not.
    const owned = fresh();
    await lookup(owned);
    assert.strictEqual((await provider.lookupResume(owned, OTHER)).reason, 'not_owner');

    provider.config.tapis.resume.enabled = false;
    assert.strictEqual((await lookup(fresh())).reason, 'disabled');
    provider.config.tapis.resume.enabled = true;

    // ---- 2. Provider: registry before submit, env, options -------------------------
    const UUID = fresh({ tapisJobOwner: undefined });
    let result = await provider.resumeTaskFromCheckpoint({
        taskId: UUID, token: OWNER, newVersion: true,
        taskOptions: JSON.stringify([{ name: 'rerun-from', value: 'odm_dem' }, { name: 'dem-resolution', value: 2 }, { name: 'tapis-queue', value: 'normal' }])
    });
    let submit = submits[submits.length - 1];
    assert.notStrictEqual(result.uuid, UUID);
    assert.ok(checkpoint.isTaskUuid(result.uuid));
    assert.strictEqual(result.stage, 'odm_dem');
    assert.strictEqual(submit.registryAtSubmit.state, STATES.SUBMITTING, 'registry record exists before the submit');
    assert.deepStrictEqual(
        [submit.registryAtSubmit.resumeOf, submit.registryAtSubmit.newUuid, submit.registryAtSubmit.class, submit.registryAtSubmit.stage, submit.registryAtSubmit.taskId],
        [UUID, result.uuid, null, 'odm_dem', result.uuid]);
    assert.strictEqual(submit.job.execSystemLogicalQueue, 'normal');
    assert.strictEqual(submit.env.NODEODM_RESUME_TASK_UUID, UUID);
    assert.strictEqual(submit.env.NODEODM_RESUME_AS_UUID, result.uuid);
    assert.strictEqual(submit.env.NODEODM_RESUME_ALLOW_COLD_START, '0');
    assert.strictEqual(submit.env.NODEODM_CHECKPOINT_ROOT, '/node/checkpoints');
    assert.strictEqual(submit.env.NODEODM_RESUME_CHECKPOINT_PATH, `/node/checkpoints/${UUID}`);
    assert.strictEqual(submit.env.NODEODM_CHECKPOINT_INTERVAL_SECONDS, '900');
    assert.strictEqual(submit.env.NODEODM_CHECKPOINT_RETENTION_SECONDS, '604800');
    assert.strictEqual(submit.env.KEEP, 'yes', 'configured env is kept');
    assert.ok(submit.env.TAPIS_ACCESS_TOKEN, 'job credentials unchanged');
    assert.deepStrictEqual(JSON.parse(submit.env.NODEODM_RESUME_OPTIONS_JSON),
        [{ name: 'rerun-from', value: 'odm_dem' }, { name: 'dem-resolution', value: 2 }], 'tapis-* options are not passed to the worker');
    assert.ok(!JSON.stringify(provider.registry.all()).includes(OWNER), 'no bearer token in the registry');
    assert.strictEqual(provider.findPendingTask(result.uuid).checkpointResume, true);

    // Replace mode: same uuid, no AS_UUID; a second resume while one is pending is refused.
    const REPLACE = fresh();
    result = await provider.resumeTaskFromCheckpoint({ taskId: REPLACE, token: OWNER, taskOptions: [] });
    submit = submits[submits.length - 1];
    assert.strictEqual(result.uuid, REPLACE);
    assert.ok(!('NODEODM_RESUME_AS_UUID' in submit.env));
    await assert.rejects(provider.resumeTaskFromCheckpoint({ taskId: REPLACE, token: OWNER, taskOptions: [] }), /resume_in_progress/);

    // Split: class decides the options; node count never shrinks; non-resumable classes are refused.
    const SPLIT = fresh({ split: true, submodelCloudsPresent: [true, true] });
    provider.registry.upsert({ jobName: 'orig-job', taskId: SPLIT, nodeCount: 2, imagesCount: 50, state: STATES.DONE });
    result = await provider.resumeTaskFromCheckpoint({ taskId: SPLIT, token: OWNER, newVersion: true, resumeClass: 'O',
        taskOptions: [{ name: 'dem-resolution', value: 3 }, { name: 'rerun-from', value: 'odm_dem' }] });
    submit = submits[submits.length - 1];
    assert.strictEqual(result.class, 'O');
    assert.strictEqual(submit.job.nodeCount, 2, 'original node count is kept');
    assert.deepStrictEqual(JSON.parse(submit.env.NODEODM_RESUME_OPTIONS_JSON), [
        { name: 'dem-resolution', value: 3 }, { name: 'rerun-from', value: 'merge' }, { name: 'submodel-rerun-from', value: 'odm_meshing' }]);
    result = await provider.resumeTaskFromCheckpoint({ taskId: SPLIT, token: OWNER, newVersion: true, resumeClass: 'M',
        taskOptions: [{ name: 'tiles', value: true }, { name: 'tapis-node', value: '3' }] });
    submit = submits[submits.length - 1];
    assert.strictEqual(submit.job.nodeCount, 3, 'a larger node count is allowed');
    assert.deepStrictEqual(JSON.parse(submit.env.NODEODM_RESUME_OPTIONS_JSON), [{ name: 'tiles', value: true }, { name: 'rerun-from', value: 'merge' }]);
    // Without a hint the class comes from rerun-from: merge -> M, odm_meshing or later -> O.
    await provider.resumeTaskFromCheckpoint({ taskId: SPLIT, token: OWNER, newVersion: true, taskOptions: [{ name: 'rerun-from', value: 'merge' }] });
    assert.deepStrictEqual(JSON.parse(submits[submits.length - 1].env.NODEODM_RESUME_OPTIONS_JSON), [{ name: 'rerun-from', value: 'merge' }]);
    for (const stage of ['odm_meshing', 'mvs_texturing', 'odm_georeferencing', 'odm_dem', 'odm_orthophoto', 'odm_report', 'odm_postprocess']) {
        const inferred = await provider.resumeTaskFromCheckpoint({ taskId: SPLIT, token: OWNER, newVersion: true, taskOptions: [{ name: 'rerun-from', value: stage }] });
        assert.strictEqual(inferred.class, 'O', stage);
        assert.deepStrictEqual(JSON.parse(submits[submits.length - 1].env.NODEODM_RESUME_OPTIONS_JSON),
            [{ name: 'rerun-from', value: 'merge' }, { name: 'submodel-rerun-from', value: 'odm_meshing' }]);
    }
    // Earlier stage or no rerun-from: refused before anything is submitted.
    const early = submits.length;
    for (const taskOptions of [[{ name: 'rerun-from', value: 'opensfm' }], [{ name: 'rerun-from', value: 'dataset' }], [{ name: 'dsm', value: true }]]) {
        await assert.rejects(provider.resumeTaskFromCheckpoint({ taskId: SPLIT, token: OWNER, newVersion: true, taskOptions }), /class_unavailable/);
    }
    assert.strictEqual(submits.length, early);
    const before = submits.length;
    await assert.rejects(provider.resumeTaskFromCheckpoint({ taskId: SPLIT, token: OWNER, newVersion: true,
        resumeClass: 'M', taskOptions: [{ name: 'tapis-node', value: '1' }] }), /node_count_too_small/);
    const NOCLOUDS = fresh({ split: true, submodelCloudsPresent: [true, false] });
    provider.registry.upsert({ jobName: 'orig-job-2', taskId: NOCLOUDS, nodeCount: 2, state: STATES.DONE });
    await assert.rejects(provider.resumeTaskFromCheckpoint({ taskId: NOCLOUDS, token: OWNER, newVersion: true, resumeClass: 'O', taskOptions: [] }), /class_unavailable/);
    await assert.rejects(provider.resumeTaskFromCheckpoint({ taskId: fresh({ state: 'partial' }), token: OWNER, taskOptions: [] }), /partial/);
    assert.strictEqual(submits.length, before, 'refusals submit nothing');
    // Unknown original node count (not in manifest or registry): the request's tapis-node is accepted, not enforced.
    await provider.resumeTaskFromCheckpoint({ taskId: fresh({ split: true }), token: OWNER, newVersion: true, resumeClass: 'M', taskOptions: [{ name: 'tapis-node', value: '1' }] });
    assert.strictEqual(submits[submits.length - 1].job.nodeCount, 1);

    // Fixtures from the worker's schema 2: epoch seconds, manifest_only, boolean and map clouds.
    const seconds = Math.floor(Date.now() / 1000) + 3600;
    answer = await lookup(fresh({ expiresAt: seconds, updatedAt: seconds - 10 }));
    assert.deepStrictEqual([answer.resumable, answer.expiresAt], [true, seconds * 1000], 'epoch seconds become milliseconds');
    assert.strictEqual(await reasonOf({ expiresAt: Math.floor(Date.now() / 1000) - 60 }), 'expired', 'past epoch seconds');
    assert.strictEqual(await reasonOf({ state: 'manifest_only', dataComplete: false }), 'no_data');
    answer = await lookup(fresh({ split: true, submodelCloudsPresent: true, submodelClouds: { a: true, b: true } }));
    assert.deepStrictEqual(answer.resumableClasses, ['M', 'O']);
    answer = await lookup(fresh({ split: true, submodelCloudsPresent: false, submodelClouds: { a: true, b: true } }));
    assert.deepStrictEqual(answer.resumableClasses, ['M'], 'the boolean wins over the map');
    answer = await lookup(fresh({ split: true, submodelCloudsPresent: null, submodelClouds: { a: true, b: true } }));
    assert.deepStrictEqual(answer.resumableClasses, ['M', 'O'], 'map used when the boolean is missing');
    answer = await lookup(fresh({ split: true, submodelCloudsPresent: null, submodelClouds: { a: true, b: false } }));
    assert.deepStrictEqual(answer.resumableClasses, ['M']);
    answer = await lookup(fresh({ split: false, submodelCloudsPresent: null, imagesKind: 'symlink', importPath: '/corral/webodm/media/p/images' }));
    assert.deepStrictEqual([answer.resumable, answer.resumableClasses], [true, []]);

    // ---- 3. Proxy routes -------------------------------------------------------------
    const TASK = fresh();
    const tableData = new Map();
    const routeTokens = new Map();
    let routedNode = null;
    const mocks = {
        '../config': Object.assign({}, config, { use_ssl: false, debug: false }),
        './taskNew': {},
        './classes/ValueCache': class {},
        './utils': Object.assign({}, utils, { cleanupTemporaryDirectory() {}, rmdir() {} }),
        './accessLog': () => {},
        './logger': logger,
        './asrProvider': { get: () => provider, downloadsPath: () => null },
        './routetable': {
            initialize: async () => {},
            lookupNode: async uuid => (uuid === TASK && routedNode) || null,
            lookupToken: async uuid => routeTokens.get(uuid) || null,
            findByToken: async () => ({})
        },
        './tasktable': {
            initialize: async () => {},
            lookup: async uuid => (tableData.get(uuid) || {}).obj || null,
            lookupToken: async uuid => (tableData.get(uuid) || {}).token || null,
            add: async (uuid, obj, token) => tableData.set(uuid, { obj, token }),
            delete: async uuid => tableData.delete(uuid)
        },
        './concurrencyMonitor': { decreaseCount() {} }
    };
    const filename = require.resolve('../libs/proxy');
    const loaded = new Module(filename, module);
    const realRequire = Module.createRequire(filename);
    loaded.filename = filename;
    loaded.paths = module.paths;
    loaded.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : realRequire(name);
    loaded._compile('const setInterval = () => {};\n' + fs.readFileSync(filename, 'utf8'), filename);
    const servers = await loaded.exports.initialize({ validate: async token => ({ valid: token === OWNER || token === OTHER, limits: {} }) });
    const server = servers[0].server;
    await listen(server);
    const port = server.address().port;
    const seedTask = (uuid, status = statusCodes.COMPLETED) => tableData.set(uuid, { obj: { taskInfo: { uuid, name: 'proj', status: { code: status } }, output: ['done'] }, token: OWNER });

    try {
        seedTask(TASK);
        // Lookup: owner only, the contract keys, flag-off answer.
        let r = await call(port, 'GET', `/task/${TASK}/resume`, OWNER);
        assert.deepStrictEqual(Object.keys(r.body).sort(), ['checkpointBytes', 'engineVersion', 'expiresAt', 'reason', 'resumable', 'resumableClasses', 'schemaVersion', 'split', 'stagesCompleted']);
        assert.strictEqual(r.body.resumable, true);
        r = await call(port, 'GET', `/task/${TASK}/resume`, OTHER);
        assert.match(r.body.error, /no task found for this token/);
        r = await call(port, 'GET', `/task/${crypto.randomUUID()}/resume`, OWNER);
        assert.match(r.body.error, /no task found/);
        provider.config.tapis.resume.enabled = false;
        r = await call(port, 'GET', `/task/${TASK}/resume`, OWNER);
        assert.deepStrictEqual([r.body.resumable, r.body.reason], [false, 'disabled']);
        provider.config.tapis.resume.enabled = true;

        // POST /task/resume as a new version.
        let n = submits.length;
        r = await call(port, 'POST', '/task/resume', OWNER, { uuid: TASK, newVersion: true, options: [{ name: 'rerun-from', value: 'odm_dem' }] });
        assert.strictEqual(submits.length, n + 1);
        assert.deepStrictEqual(Object.keys(r.body).sort(), ['checkpointEngineVersion', 'checkpointUuid', 'resumeMode', 'resumedFromStage', 'uuid']);
        assert.deepStrictEqual([r.body.resumeMode, r.body.resumedFromStage, r.body.checkpointEngineVersion, r.body.checkpointUuid], ['resume', 'odm_dem', '3.5.0', TASK]);
        assert.notStrictEqual(r.body.uuid, TASK);
        assert.strictEqual(submits[n].env.NODEODM_RESUME_AS_UUID, r.body.uuid);
        const queued = tableData.get(r.body.uuid);
        assert.strictEqual(queued.obj.taskInfo.status.code, statusCodes.QUEUED);
        assert.deepStrictEqual(queued.obj.output, ['Restoring checkpoint…']);
        assert.strictEqual(queued.token, OWNER);
        assert.strictEqual(tableData.get(TASK).obj.taskInfo.status.code, statusCodes.COMPLETED, 'the source task is untouched');
        // Cancel while restoring cancels the pending Tapis job.
        const cancelsBefore = cancels.length;
        queued.obj.abort();
        await sleep(50);
        assert.strictEqual(cancels.length, cancelsBefore + 1);
        assert.strictEqual(provider.findPendingTask(r.body.uuid), null);

        // Owner, flag and live-node guards: nothing is submitted.
        n = submits.length;
        r = await call(port, 'POST', '/task/resume', OTHER, { uuid: TASK, newVersion: true, options: [] });
        assert.match(r.body.error, /not_owner/);
        routedNode = { getToken: () => 'w' };
        r = await call(port, 'POST', '/task/resume', OWNER, { uuid: TASK, newVersion: true, options: [] });
        assert.match(r.body.error, /task_active/);
        routedNode = null;
        provider.config.tapis.resume.enabled = false;
        r = await call(port, 'POST', '/task/resume', OWNER, { uuid: TASK, newVersion: true, options: [] });
        assert.match(r.body.error, /disabled/);
        provider.config.tapis.resume.enabled = true;
        const BAD = fresh({ state: 'partial' });
        seedTask(BAD);
        r = await call(port, 'POST', '/task/resume', OWNER, { uuid: BAD, newVersion: true, options: '[]' });
        assert.match(r.body.error, /partial/);
        assert.strictEqual(submits.length, n);

        // Restart: resumable node-less task resumes in place; otherwise the legacy answer.
        const RESTART = fresh();
        seedTask(RESTART);
        r = await call(port, 'POST', '/task/restart', OWNER, { uuid: RESTART, options: JSON.stringify([{ name: 'dsm', value: true }]) });
        assert.deepStrictEqual(r.body, { success: true, resumed: true });
        assert.ok(!('NODEODM_RESUME_AS_UUID' in submits[submits.length - 1].env));
        assert.strictEqual(tableData.get(RESTART).obj.taskInfo.status.code, statusCodes.QUEUED);
        const SPLIT_RESTART = fresh({ split: true, submodelCloudsPresent: [true, true] });
        provider.registry.upsert({ jobName: 'orig-job-3', taskId: SPLIT_RESTART, nodeCount: 2, state: STATES.DONE });
        seedTask(SPLIT_RESTART);
        r = await call(port, 'POST', '/task/restart', OWNER, { uuid: SPLIT_RESTART, options: [{ name: 'rerun-from', value: 'odm_dem' }] });
        assert.deepStrictEqual(r.body, { success: true, resumed: true });
        assert.ok(submits[submits.length - 1].env.NODEODM_RESUME_OPTIONS_JSON.includes('"submodel-rerun-from"'));
        seedTask(SPLIT_RESTART);
        r = await call(port, 'POST', '/task/restart', OWNER, { uuid: SPLIT_RESTART, options: [{ name: 'rerun-from', value: 'opensfm' }] });
        assert.match(r.body.error, /class_unavailable/);
        seedTask(BAD);
        n = submits.length;
        r = await call(port, 'POST', '/task/restart', OWNER, { uuid: BAD });
        assert.match(r.body.error, /Please create a new task/);
        const FLAGOFF = fresh();
        seedTask(FLAGOFF);
        provider.config.tapis.resume.enabled = false;
        r = await call(port, 'POST', '/task/restart', OWNER, { uuid: FLAGOFF });
        assert.match(r.body.error, /Please create a new task/);
        provider.config.tapis.resume.enabled = true;
        seedTask(FLAGOFF);
        r = await call(port, 'POST', '/task/restart', OTHER, { uuid: FLAGOFF });
        assert.match(r.body.error, /Please create a new task/, 'a non-owner never resumes');
        assert.strictEqual(submits.length, n);
    } finally {
        await close(server);
    }

    // ---- 4. Registration hand-off ------------------------------------------------------
    const TARGET = crypto.randomUUID();
    const order = [];
    const handoffTable = new Map([[TARGET, { taskInfo: { status: { code: statusCodes.QUEUED } }, output: ['Restoring checkpoint…'] }]]);
    const rt = { add: async (uuid, node, token) => order.push(['route', uuid, token]) };
    const tt = { lookup: async uuid => handoffTable.get(uuid) || null, delete: async uuid => { order.push(['delete', uuid]); handoffTable.delete(uuid); }, add: async (uuid, obj) => { order.push(['table', uuid]); handoffTable.set(uuid, obj); } };
    const node = { hostname: () => 'w1', port: () => 3000 };
    const pendingFor = extra => Object.assign({ taskId: TARGET, jobId: 'job-x', tapisJobId: 'tj-x', token: OWNER, checkpointResume: true }, extra);
    const stubProvider = { recordUpsert: record => order.push(['registry', record.resumeFailure]), cancelPendingTask: async (id, why) => order.push(['cancel', id, why]) };
    let outcome = await completeResumeRegistration({ pending: pendingFor(), node, registration: normalizeRegistration({ hostname: 'w1', port: 3000, checkpointResume: true, schemaVersion: 2 }), provider: stubProvider, routetable: rt, tasktable: tt });
    assert.deepStrictEqual(outcome, { mode: 'resumed' });
    assert.deepStrictEqual(order, [['route', TARGET, OWNER], ['delete', TARGET]], 'route first, then delete');
    assert.strictEqual(normalizeRegistration({ hostname: 'w1', port: 3000, schemaVersion: 2 }).metadata.schemaVersion, 2);
    assert.strictEqual(normalizeRegistration({ hostname: 'w1', port: 3000 }).metadata.schemaVersion, null);

    order.length = 0;
    handoffTable.set(TARGET, { taskInfo: { status: { code: statusCodes.QUEUED } }, output: [] });
    outcome = await completeResumeRegistration({ pending: pendingFor(), node, registration: normalizeRegistration({ hostname: 'w1', port: 3000, checkpointResume: true, resumeFallbackReason: 'engine_mismatch' }), provider: stubProvider, routetable: rt, tasktable: tt });
    assert.deepStrictEqual(outcome, { mode: 'failed', reason: 'engine_mismatch' });
    assert.deepStrictEqual(order.map(step => step[0]), ['table', 'registry', 'cancel'], 'no route, no delete');
    assert.deepStrictEqual(order[2], ['cancel', 'tj-x', 'resume failed: engine_mismatch']);
    const failed = handoffTable.get(TARGET).taskInfo.status;
    assert.deepStrictEqual(failed, { code: statusCodes.FAILED, errorMessage: 'Resume failed: engine_mismatch' });
    // A worker that does not acknowledge the resume (old image) is failed, never given an empty hand-off.
    order.length = 0;
    outcome = await completeResumeRegistration({ pending: pendingFor(), node, registration: normalizeRegistration({ hostname: 'w1', port: 3000 }), provider: stubProvider, routetable: rt, tasktable: tt });
    assert.strictEqual(outcome.reason, 'resume_not_acknowledged');
    assert.ok(!order.some(step => step[0] === 'route'));

    // Real provider cancel path: the job is cancelled through the Tapis API and recorded.
    const live = fresh();
    const liveResult = await provider.resumeTaskFromCheckpoint({ taskId: live, token: OWNER, taskOptions: [] });
    const livePending = provider.findPendingTask(liveResult.uuid);
    const cancelCount = cancels.length;
    await completeResumeRegistration({ pending: livePending, node, registration: normalizeRegistration({ hostname: 'w1', port: 3000, checkpointResume: true, resumeFallbackReason: 'not_synced' }), provider, routetable: rt, tasktable: tt });
    assert.strictEqual(cancels.length, cancelCount + 1);
    assert.ok(cancels[cancels.length - 1].endsWith(`/v3/jobs/${livePending.tapisJobId}/cancel`));
    const closed = provider.registry.get(livePending.tapisJobId);
    assert.deepStrictEqual([closed.state, closed.resumeFailure, closed.doneReason], [STATES.DONE, 'not_synced', 'resume failed: not_synced']);

    // A job that is already ending refuses the cancel (400): it is still closed, not parked for retries.
    const ending = fresh();
    const endingResult = await provider.resumeTaskFromCheckpoint({ taskId: ending, token: OWNER, taskOptions: [] });
    const endingPending = provider.findPendingTask(endingResult.uuid);
    tapisJobs.set(endingPending.tapisJobId, { status: 'FINISHED' });
    const realClient = provider.createApiClient;
    provider.createApiClient = token => {
        const client = realClient(token);
        return { get: client.get, post: async url => { if (url.endsWith('/cancel')) { const e = new Error('400'); e.response = { status: 400, data: {} }; throw e; } return client.post(url); } };
    };
    await completeResumeRegistration({ pending: endingPending, node, registration: normalizeRegistration({ hostname: 'w1', port: 3000, checkpointResume: true, resumeMode: 'failed', resumeFallbackReason: 'engine_mismatch', schemaVersion: 2 }), provider, routetable: rt, tasktable: tt });
    provider.createApiClient = realClient;
    assert.strictEqual(provider.registry.get(endingPending.tapisJobId).state, STATES.DONE);

    // A restart between submit and registration keeps the resume flag on the restored pending task.
    const restored = new (require('../libs/asr-providers/tapis'))(JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
    await restored.initialize();
    const reborn = restored.findPendingTask(livePending.tapisJobId);
    assert.strictEqual(reborn, null, 'closed jobs are not restored');
    const open = provider.registry.open().find(record => record.checkpointResume && record.state === STATES.SUBMITTED);
    assert.ok(open && restored.findPendingTask(open.tapisJobId).checkpointResume === true);
    assert.strictEqual(restored.findPendingTask(open.tapisJobId).resumeTaskUuid, open.resumeOf);

    // ---- 5. Teardown waits for the checkpoint -------------------------------------------
    const routetable = require('../libs/routetable');
    const tasktable = require('../libs/tasktable');
    const netutils = require('../libs/netutils');
    const WAIT = fresh({ state: 'active' });
    const cleaned = [];
    let waitNode = { isAutoSpawned: () => true, taskInfo: async () => ({}), getTapisJobId: () => 'tj-wait', nodeData: { schemaVersion: 2 } };
    routetable.lookupNode = async () => waitNode;
    routetable.lookup = async () => ({ token: OWNER });
    tasktable.add = async () => {};
    netutils.removeAndCleanupNode = async n => { cleaned.push(Date.now()); return true; };

    let started = Date.now();
    const done = asrProvider.onCommit(WAIT, 0);
    await sleep(150);
    assert.strictEqual(cleaned.length, 0, 'teardown waits while the manifest is still active');
    writeManifest(WAIT, { state: 'synced', writerJobUuid: 'tj-old' });
    await sleep(150);
    assert.strictEqual(cleaned.length, 0, 'a manifest written by an earlier job does not release the teardown');
    writeManifest(WAIT, { state: 'synced', writerJobUuid: 'tj-wait' });
    await done;
    assert.strictEqual(cleaned.length, 1);
    assert.ok(cleaned[0] - started >= 250, 'cleanup after the synced manifest');

    // Gives up at the timeout.
    const STUCK = fresh({ state: 'active' });
    started = Date.now();
    await asrProvider.onCommit(STUCK, 0);
    assert.strictEqual(cleaned.length, 2);
    assert.ok(cleaned[1] - started >= 350 && cleaned[1] - started < 2000, 'timeout 0.4 s then teardown');
    assert.ok(warnings.some(w => w.includes('not synced after')));
    // write_failed and partial also release the teardown.
    for (const state of ['write_failed', 'partial']) {
        started = Date.now();
        await asrProvider.onCommit(fresh({ state }), 0);
        assert.ok(Date.now() - started < 300, `${state} ends the wait`);
    }
    // No wait for a worker without schema 2, or with the flag off.
    waitNode = Object.assign({}, waitNode, { nodeData: {} });
    started = Date.now();
    await asrProvider.onCommit(fresh({ state: 'active' }), 0);
    assert.ok(Date.now() - started < 200);
    waitNode = Object.assign({}, waitNode, { nodeData: { schemaVersion: 2 } });
    provider.config.tapis.resume.enabled = false;
    started = Date.now();
    await asrProvider.onCommit(fresh({ state: 'active' }), 0);
    assert.ok(Date.now() - started < 200);
    provider.config.tapis.resume.enabled = true;

    // ---- 6. Tapis failure forwarding -----------------------------------------------------
    const table = new Map();
    const routeMap = new Map();
    const deps = {
        nodes: { find: fn => fakeNodes.find(fn), filter: fn => fakeNodes.filter(fn), remove: () => {} },
        routetable: { findByNode: async () => routeMap.get('routes') || {}, removeByNode: async () => {} },
        tasktable: { lookup: async uuid => (table.get(uuid) || {}).obj || null, add: async (uuid, obj, token) => table.set(uuid, { obj, token }) },
        removeAndCleanupNode: async () => true
    };
    const fakeNodes = [{ getTapisJobId: () => 'tj-lost', isOnline: () => true, transients: 0, getInfoProperty: (k, d) => d, toString: () => 'lost' }];
    const T_RUN = crypto.randomUUID();
    const T_DONE = crypto.randomUUID();
    routeMap.set('routes', { [T_RUN]: { token: OWNER }, [T_DONE]: { token: OWNER } });
    table.set(T_DONE, { obj: { taskInfo: { status: { code: statusCodes.COMPLETED } }, output: [] }, token: OWNER });
    provider.registry.upsert({ jobName: 'clusterodx-lost', tapisJobId: 'tj-lost', taskId: T_RUN, state: STATES.REGISTERED, owner: 'alice', ownerTenant: 'portals', queue: 'normal', submittedAt: Date.now() });
    provider.activeJobs.set('tj-lost', { jobId: 'clusterodx-lost', token: OWNER, status: 'RUNNING' });
    tapisJobs.set('tj-lost', { status: 'FAILED', remoteOutcome: 'TIMEOUT', lastMessage: `DUE TO TIME LIMIT ${'x'.repeat(400)}` });
    await provider.vacuum(deps);
    await provider.registry.flush();
    const lost = table.get(T_RUN).obj.taskInfo;
    assert.strictEqual(lost.status.code, statusCodes.FAILED);
    assert.ok(lost.status.errorMessage.startsWith('TIMEOUT: DUE TO TIME LIMIT'));
    assert.ok(lost.status.errorMessage.length <= 300);
    assert.strictEqual(table.get(T_RUN).token, OWNER);
    assert.strictEqual(table.get(T_DONE).obj.taskInfo.status.code, statusCodes.COMPLETED, 'a finished task is left alone');
    const lostRecord = provider.registry.get('clusterodx-lost');
    assert.deepStrictEqual([lostRecord.state, lostRecord.remoteOutcome, lostRecord.tapisStatus], [STATES.DONE, 'TIMEOUT', 'FAILED']);
    // A job that finished normally forwards nothing.
    const T_OK = crypto.randomUUID();
    routeMap.set('routes', { [T_OK]: { token: OWNER } });
    fakeNodes[0] = { getTapisJobId: () => 'tj-ok', isOnline: () => true, transients: 0, getInfoProperty: (k, d) => d, toString: () => 'ok' };
    provider.registry.upsert({ jobName: 'clusterodx-ok', tapisJobId: 'tj-ok', taskId: T_OK, state: STATES.REGISTERED, owner: 'alice', ownerTenant: 'portals', queue: 'normal', submittedAt: Date.now() });
    provider.activeJobs.set('tj-ok', { jobId: 'clusterodx-ok', token: OWNER, status: 'RUNNING' });
    tapisJobs.set('tj-ok', { status: 'FINISHED', remoteOutcome: 'FINISHED' });
    await provider.vacuum(deps);
    assert.ok(!table.has(T_OK));

    logger.info = original.info;
    logger.warn = original.warn;
    console.log('TASK RESUME TEST PASSED');
    process.exit(0); // asrProvider.initialize leaves its vacuum interval running
})().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
