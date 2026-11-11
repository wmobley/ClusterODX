const assert = require('assert');
const fs = require('fs');

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const read = path => fs.readFileSync(require.resolve(path), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const response = rows => ({ ok: true, json: async () => rows });
const children = node => node && typeof node === 'object' ? node.props.children : [];
const descendants = node => Array.isArray(node) ? node.flatMap(descendants)
    : node && typeof node === 'object' ? [node, ...descendants(children(node))] : [];
const text = node => Array.isArray(node) ? node.map(text).join('')
    : node && typeof node === 'object' ? text(children(node))
    : typeof node === 'string' || typeof node === 'number' ? String(node) : '';

async function makeHtml() {
    const { default: htm } = await import(moduleUrl(read('../public/lib/htm.module.js')));
    return htm.bind((type, props, ...values) => ({ type, props: { ...props, children: values } }));
}

async function testTaskList(html) {
    global.__taskUi = { html, useState: initial => [initial, () => {}], Dialog: () => null };
    const source = read('../public/component/taskList.mjs').replace(/^import .*;\r?\n/gm, '');
    const { TaskList, formatTaskDate, formatAge, filterTasks, staleRows, stopWorkerDefaults, summarizeRemoval } =
        await import(moduleUrl(`const { html, useState, Dialog } = globalThis.__taskUi;\n${source}`));

    // Pure helpers (no hooks needed).
    const NOW = 10 * 3600 * 1000;
    assert.strictEqual(formatAge(NOW - 30000, NOW), '<1m');
    assert.strictEqual(formatAge(NOW - 5 * 60000, NOW), '5m');
    assert.strictEqual(formatAge(NOW - 3 * 3600000, NOW), '3h');
    assert.strictEqual(formatAge(0, 3 * 24 * 3600000), '3d');
    for (const bad of [null, undefined, NaN, NOW + 1]) assert.strictEqual(formatAge(bad, NOW), '—');
    const sample = [
        { uuid: 'a1', name: 'Alpha', owner: 'ann@portals', state: 'queued', stale: true, source: 'pending', node: null },
        { uuid: 'b2', name: 'Beta', owner: 'bob@portals', state: 'assigned', stale: true, source: 'route', node: { hostname: 'w1', port: 3001, online: false, autoSpawned: true } },
        { uuid: 'c3', name: 'Gamma', owner: 'bob@portals', state: 'assigned', stale: false, source: 'route', node: { hostname: 'w2', port: 3001, online: true, autoSpawned: false } },
        { uuid: 'd4', name: 'Delta', owner: null, state: 'completed', stale: false, source: 'route', node: { hostname: 'w2', port: 3001, online: true, autoSpawned: false } }
    ];
    assert.deepStrictEqual(filterTasks(sample, { owner: 'bob@portals', state: '', text: '', staleOnly: false }).map(t => t.uuid), ['b2', 'c3']);
    assert.deepStrictEqual(filterTasks(sample, { owner: '', state: 'completed', text: '', staleOnly: false }).map(t => t.uuid), ['d4']);
    assert.deepStrictEqual(filterTasks(sample, { owner: '', state: '', text: 'W1:3001', staleOnly: false }).map(t => t.uuid), ['b2'], 'search covers the worker');
    assert.deepStrictEqual(filterTasks(sample, { owner: '', state: '', text: 'ann', staleOnly: true }).map(t => t.uuid), ['a1']);
    assert.strictEqual(filterTasks(sample).length, 4);
    assert.deepStrictEqual(staleRows(sample).map(t => t.uuid), ['a1', 'b2']);
    const onlineStale = [{ uuid: 'x', stale: true, source: 'route', node: { online: true } }];
    assert.deepStrictEqual(staleRows(onlineStale), [], 'online routed rows are never auto-selected');
    assert.deepStrictEqual(stopWorkerDefaults(sample, ['b2']), { available: true, checked: true });
    assert.deepStrictEqual(stopWorkerDefaults(sample, ['b2', 'c3']), { available: true, checked: false }, 'mixed selection is not pre-checked');
    assert.deepStrictEqual(stopWorkerDefaults(sample, ['c3']), { available: false, checked: false });
    assert.deepStrictEqual(stopWorkerDefaults(sample, ['a1']), { available: false, checked: false });
    assert.strictEqual(summarizeRemoval({ results: [{ outcome: 'removed' }, { outcome: 'removed' }, { outcome: 'removed' },
        { outcome: 'not_found' }, { outcome: 'failed', uuid: 'zz', errors: ['route: boom'] }] }),
        'Removed 3. 1 already gone. 1 failed: zz route: boom');
    assert.match(summarizeRemoval({ results: [], persist: 'failed' }), /could not be saved/);

    // Rendering: owner, age and stale badge are visible; controls appear only when removal is wired.
    const rendered = TaskList({ tasks: sample });
    assert.match(text(rendered), /ann@portals/);
    assert.match(text(rendered), /Unknown/, 'unknown owners are labelled');
    assert.match(text(rendered), /Stale/);
    assert.match(text(rendered), /4 of 4/);
    assert.ok(descendants(rendered).some(node => node.type === 'tr' && node.props.class === 'table-warning'));
    assert.doesNotMatch(text(rendered), /Remove selected/);
    const withRemoval = TaskList({ tasks: sample, onRemove: async () => ({}) });
    assert.match(text(withRemoval), /Remove selected \(0\)/);
    assert.match(text(withRemoval), /Select stale/);
    assert.strictEqual(descendants(withRemoval).filter(node => node.type === 'button' && text(node) === 'Remove').length, 4);
    const checkboxes = descendants(withRemoval).filter(node => node.type === 'input' && node.props.type === 'checkbox' && /^Select /.test(node.props['aria-label'] || ''));
    assert.ok(checkboxes.length >= 4);
    for (const value of [null, undefined, NaN, Infinity, 1e20]) assert.strictEqual(formatTaskDate(value), '—');
    assert.notStrictEqual(formatTaskDate(0), '—');
    assert.match(text(TaskList({})), /No tracked tasks/);
    assert.match(text(TaskList({ loading: true })), /Loading tasks/);
    assert.doesNotMatch(text(TaskList({ loading: true })), /No tracked tasks/);
    assert.match(text(TaskList({ error: 'Fetch failed' })), /Fetch failed/);
    assert.doesNotMatch(text(TaskList({ error: 'Fetch failed' })), /No tracked tasks/);
    const labels = {
        submitting: 'Submitting / launching worker', waiting_registration: 'Waiting for worker registration',
        queued: 'Queued', assigned: 'Assigned to worker', failed: 'Failed', completed: 'Completed',
        canceled: 'Canceled', unknown: 'Unknown'
    };
    for (const [state, label] of Object.entries(labels)) {
        const rendered = text(TaskList({ tasks: [{ uuid: 'task-1', name: 'Flight', state,
            imagesCount: 0, dateCreated: null, tapisJobId: 'tapis-1', node: null }] }));
        assert.ok(rendered.includes(label));
        assert.ok(rendered.includes('Unassigned'));
        assert.ok(rendered.includes('tapis-1'));
        assert.ok(rendered.includes('0'), 'zero images must remain visible');
    }
    const payload = '<img src=x onerror=alert(1)>';
    const tree = TaskList({ tasks: [{ uuid: payload, name: payload, state: 'unexpected',
        tapisJobId: payload, node: { hostname: payload, port: 3001 }, imagesCount: null, dateCreated: null }] });
    assert.ok(text(tree).includes(payload), 'untrusted values remain plain text children');
    assert.match(text(tree), /Unknown/);
    assert.ok(text(tree).includes(`${payload}:3001`));
    assert.ok(!descendants(tree).some(node => ['img', 'script'].includes(node.type)));
    assert.ok(!descendants(tree).some(node => node.props.dangerouslySetInnerHTML));
    assert.ok(descendants(tree).some(node => node.type === 'details'));
    assert.match(text(tree), /Last Activity/);
    assert.ok(descendants(tree).some(node => node.type === 'span' && node.props.class.includes('badge')));
}

async function testNodeList(html) {
    global.__nodeUi = {html, useState: initial => [initial, () => {}],
        postFetch: () => {}, deleteFetch: () => {}, DeleteInstanceDialog: () => {}};
    const source = read('../public/component/nodeList.mjs').replace(/^import .*;\r?\n/gm, '');
    const {NodeList, nodeUrl} = await import(moduleUrl(`const {html, useState, postFetch, deleteFetch, DeleteInstanceDialog} = globalThis.__nodeUi;\n${source}`));
    assert.match(text(NodeList({})), /No registered nodes/);
    const rows = [{name: 'Missing metadata'}, {name: 'Worker', isOnline: true,
        nodeData: {hostname: 'worker.example', port: 3001, token: 'never-in-link', info: {totalMemory: 0}}}];
    const tree = NodeList({nodes: rows});
    assert.match(text(tree), /Missing metadata/);
    assert.ok(!descendants(tree).some(node => node.type === 'a'), 'no worker link in the page');
    assert.ok(!JSON.stringify(tree).includes('never-in-link'), 'the token must not be rendered');
    const open = descendants(tree).find(node => node.type === 'button' && text(node) === 'Open node');
    assert.ok(open, 'Open node is a button that asks the server for the URL');
    assert.strictEqual(typeof open.props.onClick, 'function');
    assert.strictEqual(nodeUrl({hostname: '::1', port: 443}), 'https://[::1]/');
    for (const hostname of ['javascript:alert(1)', 'user@host', 'host/path', 'host?token=x', 'bad host']) {
        assert.strictEqual(nodeUrl({hostname, port: 3001}), null);
    }
    for (const port of [0, 65536, 'bad']) assert.strictEqual(nodeUrl({hostname: 'worker', port}), null);
    delete global.__nodeUi;
}

async function testHeader(html) {
    global.__headerUi = {html};
    const source = read('../public/component/header.mjs')
        .replace(/^import .*;\r?\n/m, 'const {html} = globalThis.__headerUi;\n');
    const {Header} = await import(moduleUrl(source));
    let signedOut = false;
    const tree = Header({info: {name: 'ClusterODX', version: 'test'}, onSignout: () => { signedOut = true; }});
    assert.match(text(tree), /ClusterODX/);
    const button = descendants(tree).find(node => node.type === 'button');
    assert.match(text(button), /Sign out/);
    button.props.onClick();
    assert.strictEqual(signedOut, true);
    delete global.__headerUi;
}

// A small deterministic hook runtime exercises App's effects without a browser or network.
function hooksHarness() {
    const slots = [];
    let cursor = 0;
    let effects = [];
    const changed = (previous, next) => !previous || next.some((value, index) => value !== previous[index]);
    const hooks = {
        useState(initial) {
            const index = cursor++;
            if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
            return [slots[index].value, value => {
                slots[index].value = typeof value === 'function' ? value(slots[index].value) : value;
            }];
        },
        useRef(initial) {
            const index = cursor++;
            if (!slots[index]) slots[index] = { current: initial };
            return slots[index];
        },
        useCallback(callback, deps) {
            const index = cursor++;
            if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { value: callback, deps };
            return slots[index].value;
        },
        useEffect(effect, deps) {
            const index = cursor++;
            const previous = slots[index];
            if (!previous || changed(previous.deps, deps)) {
                slots[index] = { deps, cleanup: previous && previous.cleanup };
                effects.push(() => {
                    if (slots[index].cleanup) slots[index].cleanup();
                    slots[index].cleanup = effect();
                });
            }
        }
    };
    return { hooks, render(App) {
        cursor = 0;
        effects = [];
        const tree = App();
        for (const effect of effects) effect();
        return tree;
    }, unmount() {
        for (const slot of slots) if (slot && typeof slot.cleanup === 'function') slot.cleanup();
    } };
}

async function testApp(html) {
    const harness = hooksHarness();
    const timers = new Map();
    const listeners = new Map();
    const taskResponses = [];
    const calls = [];
    let cleared = 0;
    let timerId = 0;
    const originalInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalWindow = global.window;
    global.window = {
        addEventListener: (name, callback) => listeners.set(name, callback),
        removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); }
    };
    global.setInterval = (callback, delay) => {
        assert.strictEqual(delay, 5000);
        timers.set(++timerId, callback);
        return timerId;
    };
    global.clearInterval = id => timers.delete(id);
    const posts = [];
    const components = Object.fromEntries(['TaskList', 'NodeList', 'SplatList', 'Header', 'RefreshButton', 'AddInstanceButton']
        .map(name => [name, Object.defineProperty(() => {}, 'name', { value: name })]));
    global.__taskUi = { html, ...harness.hooks, ...components,
        clearAdminToken: () => { cleared++; },
        getStartupToken: () => '', validateAdminToken: async () => true, cancelAdminValidation: () => {},
        postFetch: async (url, { body }) => {
            posts.push({ url, body });
            return { ok: true, json: async () => ({ results: [{ uuid: body.uuids[0], outcome: 'removed' }], persist: 'ok' }) };
        },
        getFetch: async url => {
            calls.push(url);
            if (url === '/r/info') return response({ name: 'ClusterODX', version: 'test' });
            if (url === '/r/node/list') return response([{ name: 'worker' }]);
            if (url === '/r/splat/list') return response([]);
            assert.strictEqual(url, '/r/task/list');
            assert.ok(taskResponses.length, 'unexpected task fetch');
            return await taskResponses.shift();
        }
    };
    let source = read('../public/app.mjs').replace(/^import .*;\r?\n/gm, '');
    source = `const { html, useState, useEffect, useCallback, useRef, TaskList, NodeList, SplatList, Header,
        RefreshButton, AddInstanceButton, clearAdminToken, getFetch, postFetch, getStartupToken,
        validateAdminToken, cancelAdminValidation } = globalThis.__taskUi;\n${source}`;
    try {
        const { default: App } = await import(moduleUrl(source));
        let tree;
        const render = () => { tree = harness.render(App); return tree; };
        const component = name => descendants(tree).find(node => typeof node.type === 'function' && node.type.name === name);
        const refresh = () => descendants(tree).find(node => node.type === 'button' && text(node) === 'Refresh').props.onClick();
        const login = () => component('Login').props.onAuthenticated();
        render();
        assert.strictEqual(calls.length, 0, 'no polling before authentication');
        const initial = deferred();
        taskResponses.push(initial.promise);
        login();
        render();
        render();
        assert.strictEqual(component('TaskList').props.loading, true);
        assert.deepStrictEqual(calls, ['/r/info', '/r/node/list', '/r/task/list', '/r/splat/list']);
        initial.resolve(response([{ uuid: 'first' }]));
        await turn();
        render();
        assert.deepStrictEqual(component('TaskList').props.tasks, [{ uuid: 'first' }]);
        assert.strictEqual(component('TaskList').props.loading, false);
        // Task removal is wired through postFetch and surfaces the server's results.
        const removal = await component('TaskList').props.onRemove(['u1'], { dryRun: true, stopWorker: true });
        assert.deepStrictEqual(posts[0], { url: '/r/task/remove', body: { uuids: ['u1'], dryRun: true, stopWorker: true } });
        assert.strictEqual(removal.results[0].outcome, 'removed');
        assert.strictEqual(typeof component('TaskList').props.onChanged, 'function');

        const older = deferred();
        const newer = deferred();
        taskResponses.push(older.promise, newer.promise);
        const oldRefresh = refresh();
        const newRefresh = refresh();
        newer.resolve(response([{ uuid: 'newest' }]));
        await newRefresh;
        older.resolve(response([{ uuid: 'stale' }]));
        await oldRefresh;
        render();
        assert.deepStrictEqual(component('TaskList').props.tasks, [{ uuid: 'newest' }]);
        taskResponses.push(Promise.resolve({ ok: false, status: 500 }));
        await refresh();
        render();
        assert.match(component('TaskList').props.error, /Unable to load tasks/);
        assert.deepStrictEqual(component('TaskList').props.tasks, [{ uuid: 'newest' }]);

        component('RefreshButton').props.setAutoRefresh({ isAutoRefresh: true });
        render();
        assert.strictEqual(timers.size, 1);
        taskResponses.push(Promise.resolve(response([{ uuid: 'auto' }])));
        await [...timers.values()][0]();
        render();
        assert.deepStrictEqual(component('TaskList').props.tasks, [{ uuid: 'auto' }]);
        assert.strictEqual(component('TaskList').props.error, '');
        component('RefreshButton').props.setAutoRefresh({ isAutoRefresh: false });
        render();
        assert.strictEqual(timers.size, 0, 'disable must stop polling');

        const lateLogout = deferred();
        taskResponses.push(lateLogout.promise);
        const beforeLogout = refresh();
        component('RefreshButton').props.setAutoRefresh({ isAutoRefresh: true });
        render();
        component('Header').props.onSignout();
        render();
        assert.strictEqual(cleared, 1);
        assert.strictEqual(timers.size, 0, 'logout must stop polling');
        assert.ok(component('Login'));
        lateLogout.resolve(response([{ uuid: 'signed-out-data' }]));
        await beforeLogout;
        taskResponses.push(Promise.resolve(response([{ uuid: 'new-session' }])));
        login();
        render();
        await turn();
        render();
        assert.deepStrictEqual(component('TaskList').props.tasks, [{ uuid: 'new-session' }]);

        const lateExpiry = deferred();
        taskResponses.push(lateExpiry.promise);
        const beforeExpiry = refresh();
        component('RefreshButton').props.setAutoRefresh({ isAutoRefresh: true });
        render();
        listeners.get('clusterodx-auth-expired')();
        render();
        assert.strictEqual(timers.size, 0, 'expired authentication must stop polling');
        assert.ok(component('Login'));
        const nextSession = deferred();
        taskResponses.push(nextSession.promise);
        login();
        render();
        lateExpiry.resolve(response([{ uuid: 'expired-session' }]));
        await beforeExpiry;
        render();
        assert.deepStrictEqual(component('TaskList').props.tasks, [], 'old session must not repopulate after relogin');
        nextSession.resolve(response([{ uuid: 'final-session' }]));
        await turn();
        render();
        assert.deepStrictEqual(component('TaskList').props.tasks, [{ uuid: 'final-session' }]);
        component('RefreshButton').props.setAutoRefresh({ isAutoRefresh: true });
        render();
        assert.strictEqual(timers.size, 1);
        harness.unmount();
        assert.strictEqual(timers.size, 0, 'unmount must stop polling');
        assert.strictEqual(listeners.size, 0, 'unmount must remove auth listener');
        assert.strictEqual(taskResponses.length, 0);
    } finally {
        harness.unmount();
        global.setInterval = originalInterval;
        global.clearInterval = originalClearInterval;
        global.window = originalWindow;
        delete global.__taskUi;
    }
}

(async () => {
    const html = await makeHtml();
    await testTaskList(html);
    await testNodeList(html);
    await testHeader(html);
    await testApp(html);
    console.log('ADMIN TASK UI TEST PASSED');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
