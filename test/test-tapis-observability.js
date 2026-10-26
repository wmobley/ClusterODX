const assert = require('assert');
const axios = require('axios');
const logger = require('../libs/logger');
const {
    classifySubmitError,
    logHandoffEvent,
    safeNodeEndpoint
} = require('../libs/observability');
const { submitPendingTask } = require('../libs/tapisWorker');

const originalPost = axios.post;
const originalInfo = logger.info;
const messages = [];

logger.info = message => messages.push(String(message));

const node = {
    hostname: () => 'worker-1',
    port: () => 3000,
    urlFor: pathname => `http://worker-1:3000${pathname}`
};

const events = () => messages.map(message => JSON.parse(message));
const reset = () => { messages.length = 0; };

(async () => {
    assert.strictEqual(safeNodeEndpoint('worker-1', 3000), 'worker-1:3000');
    assert.strictEqual(safeNodeEndpoint('worker/1', 3000), undefined);
    assert.strictEqual(classifySubmitError({ code: 'ECONNABORTED' }), 'timeout');
    assert.strictEqual(classifySubmitError({ response: { status: 503 } }), 'http_error');
    assert.strictEqual(classifySubmitError({ code: 'ECONNREFUSED' }), 'network_error');
    assert.strictEqual(classifySubmitError({ code: 'ENOENT' }), 'filesystem_error');

    reset();
    axios.post = async () => ({ status: 200, data: { uuid: 'task-1' } });
    const success = await submitPendingTask({
        taskId: 'task-1',
        tapisJobId: 'tapis-job-1',
        pathImport: '/corral/webodm/media/project/images',
        taskOptions: []
    }, node);
    assert.deepStrictEqual(success, { taskUuid: 'task-1', usedImportPath: true });
    assert.deepStrictEqual(events().map(event => event.phase), [
        'task_submit_started',
        'task_submit_finished'
    ]);
    assert.strictEqual(events()[1].outcome, 'success');
    assert.strictEqual(events()[1].path_mode, 'shared_import_path');
    assert.strictEqual(events()[1].timeout_ms, 300000);
    assert.strictEqual(events()[1].http_status, 200);

    reset();
    axios.post = async () => ({ status: 200, data: { uuid: 'node-task-id' } });
    const mismatched = await submitPendingTask({
        taskId: 'cluster-task-id',
        tapisJobId: 'tapis-job-mismatch',
        pathImport: '/corral/webodm/media/project/images'
    }, node);
    assert.deepStrictEqual(mismatched, { taskUuid: 'cluster-task-id', usedImportPath: true });
    assert.strictEqual(events()[1].outcome, 'success');

    reset();
    axios.post = async () => ({ status: 200, data: {} });
    const missingResponseUuid = await submitPendingTask({
        taskId: 'cluster-task-without-response-uuid',
        tapisJobId: 'tapis-job-missing-response-uuid',
        pathImport: '/corral/webodm/media/project/images'
    }, node);
    assert.deepStrictEqual(missingResponseUuid, {
        taskUuid: 'cluster-task-without-response-uuid',
        usedImportPath: true
    });
    assert.strictEqual(events()[1].outcome, 'success');

    reset();
    axios.post = async () => ({ status: 200, data: { error: 'Invalid set-uuid' } });
    await assert.rejects(() => submitPendingTask({
        taskId: 'task-rejected-by-nodeodx',
        tapisJobId: 'tapis-job-rejected',
        pathImport: '/corral/webodm/media/project/images'
    }, node), /NodeODX rejected task: Invalid set-uuid/);
    assert.strictEqual(events()[1].outcome, 'failure');
    assert.strictEqual(events()[1].error_class, 'validation_error');
    assert.strictEqual(events()[1].http_status, 200);

    reset();
    axios.post = async () => {
        const error = new Error('private response body must not be logged');
        error.response = { status: 502, data: 'private response body' };
        throw error;
    };
    await assert.rejects(() => submitPendingTask({
        taskId: 'task-2',
        tapisJobId: 'tapis-job-2',
        pathImport: '/corral/webodm/media/project/images'
    }, node));
    const failureEvents = events();
    assert.deepStrictEqual(failureEvents.map(event => event.phase), [
        'task_submit_started',
        'task_submit_finished'
    ]);
    assert.strictEqual(failureEvents[1].outcome, 'failure');
    assert.strictEqual(failureEvents[1].error_class, 'http_error');
    assert.strictEqual(failureEvents[1].http_status, 502);
    assert.ok(!messages.some(message => message.includes('private response body')));

    reset();
    await assert.rejects(() => submitPendingTask({
        taskId: 'task-3',
        tapisJobId: 'tapis-job-3'
    }, node));
    assert.deepStrictEqual(events().map(event => event.phase), [
        'task_submit_started',
        'task_submit_finished'
    ]);
    assert.strictEqual(events()[1].error_class, 'validation_error');

    reset();
    logHandoffEvent(logger, 'webhook_received', { authorization: 'secret', body: 'private' });
    assert.deepStrictEqual(events()[0], {
        event: 'odx_node_handoff',
        phase: 'webhook_received'
    });

    console.log('TAPIS OBSERVABILITY TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
}).finally(() => {
    axios.post = originalPost;
    logger.info = originalInfo;
});
