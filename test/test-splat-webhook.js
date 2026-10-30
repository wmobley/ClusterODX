'use strict';
// NodeSplat registers through the same /webhook/register-node webhook and shared secret as NodeODX,
// but is handled by the dedicated splat store and never enters the generic node registry.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const adminweb = require('../adminweb');
const asrProvider = require('../libs/asrProvider');
const nodes = require('../libs/nodes');
const holder = require('../libs/splatInstance');
const routetable = require('../libs/routetable');
const tasktable = require('../libs/tasktable');
const {SplatTasks} = require('../libs/splatTasks');
const {hash} = require('../libs/splatAuth');

const request = (port, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({hostname: '127.0.0.1', port, path: '/webhook/register-node', method: 'POST',
        headers: {'content-type': 'application/json', 'content-length': Buffer.byteLength(data)}}, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(text || '{}')}));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
});

(async () => {
    const originalNodes = fs.readFileSync('data/nodes.json', 'utf8');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-webhook-'));
    const SECRET = 'worker-secret';
    const provider = {getDriverName: () => 'tapis', getConfig: key => key === 'worker.registrationSecret' ? SECRET : '',
        validateToken: async () => {}, findPendingTask: () => null, findPendingTaskByUser: () => ({task: null, count: 0})};
    const originalGet = asrProvider.get;
    asrProvider.get = () => provider;

    const calls = [];
    const profile = {baseUrl: 'https://tapis.invalid', tenantId: 'portals', appId: 'nodesplat-ls6', appVersion: '0.1.0',
        executionSystemId: 'ls6', archiveSystemId: 'cloud.data', queue: 'q', allocation: 'A', coresPerNode: 1,
        memoryMB: 1, maxMinutes: 10, inputRoot: root, outputRoot: root, callbackUrl: 'https://cluster.invalid',
        workerBindHost: '0.0.0.0', workerPort: 3101};
    const splat = new SplatTasks({enabled: true, instanceId: 'i', storeDir: path.join(root, 'store'), profile},
        {workerRequest: async (url, route, token, method, body) => {
            calls.push({url, route, token, method, body});
            return route === '/info' ? {engine: 'nodesplat', capabilities: ['opensplat-webodm-v1']} : {uuid: body['set-uuid']};
        }});
    const apiToken = crypto.randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();
    splat.store.save({version: 1, uuid: id, owner: {username: 'u', tenant: 'portals'}, run_id: crypto.randomUUID(),
        source_task_id: crypto.randomUUID(), manifest_sha256: 'a'.repeat(64), profile_id: 'nodesplat-v1',
        settings: {num_iterations: 100, image_size: 1920}, state: 'queued', phase: 'Waiting for GPU worker',
        tapis_job_uuid: 'tapis-job-1', cancel_pending: false, api_hash: hash(apiToken), job_name: 'nodesplat-' + id,
        lease_expires_at: Date.now() + 3600000});

    const server = await adminweb.create({port: 0});
    const port = server.address().port;
    const splatBody = patch => Object.assign({hostname: 'c301-001.ls6.tacc.utexas.edu', port: 3101, token: apiToken,
        tapisJobUuid: 'tapis-job-1', registrationUuid: id, role: 'nodesplat', nodeReady: true}, patch);
    const nodeCount = nodes.all().length;
    const originalAdd = routetable.add, originalDelete = tasktable.delete;
    let genericTouched = 0;
    routetable.add = async (...args) => { genericTouched++; return originalAdd.apply(routetable, args); };
    tasktable.delete = async (...args) => { genericTouched++; return originalDelete.apply(tasktable, args); };

    try {
        // Splat disabled / not initialized: NodeSplat registrations are refused, not routed to NodeODX handling
        holder.instance = null;
        assert.strictEqual((await request(port, splatBody())).status, 404);
        holder.instance = new SplatTasks({enabled: false});
        assert.strictEqual((await request(port, splatBody())).status, 404);
        holder.instance = splat;

        // Per-job token plus exact task/job binding; the cluster-wide NodeODX secret does not authenticate a splat worker
        assert.strictEqual((await request(port, splatBody({token: undefined, registrationSecret: SECRET}))).status, 403);
        assert.strictEqual((await request(port, splatBody({tapisJobUuid: 'other-job'}))).status, 403);
        assert.strictEqual((await request(port, splatBody({token: 'x'.repeat(43)}))).status, 403);
        assert.strictEqual((await request(port, splatBody({registrationUuid: crypto.randomUUID()}))).status, 403);
        assert.strictEqual((await request(port, splatBody({hostname: 'bad host', port: 3101}))).status, 400);
        assert.strictEqual(calls.length, 0);

        const ok = await request(port, splatBody());
        assert.strictEqual(ok.status, 200);
        assert.deepStrictEqual(ok.body, {success: true, uuid: id});
        assert.deepStrictEqual(calls.map(call => call.route), ['/info', '/task/new']);
        assert.strictEqual(calls[0].url, 'http://c301-001.ls6.tacc.utexas.edu:3101/');
        assert.strictEqual(calls[0].token, apiToken);
        assert.strictEqual((await request(port, splatBody())).status, 200, 'keepalive is idempotent');
        assert.strictEqual(calls.length, 2);
        assert.strictEqual((await request(port, splatBody({port: 3102}))).status, 409);
        assert.ok(!JSON.stringify(ok.body).includes(SECRET));

        // Generic node registry, route table and task table are never touched
        assert.strictEqual(nodes.all().length, nodeCount);
        assert.ok(!nodes.all().some(node => node.hostname() === 'c301-001.ls6.tacc.utexas.edu'));
        assert.strictEqual(genericTouched, 0);

        // Ordinary NodeODX registration is unaffected
        const normal = await request(port, {hostname: 'legacy-worker-splat-webhook', port: 61301, role: 'worker', registrationSecret: SECRET});
        assert.strictEqual(normal.status, 200);
        assert.strictEqual(normal.body.authMethod, 'registration-secret');
        assert.ok(nodes.find(node => node.hostname() === 'legacy-worker-splat-webhook' && node.port() === 61301));
        assert.strictEqual(calls.length, 2, 'normal workers never reach the splat handler');
    } finally {
        routetable.add = originalAdd;
        tasktable.delete = originalDelete;
        await new Promise(resolve => server.close(resolve));
        asrProvider.get = originalGet;
        holder.instance = null;
        splat.close();
        for (const node of nodes.all().filter(node => node.hostname().startsWith('legacy-worker-splat-webhook'))) nodes.remove(node);
        await nodes.saveToDisk();
        fs.writeFileSync('data/nodes.json', originalNodes);
    }
    console.log('NodeSplat webhook registration test passed');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
