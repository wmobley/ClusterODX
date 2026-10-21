const assert = require('assert');
const http = require('http');
const logger = require('../libs/logger');
const { submitPendingTask } = require('../libs/tapisWorker');

const originalInfo = logger.info;
const messages = [];
let server;

const events = () => messages.map(message => JSON.parse(message));

(async () => {
    logger.info = message => messages.push(String(message));

    let request;
    server = http.createServer((incoming, response) => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => {
            request = {
                method: incoming.method,
                url: incoming.url,
                headers: incoming.headers,
                body: Buffer.concat(chunks).toString()
            };
            response.writeHead(200, {'content-type': 'application/json'});
            response.end(JSON.stringify({uuid: 'handoff-task-1'}));
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const node = {
        hostname: () => 'worker-1',
        port: () => port,
        urlFor: pathname => `http://127.0.0.1:${port}${pathname}`
    };

    const result = await submitPendingTask({
        taskId: 'handoff-task-1',
        tapisJobId: 'tapis-job-1',
        pathImport: '/corral/webodm/media/project/9/task/images',
        taskOptions: [{name: 'dsm', value: true}]
    }, node);

    assert.deepStrictEqual(result, {taskUuid: 'handoff-task-1', usedImportPath: true});
    assert.strictEqual(request.method, 'POST');
    assert.strictEqual(request.url, '/task/new');
    assert.strictEqual(request.headers['set-uuid'], 'handoff-task-1');
    assert.ok(request.body.includes('/corral/utexas/BCS26030/webodm/media/project/9/task/images'));
    assert.ok(request.body.includes('tapis-job-1'));
    assert.deepStrictEqual(events().map(event => event.phase), [
        'task_submit_started',
        'task_submit_finished'
    ]);
    assert.strictEqual(events()[1].outcome, 'success');
    assert.strictEqual(events()[1].path_mode, 'shared_import_path');
    assert.strictEqual(events()[1].http_status, 200);

    console.log('TAPIS LOCAL HANDOFF TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
}).finally(async () => {
    logger.info = originalInfo;
    if (server && server.listening){
        await new Promise(resolve => server.close(resolve));
    }
});
