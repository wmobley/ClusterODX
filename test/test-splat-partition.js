'use strict';
// NodeSplat must stay outside generic node scheduling, fallback, retry and /options.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const libs = path.join(__dirname, '..', 'libs');
for (const file of fs.readdirSync(libs).filter(f => /^splat.*\.js$/.test(f))) {
    const source = fs.readFileSync(path.join(libs, file), 'utf8');
    for (const forbidden of ['./nodes', './taskNew', './tasktable', './routetable', './sharedSubmodel', './asrProvider']) {
        assert(!source.includes(`require('${forbidden}')`), `${file} must not require ${forbidden}`);
    }
}

// The generic selectors only read the node registry, and splat code never writes to it.
const nodes = require('../libs/nodes');
const before = nodes.all().length;
const {SplatTasks} = require('../libs/splatTasks');
new SplatTasks({enabled: false}).close();
assert.strictEqual(nodes.all().length, before);

// Only the dedicated namespace handles /splat/*; ordinary task routes are never claimed.
(async () => {
    const service = new SplatTasks({enabled: false});
    const response = {writeHead() {}, end() {}};
    assert.strictEqual(await service.handle({url: '/task/new', method: 'POST', headers: {}}, response), false);
    assert.strictEqual(await service.handle({url: '/options', method: 'GET', headers: {}}, response), false);
    assert.strictEqual(await service.handle({url: '/info', method: 'GET', headers: {}}, response), false);
    assert.strictEqual(await service.handle({url: '/splat/task/new', method: 'POST', headers: {}}, response), true);
    console.log('NodeSplat partition tests passed');
})().catch(error => { console.error(error); process.exit(1); });
