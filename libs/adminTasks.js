'use strict';

const statusCodes = require('./statusCodes');
const { safeId, safeNodeEndpoint } = require('./observability');
const { ownerLabel } = require('./tapisIdentity');
const { isNodeBusy } = require('./nodeBusy');
const TapisJobRegistry = require('./tapisJobRegistry');

const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const MAX_REMOVE_BATCH = 25;
const MAX_WORKERS_PER_REQUEST = 10;
const REMOVE_CONCURRENCY = 5;
const UUID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const has = (object, key) => !!object && Object.prototype.hasOwnProperty.call(object, key);
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const terminalStates = new Map([
    [statusCodes.FAILED, 'failed'],
    [statusCodes.COMPLETED, 'completed'],
    [statusCodes.CANCELED, 'canceled']
]);

const pendingOwner = pending => pending
    ? ownerLabel(null, { owner: pending.tapisJobOwner || pending.nodeUser, tenant: pending.tapisJobOwnerTenant })
    : null;
const nodeOwner = node => node && node.nodeData
    ? ownerLabel(null, { owner: node.nodeData.tapisJobOwner, tenant: node.nodeData.tapisJobOwnerTenant })
    : null;
const flag = (node, method) => node && typeof node[method] === 'function' ? Boolean(node[method]()) : null;

// Local observations only: never probe a node or return a raw record.
// `stale` is advisory. Routed rows are stale only when their worker is offline
// (WebODM polls keep `accessed` fresh for healthy jobs); pending rows are stale
// once they have been silent for `staleAfterMs`. Terminal rows are never stale.
const listTasks = async ({ tasktable, routetable, provider = null, staleAfterMs = DEFAULT_STALE_AFTER_MS, now = Date.now() }) => {
    // Registration adds the route before deleting pending data. Read in this order
    // so a handoff cannot disappear between the two snapshots.
    const pending = await tasktable.listSummaries();
    const routes = await routetable.findByNode();
    const rows = new Map();
    const findPending = uuid => provider && typeof provider.findPendingTask === 'function'
        ? provider.findPendingTask(uuid) : null;
    for (const summary of pending) {
        if (typeof summary.uuid !== 'string') continue;
        const match = findPending(summary.uuid);
        const statusCode = finiteNumber(summary.statusCode);
        const tapisJobId = safeId(match && match.tapisJobId) || null;
        const state = terminalStates.get(statusCode) || (tapisJobId ? 'waiting_registration'
            : statusCode === statusCodes.RUNNING ? 'submitting'
            : statusCode === statusCodes.QUEUED ? 'queued' : 'unknown');
        const accessed = finiteNumber(summary.accessed);
        const inactive = !terminalStates.has(statusCode) && accessed !== null && now - accessed > staleAfterMs;
        rows.set(summary.uuid, {
            uuid: summary.uuid,
            name: typeof summary.name === 'string' ? summary.name : summary.uuid,
            source: 'pending',
            state,
            statusCode,
            imagesCount: finiteNumber(summary.imagesCount),
            dateCreated: finiteNumber(summary.dateCreated),
            accessed,
            tapisJobId,
            node: null,
            owner: (typeof summary.owner === 'string' && summary.owner) || pendingOwner(match) || null,
            stale: inactive,
            staleReason: inactive ? 'inactive' : null
        });
    }
    for (const [uuid, entry] of Object.entries(routes || {})) {
        const previous = rows.get(uuid);
        const node = entry && entry.node;
        const hostname = node && typeof node.hostname === 'function' ? node.hostname() : null;
        const port = node && typeof node.port === 'function' ? node.port() : null;
        const endpoint = safeNodeEndpoint(hostname, port);
        const state = terminalStates.get(previous && previous.statusCode) || 'assigned';
        const online = flag(node, 'isOnline');
        const offline = state === 'assigned' && online === false;
        rows.set(uuid, {
            uuid,
            name: previous ? previous.name : uuid,
            source: 'route',
            state,
            statusCode: previous ? previous.statusCode : null,
            imagesCount: previous ? previous.imagesCount : null,
            dateCreated: previous ? previous.dateCreated : null,
            accessed: finiteNumber(entry && entry.accessed),
            tapisJobId: safeId(node && typeof node.getTapisJobId === 'function' && node.getTapisJobId())
                || (previous && previous.tapisJobId) || null,
            node: endpoint ? { hostname, port: Number(port), online, autoSpawned: flag(node, 'isAutoSpawned') } : null,
            owner: ownerLabel(entry && entry.token) || (previous && previous.owner)
                || pendingOwner(findPending(uuid)) || nodeOwner(node) || null,
            stale: offline,
            staleReason: offline ? 'worker_offline' : null
        });
    }
    return Array.from(rows.values()).sort((a, b) => (b.accessed || 0) - (a.accessed || 0));
};

