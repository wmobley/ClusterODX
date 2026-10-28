'use strict';
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const filename = require.resolve('../libs/tapisWorker');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
const realRequire = Module.createRequire(filename);
let request;
const mocks = {
    axios: {post: async (url, form, options) => {
        request = {url, fields: Object.fromEntries(form.fields), options};
        return {status: 200, data: {uuid: 'attempt-1'}};
    }},
    'form-data': class {
        constructor() { this.fields = []; }
        append(name, value) { this.fields.push([name, value]); }
        getHeaders() { return {}; }
    },
    './logger': {info() {}, warn() {}}
};
loaded.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : realRequire(name);
loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
const {submitPendingTask} = loaded.exports;
(async () => {
    const node = {nodeData: {tapisJobUuid: 'source-job'}, hostname: () => 'worker-1', port: () => 3001,
        isOnline: () => true, isLocked: () => false,
        getInfo: () => ({capabilities: {shared_submodel_v1: true}}), updateInfo: async () => {}, urlFor: () => 'http://worker/task/new'};
    const submissionParams = {shared_submodel_version: '1', seed_path: '/corral/webodm/media/seed.zip', parent_task_uuid: 'parent-1', attempt_id: 'attempt-1', shared_source_job_uuid: 'source-job', outputs: '["all.zip"]', skipPostProcessing: 'true', taskName: 'Submodel'};
    const pending = {taskId: 'attempt-1', tapisJobId: 'source-job', pathImport: '/corral/webodm/media/images', taskOptions: [{name: 'dsm', value: true}], submissionParams};
    await submitPendingTask(pending, node);
    for (const field of ['shared_submodel_version', 'parent_task_uuid', 'attempt_id', 'shared_source_job_uuid', 'outputs', 'skipPostProcessing']) assert.strictEqual(request.fields[field], submissionParams[field]);
    assert.strictEqual(request.fields.seed_path, '/corral/utexas/BCS26030/webodm/media/seed.zip');
    assert.strictEqual(request.fields.import_path, '/corral/utexas/BCS26030/webodm/media/images');
    assert.strictEqual(request.options.headers['set-uuid'], 'attempt-1');
    assert.strictEqual(request.fields.images, undefined);
    assert.deepStrictEqual(JSON.parse(request.fields.options), pending.taskOptions);
    node.nodeData.tapisJobUuid = 'other-job';
    await assert.rejects(submitPendingTask(pending, node), /allocation/);
    node.nodeData.tapisJobUuid = 'source-job';
    node.getInfo = () => ({capabilities: {shared_submodel_v1: false}});
    await assert.rejects(submitPendingTask(pending, node), /allocation/);
    console.log('SHARED SUBMODEL DEFERRED HANDOFF TEST PASSED');
})().catch(error => { console.error(error); process.exitCode = 1; });
