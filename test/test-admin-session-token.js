const assert = require('assert');
const fs = require('fs');

(async () => {
    const stored = new Map();
    global.window = {
        sessionStorage: {
            getItem: key => stored.get(key),
            setItem: (key, value) => stored.set(key, value),
            removeItem: key => stored.delete(key),
        },
        location: { hash: '', pathname: '/', search: '' },
        history: { replaceState() {} },
        dispatchEvent() {},
    };
    const auth = await import('../public/authToken.mjs');
    global.fetch = async () => ({ ok: true, status: 200 });
    assert.strictEqual(await auth.validateAdminToken('saved'), true);
    assert.strictEqual(auth.getStartupToken(), 'saved');
    // A fresh module models page refresh: no bearer until revalidation.
    const refreshed = await import('../public/authToken.mjs?refresh');
    assert.strictEqual(refreshed.getAdminToken(), null);
    assert.strictEqual(refreshed.getStartupToken(), 'saved');
    assert.strictEqual(await refreshed.validateAdminToken(refreshed.getStartupToken()), true);
    assert.strictEqual(refreshed.getAdminToken(), 'saved');
    window.location.hash = '#token=fragment';
    assert.strictEqual(auth.getStartupToken(), 'fragment');
    window.location.hash = '';
    auth.clearAdminToken();
    assert.strictEqual(auth.getStartupToken(), '');
    assert.strictEqual(auth.getAdminToken(), null);

    for (const status of [401, 403, 500]) {
        auth.setAdminToken('saved');
        global.fetch = async () => ({ ok: false, status });
        await assert.rejects(auth.validateAdminToken('saved'), /validation failed/);
        assert.strictEqual(auth.getStartupToken(), status === 500 ? 'saved' : '');
    }
    global.fetch = async () => { throw new Error('network error'); };
    await assert.rejects(auth.validateAdminToken('saved'), /Unable to validate/);
    assert.strictEqual(auth.getStartupToken(), 'saved');

    let resolveOld;
    global.fetch = () => new Promise(resolve => { resolveOld = resolve; });
    const old = auth.validateAdminToken('old');
    auth.clearAdminToken();
    resolveOld({ ok: true });
    assert.strictEqual(await old, false);
    assert.strictEqual(auth.getAdminToken(), null);
    const older = auth.validateAdminToken('older');
    global.fetch = async () => ({ ok: true });
    await auth.validateAdminToken('newer');
    resolveOld({ ok: false, status: 401 });
    assert.strictEqual(await older, false);
    assert.strictEqual(auth.getAdminToken(), 'newer');

    // Load the browser .js module as ESM while preserving its real auth import.
    const source = fs.readFileSync(require.resolve('../public/common.fetch.js'), 'utf8')
        .replaceAll('./authToken.mjs', new URL('../public/authToken.mjs', `file://${__filename}`).href);
    const common = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    global.fetch = async (_url, options) => {
        assert.strictEqual(options.headers.Authorization, 'Bearer newer');
        return { status: 401 };
    };
    await common.getFetch('/r/info');
    assert.strictEqual(auth.getStartupToken(), '');
    assert.strictEqual(auth.getAdminToken(), null);

    Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked'); } });
    global.fetch = async () => ({ ok: true });
    assert.strictEqual(await auth.validateAdminToken('memory-only'), true);
    assert.strictEqual(auth.getAdminToken(), 'memory-only');
    assert.strictEqual(auth.getStartupToken(), '');
    auth.clearAdminToken();
    console.log('ADMIN SESSION TOKEN TEST PASSED');
})().catch(error => { console.error(error); process.exitCode = 1; });