// ---------------------------------------------------------------------------
// Removal (admin write path). See docs/design/2026-11-04-admin-task-owner-and-removal.md
// ---------------------------------------------------------------------------

// Error strings can carry worker output; never return or log credentials.
const sanitizeError = error => {
    let text = String(error && error.message ? error.message : error)
        .replace(/[\u0000-\u001f\u007f]/g, ' ');
    const pattern = new RegExp(TapisJobRegistry.SENSITIVE_VALUE_PATTERN.source, 'gi');
    text = text.replace(pattern, '[redacted]').replace(/\[redacted\][^\s&"']*/g, '[redacted]');
    return text.slice(0, 200);
};

const runPool = async (items, limit, work) => {
    const results = new Array(items.length);
    let next = 0;
    const lane = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
    return results;
};

// Steps 1-3 for one task: pending cancel, tasktable, worker route. Identity is
// resolved only against tasktable and route keys; a pending record counts only
// when its taskId is this uuid (never a job name or a Tapis job UUID).
const removeTaskRecords = async (uuid, { dryRun, deps }) => {
    const { tasktable, routetable, provider, utils } = deps;
    const steps = { pendingCancelled: false, tasktableRemoved: false, workerRemove: null, routeRemoved: false, workerStopped: null };
    const errors = [];
    const attempt = async (label, work) => {
        try { return await work(); } catch (error) { errors.push(`${label}: ${sanitizeError(error)}`); return undefined; }
    };

    const pending = provider && typeof provider.findPendingTask === 'function' ? provider.findPendingTask(uuid) : null;
    const routes = await routetable.findByNode();
    const route = has(routes, uuid) ? routes[uuid] : null;
    const summaries = await tasktable.listSummaries();
    const summary = summaries.find(item => item.uuid === uuid) || null;
    const owner = ownerLabel(route && route.token) || (summary && summary.owner)
        || pendingOwner(pending && pending.taskId === uuid ? pending : null) || nodeOwner(route && route.node) || null;
    const node = route && route.node || null;

    if (pending && pending.taskId === uuid && typeof provider.cancelPendingTask === 'function') {
        if (dryRun) steps.pendingCancelled = true;
        else steps.pendingCancelled = Boolean(await attempt('pending cancel', () => provider.cancelPendingTask(uuid)));
    }

    if (summary) {
        if (dryRun) steps.tasktableRemoved = true;
        else {
            const entry = await attempt('tasktable', () => tasktable.take(uuid));
            steps.tasktableRemoved = Boolean(entry);
            if (entry && typeof entry.abort === 'function') await attempt('abort', async () => entry.abort());
            await attempt('tmp cleanup', async () => utils.rmdir(`tmp/${uuid}`));
        }
    }

    if (route) {
        if (dryRun) {
            steps.routeRemoved = true;
            steps.workerRemove = 'skipped: dry run';
        } else {
            if (node && typeof node.taskRemove === 'function') {
                try {
                    const response = await node.taskRemove(uuid);
                    steps.workerRemove = response && response.error ? `failed: ${sanitizeError(response.error)}` : 'ok';
                } catch (error) {
                    steps.workerRemove = `failed: ${sanitizeError(error)}`;
                }
            } else steps.workerRemove = 'failed: no worker';
            steps.routeRemoved = Boolean(await attempt('route', () => routetable.remove(uuid, { persist: false })));
        }
    }

    const found = steps.pendingCancelled || steps.tasktableRemoved || steps.routeRemoved;
    const outcome = found ? 'removed' : (errors.length ? 'failed' : 'not_found');
    return { uuid, outcome, owner, steps, node, errors };
};

// Step 4: stop each distinct idle auto-spawned worker once, after every task in
// the request has been detached from it.
const stopWorkers = async (workers, { dryRun, deps }) => {
    const { routetable, nodes, provider, netutils } = deps;
    const decisions = new Map();
    let handled = 0;
    for (const node of workers.keys()) {
        if (handled >= MAX_WORKERS_PER_REQUEST) { decisions.set(node, 'skipped: worker cap'); continue; }
        handled++;
        if (!(typeof node.isAutoSpawned === 'function' && node.isAutoSpawned())) {
            decisions.set(node, 'skipped: not auto-spawned');
            continue;
        }
        const wasLocked = typeof node.isLocked === 'function' && node.isLocked();
        try {
            node.setLocked(true);
            const routes = await routetable.findByNode(node);
            const remaining = Object.keys(routes || {}).filter(uuid => !(dryRun && workers.get(node).has(uuid)));
            if (isNodeBusy(node, remaining.length)) {
                node.setLocked(wasLocked);
                decisions.set(node, 'skipped: worker busy');
                continue;
            }
            if (dryRun) {
                node.setLocked(wasLocked);
                decisions.set(node, 'would stop');
                continue;
            }
            const tapisJobId = typeof node.getTapisJobId === 'function' ? node.getTapisJobId() : null;
            if (tapisJobId && provider && typeof provider.destroyNode === 'function') {
                const active = provider.activeJobs && typeof provider.activeJobs.get === 'function' ? provider.activeJobs.get(tapisJobId) : null;
                const hadToken = Boolean(active && active.token);
                const cancelled = await provider.destroyNode(node);
                decisions.set(node, cancelled ? 'cancelled' : (hadToken ? 'cancel_failed' : 'unreachable'));
                await routetable.removeByNode(node);
                nodes.remove(node);
                await nodes.saveToDisk();
            } else {
                const removed = await netutils.removeAndCleanupNode(node, provider);
                decisions.set(node, removed ? 'removed' : 'failed: cleanup');
            }
        } catch (error) {
            try { node.setLocked(wasLocked); } catch (_) { /* best effort */ }
            decisions.set(node, `failed: ${sanitizeError(error)}`);
        }
    }
    return decisions;
};

// Validates the request body shape shared by the endpoint and the tests.
const parseRemoveRequest = body => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Expected a JSON object' };
    const { uuids, stopWorker = false, dryRun = false } = body;
    if (!Array.isArray(uuids) || uuids.length < 1 || uuids.length > MAX_REMOVE_BATCH) {
        return { error: `uuids must list 1 to ${MAX_REMOVE_BATCH} task ids` };
    }
    if (!uuids.every(uuid => typeof uuid === 'string' && UUID_PATTERN.test(uuid))) return { error: 'uuids contains an invalid task id' };
    if (typeof stopWorker !== 'boolean' || typeof dryRun !== 'boolean') return { error: 'stopWorker and dryRun must be booleans' };
    return { uuids: Array.from(new Set(uuids)), stopWorker, dryRun };
};

const removeTasks = async ({ uuids, stopWorker = false, dryRun = false, admin = null, deps }) => {
    const { routetable, logger } = deps;
    const settled = await runPool(uuids, REMOVE_CONCURRENCY, uuid => removeTaskRecords(uuid, { dryRun, deps }));

    // Group routed tasks by worker so each worker is evaluated once, after all of
    // this request's tasks have been detached from it.
    const workers = new Map();
    if (stopWorker) {
        for (const result of settled) {
            if (!result.node || (!result.steps.routeRemoved)) continue;
            if (!workers.has(result.node)) workers.set(result.node, new Set());
            workers.get(result.node).add(result.uuid);
        }
    }
    const decisions = workers.size ? await stopWorkers(workers, { dryRun, deps }) : new Map();

    let persist = 'ok';
    if (!dryRun && settled.some(result => result.steps.routeRemoved)) {
        try { await routetable.saveToDisk(); } catch (_) { persist = 'failed'; }
    }

    const results = settled.map(result => {
        const decision = result.node && decisions.has(result.node) ? decisions.get(result.node) : null;
        const steps = Object.assign({}, result.steps);
        if (dryRun) { delete steps.workerStopped; steps.wouldStopWorker = decision === 'would stop' ? true : (decision || null); }
        else steps.workerStopped = decision;
        const response = { uuid: result.uuid, outcome: result.outcome, owner: result.owner, steps };
        if (result.errors.length) response.errors = result.errors;
        logger.info(`[ADMIN] task remove ${JSON.stringify({
            uuid: result.uuid, owner: result.owner, admin: admin && admin.label || null,
            remoteAddress: admin && admin.remoteAddress || null, outcome: result.outcome,
            stopWorker, dryRun, steps
        })}`);
        return response;
    });
    return { dryRun, persist, results };
};

module.exports = {
    listTasks, removeTasks, parseRemoveRequest, sanitizeError,
    DEFAULT_STALE_AFTER_MS, MAX_REMOVE_BATCH, UUID_PATTERN
};
