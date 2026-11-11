'use strict';

const assert = require('assert');
const Node = require('../libs/classes/Node');
const nodes = require('../libs/nodes');
const { nodeOwnedBy } = require('../libs/tapisIdentity');

const identity = (username, tenantId = 'portals') => ({ username, tenantId, fullUser: `${username}@${tenantId}` });

function worker(hostname, owner, tenant = 'portals') {
    const node = new Node(hostname, 3001, 'worker-token');
    node.isOnline = () => true;
    node.nodeData.info = { maxParallelTasks: 1, taskQueueCount: 0 };
    if (owner) node.nodeData.tapisJobOwner = owner;
    if (owner && tenant) node.nodeData.tapisJobOwnerTenant = tenant;
    return node;
}

async function main() {
    // Ownership rules: owner and tenant must both be recorded and match.
    assert.strictEqual(nodeOwnedBy(worker('a', 'Will').nodeData, identity('will')), true, 'case-insensitive match');
    assert.strictEqual(nodeOwnedBy(worker('a', 'will@portals').nodeData, identity('will')), true, 'user@tenant owner form');
    assert.strictEqual(nodeOwnedBy(worker('a', 'will').nodeData, identity('other')), false, 'different user');
    assert.strictEqual(nodeOwnedBy(worker('a', 'will', 'tacc').nodeData, identity('will')), false, 'different tenant');
    assert.strictEqual(nodeOwnedBy(worker('a', 'will', '').nodeData, identity('will')), false, 'tenant not recorded');
    assert.strictEqual(nodeOwnedBy(worker('a', null).nodeData, identity('will')), false, 'unowned node belongs to nobody');
    assert.strictEqual(nodeOwnedBy(worker('a', 'will').nodeData, null), false, 'unknown identity owns nothing');

    const mine = worker('mine', 'analacau');
    const theirs = worker('theirs', 'wmobley');
    const unowned = worker('unowned', null);
    [theirs, unowned, mine].forEach(node => nodes.add(node));

    assert.strictEqual(await nodes.findBestAvailableNode(10, false, identity('analacau')), mine, 'user gets own node');
    assert.strictEqual(await nodes.findBestAvailableNode(10, false, identity('wmobley')), theirs, 'owner of the other node gets it');
    assert.strictEqual(await nodes.findBestAvailableNode(10, false, identity('stranger')), null, 'no node: caller starts a job');
    assert.strictEqual(await nodes.findBestAvailableNode(10, false, null), null, 'unknown identity matches nothing');

    // A user whose own node is offline must not spill onto someone else's node.
    mine.isOnline = () => false;
    assert.strictEqual(await nodes.findBestAvailableNode(10, false, identity('analacau')), null, 'own node offline');

    // Without an owner argument (non-Tapis setups) selection is unchanged.
    assert.ok([theirs, unowned].includes(await nodes.findBestAvailableNode(10, false)), 'unrestricted selection');

    console.log('node owner selection passed');
}

main().catch(error => { console.error(error); process.exit(1); });
