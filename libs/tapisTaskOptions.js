'use strict';

const TAPIS_OPTION_NAMES = new Set([
    'tapis-queue',
    'tapis-allocation',
    'tapis-max-run-time',
    'tapis-node'
]);

const GPU_QUEUE_PREFIX = /^gpu(?:-|$)/i;

const isTapisOptionName = (name) => TAPIS_OPTION_NAMES.has(String(name || ''));

const getTaskOption = (taskOptions, name) => {
    if (!Array.isArray(taskOptions)) return null;
    const option = taskOptions.find(item => item && item.name === name);
    return option ? option.value : null;
};

const stripTapisOptions = (taskOptions) => {
    if (!Array.isArray(taskOptions)) return [];
    return taskOptions
        .filter(option => option && !isTapisOptionName(option.name))
        .map(option => Object.assign({}, option));
};

const queueUsesGpu = (queue) => GPU_QUEUE_PREFIX.test(String(queue || '').trim());

const applyGpuQueuePolicy = (taskOptions, queue) => {
    const result = stripTapisOptions(taskOptions);
    if (!queueUsesGpu(queue)) return result;

    const noGpuIndex = result.findIndex(option => option && option.name === 'no-gpu');
    if (noGpuIndex === -1) result.push({ name: 'no-gpu', value: false });
    else result[noGpuIndex] = Object.assign({}, result[noGpuIndex], { value: false });
    return result;
};

module.exports = {
    TAPIS_OPTION_NAMES,
    getTaskOption,
    isTapisOptionName,
    stripTapisOptions,
    queueUsesGpu,
    applyGpuQueuePolicy
};
