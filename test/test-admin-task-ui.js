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
    global.__taskUi = { html };
    const source = read('../public/component/taskList.mjs')
        .replace(/^import .*;$/m, 'const { html } = globalThis.__taskUi;');
    const { TaskList } = await import(moduleUrl(source));
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
    const components = Object.fromEntries(['TaskList', 'NodeList', 'Header', 'RefreshButton', 'AddInstanceButton']
        .map(name => [name, Object.defineProperty(() => {}, 'name', { value: name })]));
    global.__taskUi = { html, ...harness.hooks, ...components,
        clearAdminToken: () => { cleared++; },
        getStartupToken: () => '', validateAdminToken: async () => true, cancelAdminValidation: () => {},
        getFetch: async url => {
            calls.push(url);
            if (url === '/r/info') return response({ name: 'ClusterODX', version: 'test' });
            if (url === '/r/node/list') return response([{ name: 'worker' }]);
            assert.strictEqual(url, '/r/task/list');
            assert.ok(taskResponses.length, 'unexpected task fetch');
            return await taskResponses.shift();
        }
    };
    let source = read('../public/app.mjs').replace(/^import .*;\r?\n/gm, '');
    source = `const { html, useState, useEffect, useCallback, useRef, TaskList, NodeList, Header,
        RefreshButton, AddInstanceButton, clearAdminToken, getFetch, getStartupToken,
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
        assert.deepStrictEqual(calls, ['/r/info', '/r/node/list', '/r/task/list']);
        initial.resolve(response([{ uuid: 'first' }]));
        await turn();
        render();
        assert.deepStrictEqual(component('TaskList').props.tasks, [{ uuid: 'first' }]);
        assert.strictEqual(component('TaskList').props.loading, false);

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
    await testApp(html);
    console.log('ADMIN TASK UI TEST PASSED');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
