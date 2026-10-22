const assert = require('assert');
const TapisProvider = require('../libs/asr-providers/tapis');
const logger = require('../libs/logger');

(async () => {
    const provider = new TapisProvider({
        tapis: { baseUrl: 'https://example.tapis.io', tenantId: 'tacc' },
        app: { appId: 'nodeodx-ls6', appVersion: '2.3.1' },
        system: { executionSystemId: 'ls6', archiveSystemId: 'ls6', logicalQueue: 'normal', queueFilter: ['normal', 'gpu-a100-small'] },
        scheduler: { defaultAllocation: 'PT2050-DataX' },
        job: {
            maxJobTime: '02:00:00',
            nodeCount: 1,
            coresPerNode: 16,
            memoryMB: 8192,
            maxNodesPerJob: 4,
            appArgs: [
                { name: 'cluster_control_url', arg: 'https://cluster.example/webhook/register-node' },
                { name: 'cluster_control_host', arg: 'cluster.example' },
                { name: 'cluster_control_port', arg: '443' }
            ],
            envVariables: []
        },
        imageSizeMapping: [{
            maxImages: 1000,
            jobCount: 1,
            nodeCount: 2,
            logicalQueue: 'normal',
            coresPerNode: 64,
            maxConcurrency: 64,
            memoryMB: 30720,
            maxJobTime: '06:00:00'
        }]
    });

    await provider.initialize();
    assert.strictEqual(provider.canHandle(50), true);
    assert.strictEqual(provider.canHandle(1001), false);
    assert.strictEqual(provider.getClusterOptions()[0].value, 'normal');
    assert.deepStrictEqual(provider.getClusterOptions()[0].defaultByImages, [{ maxImages: 1000, value: 'normal' }]);
    assert.deepStrictEqual(provider.getClusterOptions()[2].defaultByImages, [{ maxImages: 1000, value: '360' }]);
    assert.deepStrictEqual(provider.getClusterOptions()[3].defaultByImages, [{ maxImages: 1000, value: '2' }]);

    let payload = null;
    provider.createApiClient = () => ({
        post: async (_path, body) => {
            payload = body;
            return { data: { result: { uuid: 'tapis-job-1' } } };
        }
    });

    const defaultResult = await provider.submitJobWithoutData('test-token', 'clusterodx-default', 468, []);
    assert.strictEqual(defaultResult.primaryJobId, 'tapis-job-1');
    assert.strictEqual(payload.appId, 'nodeodx-ls6');
    assert.strictEqual(payload.appVersion, '2.3.1');
    assert.strictEqual(payload.execSystemLogicalQueue, 'normal');
    assert.strictEqual(payload.nodeCount, 2);
    assert.strictEqual(payload.coresPerNode, 64);
    assert.strictEqual(payload.memoryMB, 30720);
    assert.strictEqual(payload.maxMinutes, 360);

    const result = await provider.submitJobWithoutData('test-token', 'clusterodx-test', 50, [
        { name: 'tapis-queue', value: 'gpu-a100-small' },
        { name: 'tapis-allocation', value: 'ALLOC-1' },
        { name: 'tapis-node', value: '3' },
        { name: 'tapis-max-run-time', value: '480' }
    ]);
    assert.strictEqual(result.primaryJobId, 'tapis-job-1');
    assert.strictEqual(payload.execSystemLogicalQueue, 'gpu-a100-small');
    assert.strictEqual(payload.nodeCount, 3);
    assert.strictEqual(payload.maxMinutes, 480);
    assert.strictEqual(payload.parameterSet.schedulerOptions[0].arg, '-A ALLOC-1');
    assert.deepStrictEqual(payload.parameterSet.appArgs.map(arg => arg.name), [
        'cluster_control_url',
        'cluster_control_host',
        'cluster_control_port'
    ]);

    const originalWarn = logger.warn;
    let warning = '';
    logger.warn = message => { warning = message; };
    provider.createApiClient = () => ({
        post: async () => {
            const error = new Error('Request failed with status code 400');
            error.response = {
                status: 400,
                data: {
                    message: 'Invalid execution system',
                    token: 'must-not-be-logged'
                }
            };
            throw error;
        }
    });
    try {
        await assert.rejects(
            provider.submitJobWithoutData('test-token', 'clusterodx-test', 50, []),
            /status code 400/
        );
    } finally {
        logger.warn = originalWarn;
    }
    assert.match(warning, /"operation":"submit job"/);
    assert.match(warning, /"status":400/);
    assert.match(warning, /Invalid execution system/);
    assert.doesNotMatch(warning, /must-not-be-logged/);

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
