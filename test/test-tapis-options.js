const assert = require('assert');
const options = require('../libs/tapisTaskOptions');

const taskOptions = [
    { name: 'tapis-queue', value: 'gpu-a100-small' },
    { name: 'tapis-node', value: '2' },
    { name: 'no-gpu', value: true },
    { name: 'pc-quality', value: 'high' }
];

assert.strictEqual(options.getTaskOption(taskOptions, 'tapis-node'), '2');
assert.strictEqual(options.queueUsesGpu('gpu-a100-small'), true);
assert.strictEqual(options.queueUsesGpu('normal'), false);
assert.deepStrictEqual(options.stripTapisOptions(taskOptions), [
    { name: 'no-gpu', value: true },
    { name: 'pc-quality', value: 'high' }
]);
assert.deepStrictEqual(options.applyGpuQueuePolicy(taskOptions, 'gpu-a100-small'), [
    { name: 'no-gpu', value: false },
    { name: 'pc-quality', value: 'high' }
]);

console.log('TAPIS OPTIONS TEST PASSED');
