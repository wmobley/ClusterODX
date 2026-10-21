const assert = require('assert');
const TapisProvider = require('../libs/asr-providers/tapis');

(async () => {
    const provider = new TapisProvider({
        tapis: { baseUrl: 'https://example.tapis.io', tenantId: 'tacc' },
        app: { appId: 'nodeodx-ls6', appVersion: '2.3.1' },
        system: { executionSystemId: 'ls6', archiveSystemId: 'ls6', logicalQueue: 'normal', queueFilter: ['normal', 'gpu-a100-small'] },
        scheduler: { defaultAllocation: 'PT2050-DataX' },
        job: { maxJobTime: '02:00:00', nodeCount: 1, coresPerNode: 16, memoryMB: 30720, maxNodesPerJob: 4, appArgs: [{ name: 'clusterodx_url', arg: 'https://cluster.example/webhook/register-node' }] },
        imageSizeMapping: [{ maxImages: 100, jobCount: 1, nodeCount: 2, logicalQueue: 'normal', maxJobTime: '04:00:00' }]
    });

    await provider.initialize();
    assert.strictEqual(provider.canHandle(50), true);
    assert.strictEqual(provider.canHandle(101), false);
    assert.strictEqual(provider.getClusterOptions()[0].value, 'normal');

    let payload = null;
    provider.createApiClient = () => ({
        post: async (_path, body) => {
            payload = body;
            return { data: { result: { uuid: 'tapis-job-1' } } };
        }
    });

    const result = await provider.submitJobWithoutData('test-token', 'clusterodx-test', 50, [
        { name: 'tapis-queue', value: 'gpu-a100-small' },
        { name: 'tapis-allocation', value: 'ALLOC-1' },
        { name: 'tapis-node', value: '3' }
    ]);
    assert.strictEqual(result.primaryJobId, 'tapis-job-1');
    assert.strictEqual(payload.execSystemLogicalQueue, 'gpu-a100-small');
    assert.strictEqual(payload.nodeCount, 3);
    assert.strictEqual(payload.parameterSet.schedulerOptions[0].arg, '-A ALLOC-1');
    assert.strictEqual(payload.parameterSet.appArgs[0].name, 'clusterodx_url');

    provider.validateToken = async () => true;
    provider.submitJobWithoutData = async () => ({
        primaryJobId: 'tapis-job-2',
        submittedJobs: [{ tapisJobId: 'tapis-job-2', jobName: 'clusterodx-task' }]
    });
    const pendingNode = await provider.createNode({}, 50, 'test-token', 'clusterodx-task', { aborted: false }, [], ['image.jpg'], '/tmp/task', 'cluster-task-1');
    assert.strictEqual(pendingNode, null);
    assert.strictEqual(provider.findPendingTask('tapis-job-2').taskId, 'cluster-task-1');
    assert.strictEqual(provider.findPendingTask('cluster-task-1').tapisJobId, 'tapis-job-2');
    assert.strictEqual(provider.consumePendingTask('tapis-job-2').taskId, 'cluster-task-1');
    assert.strictEqual(provider.findPendingTask('cluster-task-1'), null);

    console.log('TAPIS PROVIDER TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
