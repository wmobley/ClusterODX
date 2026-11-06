'use strict';

const path = require('path');
const config = require('../config');
const logger = require('./logger');
const statusCodes = require('./statusCodes');

const FALLBACK_SHARED_PATH_MAPPINGS = {
    '*': {
        '/corral/webodm/media': '/corral/utexas/BCS26030/webodm/media'
    }
};

const extractBearerToken = (headers = {}) => {
    const value = headers.authorization || headers.Authorization || '';
    const match = String(value).match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
};

const normalizeRegistration = (payload = {}) => {
    const hostname = typeof payload.hostname === 'string' ? payload.hostname.trim() : '';
    const port = Number(payload.port);

    if (!hostname || /[\s/?#]/.test(hostname)) throw new Error('Invalid hostname');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');

    return {
        hostname,
        port,
        nodeToken: typeof payload.token === 'string' ? payload.token : '',
        tapisToken: typeof payload.tapisToken === 'string' ? payload.tapisToken : null,
        registrationSecret: typeof payload.registrationSecret === 'string' ? payload.registrationSecret : null,
        registrationUuid: typeof payload.registrationUuid === 'string' ? payload.registrationUuid : null,
        tapisJobUuid: typeof payload.tapisJobUuid === 'string' ? payload.tapisJobUuid : null,
        nodeReady: !!payload.nodeReady,
        role: typeof payload.role === 'string' ? payload.role : null,
        // Checkpoint resume: the worker says it restored a checkpoint (or why it could not).
        checkpointResume: payload.checkpointResume === true,
        resumeTaskUuid: typeof payload.resumeTaskUuid === 'string' ? payload.resumeTaskUuid : null,
        resumeMode: typeof payload.resumeMode === 'string' ? payload.resumeMode : null,
        resumeFallbackReason: typeof payload.resumeFallbackReason === 'string' && payload.resumeFallbackReason.trim() !== ''
            ? payload.resumeFallbackReason.trim().slice(0, 200) : null,
        metadata: {
            childIndex: payload.childIndex !== undefined ? payload.childIndex : null,
            role: payload.role || null,
            hostId: payload.hostId !== undefined ? payload.hostId : null,
            workerId: payload.workerId !== undefined ? payload.workerId : null,
            jobIndex: payload.jobIndex !== undefined ? payload.jobIndex : null,
            jobCount: payload.jobCount !== undefined ? payload.jobCount : null,
            replicasPerJob: payload.replicasPerJob !== undefined ? payload.replicasPerJob : null,
            registrationUuid: typeof payload.registrationUuid === 'string' ? payload.registrationUuid : null,
            tapisJobUuid: typeof payload.tapisJobUuid === 'string' ? payload.tapisJobUuid : null,
            // Worker checkpoint schema; >= 2 means teardown can wait for a synced checkpoint.
            schemaVersion: Number.isInteger(Number(payload.schemaVersion)) && payload.schemaVersion !== null && payload.schemaVersion !== ''
                ? Number(payload.schemaVersion) : null
        }
    };
};

const expandEnv = (value) => {
    if (typeof value !== 'string') return value;
    return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([^}]+)\}/g,
                         (_match, p1, p2) => process.env[p1 || p2] || _match);
};

const translateImportPathForNode = (importPath, nodeHostname) => {
    if (!importPath) return null;
    const mappings = config.node_shared_path_mappings ||
        config.NODE_SHARED_PATH_MAPPINGS || FALLBACK_SHARED_PATH_MAPPINGS;
    const candidates = [];
    if (nodeHostname) candidates.push(nodeHostname);
    if (nodeHostname && nodeHostname.indexOf('.') !== -1) candidates.push(nodeHostname.split('.')[0]);
    candidates.push('*');

    for (const host of candidates){
        const mapForHost = mappings[host];
        if (!mapForHost) continue;
        for (const sourcePrefix of Object.keys(mapForHost)){
            const source = expandEnv(sourcePrefix);
            const destination = expandEnv(mapForHost[sourcePrefix]);
            if (!source || !destination) continue;
            const isExact = importPath === source;
            const hasBoundary = importPath.indexOf(source.endsWith(path.sep) ? source : source + path.sep) === 0;
            if (!isExact && !hasBoundary) continue;

            let remainder = importPath.slice(source.length);
            if (remainder && !remainder.startsWith(path.sep) && !destination.endsWith(path.sep)) remainder = path.sep + remainder;
            const translated = path.normalize(destination + remainder);
            const normalizedDestination = path.normalize(destination);
            if (translated === normalizedDestination || translated.indexOf(normalizedDestination + path.sep) === 0) return translated;
        }
    }

    return path.normalize(importPath);
};

// Registration of a worker that was started to resume a checkpoint. There is no
// upload: the worker already holds the task, so the job is only wired in.
//
// Success: add the route for the target uuid, THEN delete its task-table entry, so
// a poll between the two steps finds the route (or the old entry), never nothing.
// Failure (the worker reports a fallback reason, or does not acknowledge the
// resume at all, as an old worker image would): fail the task in the task table
// with "Resume failed: <reason>", record it in the registry and cancel the job
// through the Tapis API. Nothing is handed off. Never cold-starts.
//
// Returns { mode: 'resumed' } or { mode: 'failed', reason }. Throws only when the
// success path cannot be completed (the caller answers 502 so the worker retries).
const completeResumeRegistration = async ({ pending, node, registration, provider, routetable, tasktable }) => {
    const target = pending.taskId;
    const reason = registration.resumeFallbackReason ||
        (registration.checkpointResume ? null : 'resume_not_acknowledged');

    if (!reason) {
        if (!pending.token) throw new Error(`No owner token to route resumed task ${target}`);
        await routetable.add(target, node, pending.token);
        await tasktable.delete(target);
        logger.info(`Routed checkpoint-resumed task ${target} to ${node.hostname()}:${node.port()} (mode ${registration.resumeMode || 'unspecified'})`);
        return { mode: 'resumed' };
    }

    const message = `Resume failed: ${reason}`;
    const existing = await tasktable.lookup(target);
    const info = existing && existing.taskInfo || {};
    await tasktable.add(target, Object.assign({}, existing || {}, {
        taskInfo: Object.assign({ uuid: target, name: target, dateCreated: Date.now(), progress: 0, processingTime: -1 }, info,
            { status: { code: statusCodes.FAILED, errorMessage: message } }),
        output: ((existing && existing.output) || []).concat(message),
        abort: null
    }), pending.token || null);
    provider.recordUpsert({ jobName: pending.jobId, resumeFailure: reason });
    logger.warn(`Checkpoint resume of task ${target} failed on its worker: ${reason}; cancelling job ${pending.tapisJobId}`);
    try {
        await provider.cancelPendingTask(pending.tapisJobId, `resume failed: ${reason}`);
    } catch (error) {
        // The task is already failed; a cancel that errors must not undo the answer.
        logger.warn(`Cancel of job ${pending.tapisJobId} after failed resume errored: ${error.message}`);
    }
    return { mode: 'failed', reason };
};

module.exports = {
    completeResumeRegistration,
    extractBearerToken,
    normalizeRegistration,
    translateImportPathForNode
};
