const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const odmOptions = require('../libs/odmOptions');

// Execute the proxy's option discovery path without starting its servers/timers.
const source = fs.readFileSync(require.resolve('../libs/proxy'), 'utf8');
const start = source.indexOf('        const withProviderOptions =');
const end = source.indexOf('        const maxConcurrencyLimitReached =', start);
assert.ok(start >= 0 && end > start);

function discovery(provider) {
    const cache = new Map();
    const warnings = [];
    const getOptions = vm.runInNewContext(`(function () {
        ${source.slice(start, end)}
        return getLimitedOptions;
    })()`, {
        asrProvider: { get: () => provider },
        optionsCache: { get: key => cache.get(key), set: (key, value) => { cache.set(key, value); return value; } },
        odmOptions,
        logger: { warn: message => warnings.push(message) }
    });
    return { getOptions, warnings };
}

(async () => {
    const processing = {name: 'pc-quality', type: 'string', value: 'medium'};
    const queue = {name: 'tapis-queue', type: 'enum', value: 'normal', domain: ['normal']};
    const provider = {
        getClusterOptions: async token => { assert.strictEqual(token, 'user'); return [queue]; },
        getNodeOptions: async () => [processing, queue]
    };
    const node = { getOptions: async () => [processing, {...queue, value: 'stale'}] };
    for (const worker of [node, null]) {
        const {getOptions} = discovery(provider);
        const result = await getOptions('user', {}, worker);
        assert.strictEqual(result.length, 2);
        assert.strictEqual(result[0], processing);
        assert.strictEqual(result[1], queue);
        if (worker) assert.strictEqual(await getOptions('user', {}, worker), result);
    }
    const transition = discovery(provider);
    await transition.getOptions('user', {}, null);
    const workerOnly = {name: 'worker-only', type: 'bool', value: false};
    const registered = await transition.getOptions('user', {}, {getOptions: async () => [workerOnly]});
    assert.ok(registered.includes(workerOnly), 'worker options must replace workerless fallback immediately');
    const limited = await discovery(provider).getOptions('user', {
        options: {'tapis-queue': {value: 'limited'}}
    }, node);
    assert.strictEqual(limited.find(option => option.name === queue.name).value, 'limited');

    const failing = discovery({ getClusterOptions: async () => { throw new Error('offline'); } });
    const fallback = await failing.getOptions('user', {}, node);
    assert.strictEqual(fallback[1].value, 'stale');
    assert.strictEqual(failing.warnings.length, 1);
    const plain = await discovery(null).getOptions('user', {}, node);
    assert.strictEqual(plain[0], processing);

    // Exercise the download routing decision used by the proxy before forwarding.
    const routingStart = source.indexOf('                        const downloadsPath = asrProvider.downloadsPath();');
    const routingEnd = source.indexOf('                        if (downloadsPathEnabled', routingStart);
    assert.ok(routingStart >= 0 && routingEnd > routingStart);
    async function route(driver, online, force = false) {
        return vm.runInNewContext(`(async () => {
            ${source.slice(routingStart, routingEnd)}
            return Boolean(downloadsPathEnabled && isDownloadAction && !nodeCanServeDownload);
        })()`, {
            taskId: 'task', action: 'download/all.zip', config: {force_node_downloads: force},
            asrProvider: {downloadsPath: () => 'https://storage.example/v3/files',
                get: () => ({getDriverName: () => driver})},
            routetable: {lookupNode: async () => online === null ? null : {
                isOnline: () => online, proxyTargetUrl: () => 'http://worker:3000'
            }}
        });
    }
    for (const online of [true, false, null]) {
        assert.strictEqual(await route('tapis', online), false);
    }
    assert.strictEqual(await route('aws', true), false);
    assert.strictEqual(await route('aws', null), true);
    assert.strictEqual(await route('aws', false, true), false);
    console.log('PROXY OPTIONS TEST PASSED');
})().catch(error => { console.error(error); process.exitCode = 1; });
