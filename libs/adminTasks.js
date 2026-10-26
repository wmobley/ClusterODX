'use strict';

const statusCodes = require('./statusCodes');
const { safeId, safeNodeEndpoint } = require('./observability');

const finiteNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const terminalStates = new Map([
    [statusCodes.FAILED, 'failed'],
    [statusCodes.COMPLETED, 'completed'],
    [statusCodes.CANCELED, 'canceled']
]);

// Local observations only: never probe a node or return a raw record.
const listTasks = async ({ tasktable, routetable, provider = null }) => {
    // Registration adds the route before deleting pending data. Read in this order
    // so a handoff cannot disappear between the two snapshots.
    const pending = await tasktable.listSummaries();
    const routes = await routetable.findByNode();
    const rows = new Map();
    for (const summary of pending) {
        if (typeof summary.uuid !== 'string') continue;
        const match = provider && typeof provider.findPendingTask === 'function'
            ? provider.findPendingTask(summary.uuid) : null;
        const statusCode = finiteNumber(summary.statusCode);
        const tapisJobId = safeId(match && match.tapisJobId) || null;
        rows.set(summary.uuid, {
            uuid: summary.uuid,
            name: typeof summary.name === 'string' ? summary.name : summary.uuid,
            source: 'pending',
            state: terminalStates.get(statusCode) || (tapisJobId ? 'waiting_registration'
                : statusCode === statusCodes.RUNNING ? 'submitting'
                : statusCode === statusCodes.QUEUED ? 'queued' : 'unknown'),
            statusCode,
            imagesCount: finiteNumber(summary.imagesCount),
            dateCreated: finiteNumber(summary.dateCreated),
            accessed: finiteNumber(summary.accessed),
            tapisJobId,
            node: null
        });
    }
    for (const [uuid, entry] of Object.entries(routes || {})) {
        const previous = rows.get(uuid);
        const node = entry && entry.node;
        const hostname = node && typeof node.hostname === 'function' ? node.hostname() : null;
        const port = node && typeof node.port === 'function' ? node.port() : null;
        const endpoint = safeNodeEndpoint(hostname, port);
        rows.set(uuid, {
            uuid,
            name: previous ? previous.name : uuid,
            source: 'route',
            state: terminalStates.get(previous && previous.statusCode) || 'assigned',
            statusCode: previous ? previous.statusCode : null,
            imagesCount: previous ? previous.imagesCount : null,
            dateCreated: previous ? previous.dateCreated : null,
            accessed: finiteNumber(entry && entry.accessed),
            tapisJobId: safeId(node && typeof node.getTapisJobId === 'function' && node.getTapisJobId())
                || (previous && previous.tapisJobId) || null,
            node: endpoint ? { hostname, port: Number(port) } : null
        });
    }
    return Array.from(rows.values()).sort((a, b) => (b.accessed || 0) - (a.accessed || 0));
};

module.exports = { listTasks };
