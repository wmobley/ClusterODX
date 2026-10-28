const assert = require('assert');
const TapisProvider = require('../libs/asr-providers/tapis');
const logger = require('../libs/logger');
const odmOptions = require('../libs/odmOptions');

const makeJwt = (username, tenant = 'tacc') => {
    const payload = Buffer.from(JSON.stringify({
        'tapis/username': username,
        'tapis/tenant_id': tenant,
        exp: Math.floor(Date.now() / 1000) + 300
    })).toString('base64url');
    return `header.${payload}.signature`;
};

(async () => {
    const provider = new TapisProvider({
        tapis: { baseUrl: 'https://example.tapis.io', tenantId: 'tacc' },
        app: { appId: 'nodeodx-ls6', appVersion: '1.0.18' },
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
            envVariables: [
                { key: 'NODEODX_CLEANUP_TASKS_AFTER', value: '0' }
            ]
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
    const fallback = provider.getNodeOptions();
    const fallbackNodeOptions = fallback.filter(option => !option.name.startsWith('tapis-'));
    const expectedNodeOptionNames = [
        'end-with', 'rerun-from', 'min-num-features', 'feature-type', 'feature-quality',
        'matcher-type', 'matcher-neighbors', 'use-fixed-camera-params', 'cameras', 'camera-lens',
        'radiometric-calibration', 'max-concurrency', 'use-hybrid-bundle-adjustment', 'sfm-algorithm',
        'sky-removal', 'bg-removal', 'use-3dmesh', 'skip-3dmodel', 'skip-report', 'skip-orthophoto',
        'ignore-gsd', 'no-gpu', 'mesh-size', 'mesh-octree-depth', 'fast-orthophoto', 'crop',
        'boundary', 'auto-boundary', 'auto-boundary-distance', 'pc-quality', 'pc-classify', 'pc-csv',
        'pc-las', 'pc-ept', 'pc-copc', 'pc-filter', 'pc-sample', 'pc-skip-geometric', 'pc-tile',
        'smrf-scalar', 'smrf-slope', 'smrf-threshold', 'smrf-window', 'texturing-skip-global-seam-leveling',
        'texturing-skip-local-seam-leveling', 'texturing-keep-unseen-faces', 'texturing-single-material',
        'gltf', 'use-exif', 'dtm', 'dsm', 'dem-gapfill-steps', 'dem-resolution', 'dem-decimation',
        'dem-euclidean-map', 'orthophoto-resolution', 'orthophoto-no-tiled', 'orthophoto-png',
        'orthophoto-kmz', 'orthophoto-compression', 'orthophoto-cutline', 'tiles', '3d-tiles',
        'rolling-shutter', 'rolling-shutter-readout', 'build-overviews', 'cog', 'video-limit',
        'video-resolution', 'split', 'split-overlap', 'sm-no-align', 'sm-cluster', 'merge',
        'force-gps', 'gps-accuracy', 'optimize-disk-space', 'pc-rectify', 'primary-band',
        'skip-band-alignment'
    ];
    assert.strictEqual(new Set(fallbackNodeOptions.map(option => option.name)).size, fallbackNodeOptions.length);
    assert.deepStrictEqual(
        fallbackNodeOptions.map(option => option.name).sort(),
        expectedNodeOptionNames.sort()
    );
    for (const name of ['pc-quality', 'split', 'orthophoto-resolution', 'min-num-features', 'tapis-queue']) {
        assert.ok(fallback.some(option => option.name === name), `Missing fallback option: ${name}`);
    }
    const minimumFeatures = fallbackNodeOptions.find(option => option.name === 'min-num-features');
    assert.strictEqual(minimumFeatures.type, 'int');
    assert.strictEqual(minimumFeatures.value, '10000');
    assert.strictEqual(fallbackNodeOptions.find(option => option.name === 'feature-type').type, 'enum');
    const expectedFallbackSchemas = [
        { name: 'min-num-features', type: 'int', value: '10000', domain: 'integer' },
        { name: 'matcher-type', type: 'enum', value: 'flann', domain: ['bow', 'bruteforce', 'flann'] },
        { name: 'camera-lens', type: 'enum', value: 'auto', domain: ['auto', 'perspective', 'brown', 'fisheye', 'spherical', 'equirectangular', 'dual'] },
        { name: 'max-concurrency', type: 'int', value: '4', domain: 'positive integer' },
        { name: 'crop', type: 'float', value: '3', domain: 'positive float' },
        { name: 'pc-filter', type: 'float', value: '2.5', domain: 'positive float' },
        { name: 'dem-resolution', type: 'float', value: '5', domain: 'float' },
        { name: 'orthophoto-resolution', type: 'float', value: '5', domain: 'float > 0.0' },
        { name: 'split', type: 'int', value: '999999', domain: 'positive integer' },
        { name: 'split-overlap', type: 'float', value: '150', domain: 'positive integer' },
        { name: 'sm-cluster', type: 'string', value: 'None', domain: 'string' },
        { name: 'gps-accuracy', type: 'float', value: '10', domain: 'positive float' },
        { name: 'primary-band', type: 'string', value: 'auto', domain: 'string' }
    ];
    for (const expected of expectedFallbackSchemas) {
        const option = fallbackNodeOptions.find(candidate => candidate.name === expected.name);
        assert.deepStrictEqual({
            name: option.name,
            type: option.type,
            value: option.value,
            domain: option.domain
        }, expected);
    }
    assert.doesNotThrow(() => odmOptions.filterOptions([
        { name: 'min-num-features', value: '18000' },
        { name: 'feature-type', value: 'sift' },
        { name: 'split', value: '8' }
    ], fallbackNodeOptions));

    assert.strictEqual(provider.canHandle(50), true);
    assert.strictEqual(provider.canHandle(1001), false);
    assert.strictEqual(provider.getClusterOptions()[0].value, 'normal');
    assert.deepStrictEqual(provider.getClusterOptions()[0].defaultByImages, [{ maxImages: 1000, value: 'normal' }]);
    assert.deepStrictEqual(provider.getClusterOptions()[2].defaultByImages, [{ maxImages: 1000, value: '360' }]);
    assert.deepStrictEqual(provider.getClusterOptions()[3].defaultByImages, [{ maxImages: 1000, value: '2' }]);

    let payload = null;
    const originalInfo = logger.info;
    const infoMessages = [];
    logger.info = message => infoMessages.push(message);
    provider.createApiClient = () => ({
        post: async (_path, body, options) => {
            assert.strictEqual(_path, '/v3/jobs/submit');
            assert.strictEqual(options.timeout, 60000);
            payload = body;
            return { status: 201, data: { result: { uuid: 'tapis-job-1' } } };
        }
    });

    const defaultResult = await provider.submitJobWithoutData('test-token', 'clusterodx-default', 468, []);
    assert.strictEqual(defaultResult.primaryJobId, 'tapis-job-1');
    logger.info = originalInfo;
    const accepted = infoMessages.find(message => message.includes('Job submission accepted'));
    assert.match(accepted, /"status":201/);
    assert.match(accepted, /"tapisJobId":"tapis-job-1"/);
    assert.doesNotMatch(infoMessages.join('\n'), /test-token/);
    assert.strictEqual(payload.appId, 'nodeodx-ls6');
    assert.strictEqual(payload.appVersion, '1.0.18');
    assert.strictEqual(payload.execSystemLogicalQueue, 'normal');
    assert.strictEqual(payload.nodeCount, 2);
    assert.strictEqual(payload.coresPerNode, 64);
    assert.strictEqual(payload.memoryMB, 30720);
    assert.strictEqual(payload.maxMinutes, 360);
    assert.deepStrictEqual(payload.parameterSet.envVariables, [
        { key: 'NODEODX_CLEANUP_TASKS_AFTER', value: '0' },
        {
            key: 'TAPIS_ACCESS_TOKEN',
            value: 'test-token',
            description: 'Request-scoped Tapis JWT for NodeODX worker authentication'
        }
    ]);

    const globalConfig = require('../config');
    const originalSecret = globalConfig.registration_secret;
    provider.config.worker = { registrationSecret: 'fixture-cluster-secret', allowSharedSecretPrimaryRegistration: true };
    await provider.submitJobWithoutData('test-token', 'secret-job', 50, []);
    assert.strictEqual(payload.parameterSet.envVariables.find(v => v.key === 'NODEODX_REGISTRATION_SECRET').value, 'fixture-cluster-secret');
    globalConfig.registration_secret = 'fixture-global-secret';
    await provider.submitJobWithoutData('test-token', 'global-secret-job', 50, []);
    assert.strictEqual(payload.parameterSet.envVariables.find(v => v.key === 'NODEODX_REGISTRATION_SECRET').value, 'fixture-global-secret');
    globalConfig.registration_secret = originalSecret;
    provider.config.job.envVariables.push({key: 'NODEODX_REGISTRATION_SECRET', value: 'untrusted-override'});
    provider.config.worker.allowSharedSecretPrimaryRegistration = false;
    await provider.submitJobWithoutData('test-token', 'jwt-job', 50, []);
    assert.ok(!payload.parameterSet.envVariables.some(v => v.key === 'NODEODX_REGISTRATION_SECRET'));
    provider.config.job.envVariables.pop();

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
    assert.strictEqual(payload.parameterSet.envVariables.find(variable => variable.key === 'TAPIS_ACCESS_TOKEN').value, 'test-token');
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

    logger.warn = message => { warning = message; };
    try {
        provider.createApiClient = () => ({
            post: async () => {
                const error = new Error('timeout of 60000ms exceeded');
                error.code = 'ECONNABORTED';
                throw error;
            }
        });
        await assert.rejects(provider.submitJobWithoutData('test-token', 'timeout-task', 50), /timeout/);
        assert.match(warning, /"code":"ECONNABORTED"/);
        assert.match(warning, /"timeoutMs":60000/);
        assert.match(warning, /"jobId":"timeout-task"/);
        assert.strictEqual(provider.findPendingTask('timeout-task'), null);
        provider.createApiClient = () => ({ post: async () => ({ status: 200, data: {} }) });
        await assert.rejects(provider.submitJobWithoutData('test-token', 'invalid-task', 50), /job UUID/);
        assert.match(warning, /"status":200/);
        assert.match(warning, /did not include a job UUID/);
        assert.doesNotMatch(warning, /test-token/);
    } finally {
        logger.warn = originalWarn;
    }

    const ownerToken = makeJwt('owner');
    provider.validateToken = async () => true;
    provider.submitJobWithoutData = async () => ({
        primaryJobId: 'tapis-job-2',
        submittedJobs: [{ tapisJobId: 'tapis-job-2', jobName: 'clusterodx-task' }]
    });
    const pendingNode = await provider.createNode({}, 50, ownerToken, 'clusterodx-task', { aborted: false }, [], ['image.jpg'], '/tmp/task', 'cluster-task-1');
    assert.strictEqual(pendingNode, null);
    assert.strictEqual(provider.findPendingTask('tapis-job-2').taskId, 'cluster-task-1');
    assert.strictEqual(provider.findPendingTask('tapis-job-2').nodeUser, 'owner@tacc');
    assert.strictEqual(provider.findPendingTaskByUser({ username: 'owner', tenantId: 'tacc' }).task.taskId, 'cluster-task-1');
    assert.strictEqual(provider.claimPendingTask(provider.findPendingTask('cluster-task-1')), true);
    assert.strictEqual(provider.claimPendingTask(provider.findPendingTask('cluster-task-1')), false);
    assert.strictEqual(provider.releasePendingTask(provider.findPendingTask('cluster-task-1')), true);
    assert.strictEqual(provider.findPendingTask('cluster-task-1').tapisJobId, 'tapis-job-2');
    assert.strictEqual(provider.consumePendingTask('tapis-job-2').taskId, 'cluster-task-1');
    assert.strictEqual(provider.findPendingTask('cluster-task-1'), null);
    assert.strictEqual(provider.findRegistrationJob('tapis-job-2').tapisJobOwner, 'owner');
    assert.strictEqual(provider.findRegistrationJob('cluster-task-1'), null);

    console.log('TAPIS PROVIDER TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
