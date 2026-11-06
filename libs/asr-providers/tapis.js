'use strict';

const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const config = require('../../config');
const AbstractASRProvider = require('../classes/AbstractASRProvider');
const tapisTaskOptions = require('../tapisTaskOptions');
// Supplements the legacy fallback with options in NodeODX's public schema.
const nodeodxExtraOptions = require('../nodeodx-extra-options');
const logger = require('../logger');
const statusCodes = require('../statusCodes');
const { extractUserFromToken, describeTokenUser } = require('../tapisIdentity');
const { cancelTapisJob, isTerminalOutcome } = require('../tapisCancel');
const TapisJobRegistry = require('../tapisJobRegistry');
const tapisCheckpoint = require('../tapisCheckpoint');
const { translateImportPathForNode } = require('../tapisRegistration');

const { STATES } = TapisJobRegistry;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Submissions whose outcome is unknown (timeout, no response, 5xx) and are being
// looked up by name. Capped so a request flood cannot fan out Tapis calls.
let activeReconciles = 0;

const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|credential|api.?key)/i;
const MAX_LOG_VALUE_LENGTH = 2000;

const sanitizeForLog = (value, depth = 0) => {
    if (value === null || value === undefined) return value;
    if (depth > 4) return '[truncated]';
    if (typeof value === 'string') {
        return value.length > MAX_LOG_VALUE_LENGTH ? `${value.slice(0, MAX_LOG_VALUE_LENGTH)}…` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeForLog(item, depth + 1));
    if (typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
            key,
            SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : sanitizeForLog(item, depth + 1)
        ]));
    }
    return String(value);
};

const summarizeJob = job => ({
    appId: job.appId,
    appVersion: job.appVersion,
    execSystemId: job.execSystemId,
    execSystemLogicalQueue: job.execSystemLogicalQueue,
    archiveSystemId: job.archiveSystemId,
    nodeCount: job.nodeCount,
    coresPerNode: job.coresPerNode,
    memoryMB: job.memoryMB,
    maxMinutes: job.maxMinutes,
    archiveOnAppError: job.archiveOnAppError,
    appArgsCount: job.parameterSet && Array.isArray(job.parameterSet.appArgs) ? job.parameterSet.appArgs.length : 0,
    appArgNames: job.parameterSet && Array.isArray(job.parameterSet.appArgs)
        ? job.parameterSet.appArgs.map(arg => arg && arg.name).filter(Boolean)
        : [],
    envVariablesCount: job.parameterSet && Array.isArray(job.parameterSet.envVariables) ? job.parameterSet.envVariables.length : 0,
    envVariableKeys: job.parameterSet && Array.isArray(job.parameterSet.envVariables)
        ? job.parameterSet.envVariables.map(variable => variable && variable.key).filter(Boolean)
        : [],
    schedulerOptions: job.parameterSet && Array.isArray(job.parameterSet.schedulerOptions)
        ? job.parameterSet.schedulerOptions.map(option => ({ name: option.name, hasArg: Boolean(option.arg) }))
        : []
});

const logTapisRequestFailure = (operation, error, details = {}) => {
    const response = error && error.response;
    logger.warn(`[TAPIS] ${operation} failed: ${JSON.stringify({
        operation,
        status: response && response.status,
        code: error && error.code,
        message: error && error.message,
        response: response ? sanitizeForLog(response.data) : undefined,
        ...details
    })}`);
};

// Statuses before the job's own process is running on a compute node. A job in
// one of these is waiting on the scheduler, not orphaned.
const PRE_RUN_STATUSES = new Set([
    'PENDING', 'PROCESSING_INPUTS', 'STAGING_INPUTS', 'STAGING_JOB',
    'SUBMITTING', 'SUBMITTING_JOB', 'QUEUED', 'BLOCKED', 'PAUSED'
]);
const TERMINAL_STATUSES = new Set(['FINISHED', 'CANCELLED', 'FAILED']);
// Terminal statuses that mean the work did not complete: a task still routed to or
// waiting for such a job has been lost and must be failed in the task table.
const FAILED_STATUSES = new Set(['CANCELLED', 'FAILED']);
const MAX_FAILURE_MESSAGE_LENGTH = 300;
const RESUME_LOOKUP_TTL_MS = 60 * 1000;
const DEFAULT_MAX_QUEUE_WAIT_MINUTES = { 'vm-small': 240, normal: 720, default: 480 };

const ACTIVE_STATUSES = new Set([
    'PENDING', 'PROCESSING_INPUTS', 'STAGING_INPUTS', 'STAGING_JOB',
    'SUBMITTING', 'SUBMITTING_JOB', 'QUEUED', 'RUNNING', 'ARCHIVING',
    'CLEANING_UP', 'PAUSED', 'BLOCKED'
]);

const parseMinutes = (value, fallback = 60) => {
    if (typeof value === 'string' && value.includes(':')) {
        const [hours = 0, minutes = 0, seconds = 0] = value.split(':').map(Number);
        value = (hours * 60) + minutes + Math.ceil(seconds / 60);
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.min(2880, parsed)) : fallback;
};

const mappingDefault = (mapping, key, fallback) => {
    const value = mapping && mapping[key];
    return value === undefined || value === null || value === '' ? fallback : value;
};

const sameUser = (pending, identity) => {
    if (!pending || !identity) return false;
    const owner = pending.tapisJobOwner || pending.nodeUser;
    if (!owner) return false;

    const normalizedOwner = String(owner).trim().toLowerCase();
    const normalizedUsername = String(identity.username).trim().toLowerCase();
    const normalizedTenant = String(identity.tenantId || '').trim().toLowerCase();
    const normalizedOwnerTenant = String(pending.tapisJobOwnerTenant || '').trim().toLowerCase();
    if (!normalizedOwnerTenant || !normalizedTenant) return false;
    const ownerMatches = normalizedOwner.includes('@')
        ? normalizedOwner === `${normalizedUsername}@${normalizedTenant}`
        : normalizedOwner === normalizedUsername;

    return ownerMatches && (!normalizedOwnerTenant || normalizedOwnerTenant === normalizedTenant);
};

const buildWorkerEnvVariables = (configuredEnv, tapisToken, registrationSecret, extraEnvVariables = []) => {
    const envVariables = Array.isArray(configuredEnv) ? configuredEnv : [];

    // Current Tapis leaves the historical ${_tapisAccessToken} macro literal.
    // Pass the request JWT explicitly so NodeODX can authenticate its webhook.
    const result = envVariables
        .filter(variable => variable && !['TAPIS_ACCESS_TOKEN', '_tapisAccessToken', 'NODEODX_REGISTRATION_SECRET'].includes(variable.key))
        .concat({
            key: 'TAPIS_ACCESS_TOKEN',
            value: tapisToken,
            description: 'Request-scoped Tapis JWT for NodeODX worker authentication'
        });
    if (registrationSecret) result.push({ key: 'NODEODX_REGISTRATION_SECRET', value: registrationSecret });
    // Per-submission variables (checkpoint resume) cannot replace the credentials above.
    const reserved = new Set(['TAPIS_ACCESS_TOKEN', '_tapisAccessToken', 'NODEODX_REGISTRATION_SECRET']);
    for (const variable of Array.isArray(extraEnvVariables) ? extraEnvVariables : []) {
        if (!variable || !variable.key || reserved.has(variable.key)) continue;
        const existing = result.findIndex(item => item.key === variable.key);
        if (existing === -1) result.push(variable); else result[existing] = variable;
    }
    return result;
};

module.exports = class TapisAsrProvider extends AbstractASRProvider {
    constructor(userConfig) {
        super({
            tapis: { baseUrl: 'https://portals.tapis.io', tenantId: 'portals' },
            app: { appId: 'nodeodx-ls6', appVersion: '1.0.18' },
            system: { executionSystemId: 'CHANGEME!', archiveSystemId: 'CHANGEME!', logicalQueue: 'vm-small' },
            scheduler: { defaultAllocation: '' },
            job: { maxJobTime: '01:00:00', nodeCount: 1, coresPerNode: 1, memoryMB: 4096, archiveOnAppError: true, maxNodesPerJob: 1, appArgs: [], envVariables: [] },
            worker: { registrationSecret: '', allowSharedSecretPrimaryRegistration: false },
            maxRuntime: -1,
            maxUploadTime: 3600,
            jobLimit: -1,
            createRetries: 3,
            imageSizeMapping: []
        }, userConfig);
        this.activeJobs = new Map();
        this.pendingTasks = new Map();
    }

    async initialize() {
        this.validateConfigKeys([
            'tapis.baseUrl', 'tapis.tenantId', 'app.appId', 'app.appVersion',
            'system.executionSystemId', 'system.archiveSystemId'
        ]);
        const mappings = this.getConfig('imageSizeMapping', []);
        if (!Array.isArray(mappings)) throw new Error('Invalid config key imageSizeMapping (array expected)');
        for (const mapping of mappings) {
            if (mapping && mapping.shapeOnly === true && !mapping.logicalQueue) {
                throw new Error('Invalid config key imageSizeMapping (shapeOnly entries require logicalQueue)');
            }
        }
        mappings.sort((a, b) => Number(a.maxImages || 0) - Number(b.maxImages || 0));

        const registryPath = this.getConfig('tapis.registryPath', 'data/tapis-jobs.json');
        this.registry = new TapisJobRegistry(registryPath || 'data/tapis-jobs.json').load();
        this.rehydrateFromRegistry();

        const intervalSeconds = Number(this.getConfig('tapis.vacuumIntervalSeconds', 120));
        if (intervalSeconds > 0 && !this.vacuumTimer) {
            this.vacuumTimer = setInterval(() => {
                this.vacuum().catch(error => logger.warn(`[TAPIS] vacuum failed: ${error.message}`));
            }, intervalSeconds * 1000);
            if (typeof this.vacuumTimer.unref === 'function') this.vacuumTimer.unref();
        }
        this.unknownJobCancels = { byOwner: new Map(), byJob: new Map() };
    }

    // Optional instance tag in the job name so two ClusterODX deployments sharing
    // one Tapis app can tell their jobs apart.
    generateHostname(imagesCount) {
        const base = super.generateHostname(imagesCount);
        const instanceId = String(this.getConfig('tapis.instanceId', '') || '').replace(/[^A-Za-z0-9]/g, '');
        if (!instanceId) return base;
        const parts = base.split('-');
        return [parts[0], parts[1], instanceId, ...parts.slice(2)].join('-');
    }

    jobNameBelongsHere(name) {
        if (typeof name !== 'string' || !name.startsWith('clusterodx-')) return false;
        const instanceId = String(this.getConfig('tapis.instanceId', '') || '').replace(/[^A-Za-z0-9]/g, '');
        return !instanceId || name.split('-')[2] === instanceId;
    }

    // Restore in-memory job state from the registry after a restart. Tokens are
    // never persisted, so restored records can be matched and handed off (the
    // worker brings its own bearer) but not cancelled until a token arrives.
    rehydrateFromRegistry() {
        let restored = 0;
        for (const record of this.registry.open()) {
            if (!record.tapisJobId) continue; // never accepted; nothing to restore
            const base = {
                tapisJobId: record.tapisJobId,
                jobId: record.jobName,
                taskId: record.taskId || record.jobName,
                tapisJobOwner: record.owner || null,
                tapisJobOwnerTenant: record.ownerTenant || null,
                rehydrated: true
            };
            if (record.state === STATES.SUBMITTED) {
                const pending = Object.assign(base, {
                    imagesCount: record.imagesCount,
                    taskOptions: Array.isArray(record.taskOptions) ? record.taskOptions : [],
                    fileNames: Array.isArray(record.fileNames) ? record.fileNames : [],
                    tmpPath: record.tmpPath || null,
                    pathImport: record.pathImport || null,
                    submissionParams: record.submissionParams || {},
                    token: null,
                    // A restart mid-restore must still hand the task over by routing, not by upload.
                    checkpointResume: record.checkpointResume === true,
                    resumeTaskUuid: record.resumeOf || null,
                    resumeNewUuid: record.newUuid || null,
                    resumeClass: record.class || null,
                    nodeUser: record.owner && record.ownerTenant ? `${record.owner}@${record.ownerTenant}` : null,
                    submittedJobs: [{ tapisJobId: record.tapisJobId, jobName: record.jobName }]
                });
                this.pendingTasks.set(pending.jobId, pending);
                this.pendingTasks.set(pending.tapisJobId, pending);
                this.pendingTasks.set(pending.taskId, pending);
            }
            this.activeJobs.set(record.tapisJobId, Object.assign(base, {
                imagesCount: record.imagesCount,
                status: record.state === STATES.CANCEL_FAILED || record.state === STATES.CANCEL_REQUESTED ? 'cancelFailed' : 'SUBMITTING',
                token: null
            }));
            restored++;
        }
        if (restored) logger.info(`[TAPIS] restored ${restored} job record(s) from ${this.registry.filePath}; tokens must be re-presented before they can be cancelled`);
        return restored;
    }

    getSubmitTimeoutMs() { return Number(this.getConfig('tapis.submitTimeoutMs', 120000)) || 120000; }

    // ---- Checkpoint resume (docs/tapis.md, "Checkpoint resume") ----------------

    isResumeEnabled() { return this.getConfig('tapis.resume.enabled', false) === true; }

    getResumeSyncTimeoutMs() {
        const seconds = Number(this.getConfig('tapis.resume.syncTimeoutSeconds', 600));
        return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 600) * 1000;
    }

    getResumeSyncPollMs() {
        const seconds = Number(this.getConfig('tapis.resume.syncPollSeconds', 5));
        return Math.max(1, (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000);
    }

    // Host path of the checkpoint root (what ClusterODX reads) and the same
    // directory as the worker sees it (what the job is told).
    getCheckpointRoot() { return this.getConfig('tapis.checkpointRoot', '/corral/webodm/media/.nodeodm-checkpoints'); }
    getCheckpointNodeRoot() { return this.getConfig('tapis.checkpointNodeRoot', '/corral/utexas/BCS26030/webodm/media/.nodeodm-checkpoints'); }
    getCheckpointIntervalSeconds() { return parseInt(this.getConfig('tapis.checkpointIntervalSeconds', 900), 10) || 900; }
    getCheckpointRetentionSeconds() { return parseInt(this.getConfig('tapis.checkpointRetentionSeconds', 604800), 10) || 604800; }

    getCheckpointScratchRoots() {
        const configured = this.getConfig('tapis.checkpointScratchRoots', ['/scratch', '/work']);
        const roots = Array.isArray(configured) ? configured : String(configured || '').split(/[,:]/);
        return roots
            .map(root => String(root || '').trim())
            .filter(root => root.startsWith('/'))
            .map(root => path.posix.normalize(root));
    }

    isAllowedScratchResumePath(rawPath) {
        if (!rawPath || typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.includes('\0')) return false;
        const normalized = path.posix.normalize(rawPath);
        return this.getCheckpointScratchRoots().some(root => {
            if (!root || root === '/') return false;
            return normalized === root || normalized.startsWith(`${root.replace(/\/$/, '')}/`);
        });
    }

    // Throws unless the token's Tapis user is the one who ran the checkpointed job.
    // A manifest that names no owner is not checked here; the proxy has already
    // matched the request token to the task's owner token.
    assertCheckpointOwner(manifest, token) {
        const owner = manifest && manifest.tapisJobOwner ? String(manifest.tapisJobOwner).trim().toLowerCase() : '';
        if (!owner) return;
        const identity = extractUserFromToken(token);
        const [ownerUser, ownerTenant] = owner.split('@');
        const sameUser = identity && String(identity.username).toLowerCase() === ownerUser;
        const sameTenant = !ownerTenant || (identity && String(identity.tenantId).toLowerCase() === ownerTenant);
        if (!sameUser || !sameTenant) {
            throw new tapisCheckpoint.ResumeRefusal(tapisCheckpoint.REASONS.NOT_OWNER,
                `Checkpoint for task ${manifest.uuid || ''} belongs to ${owner}`);
        }
    }

    // Manifest decision for a task, cached per uuid for RESUME_LOOKUP_TTL_MS. The
    // resume enforces this same cached decision, so what the lookup told the user
    // is what the resume acts on. The owner check runs on every read, not once.
    async resolveCheckpoint(taskId, token) {
        const emptyAnswer = reason => Object.assign(tapisCheckpoint.evaluateManifest(null), { reason });
        if (!this.isResumeEnabled()) return { answer: emptyAnswer(tapisCheckpoint.REASONS.DISABLED), manifest: null };
        if (!tapisCheckpoint.isTaskUuid(taskId)) return { answer: emptyAnswer(tapisCheckpoint.REASONS.NO_MANIFEST), manifest: null };

        const cache = this.resumeLookupCache || (this.resumeLookupCache = new Map());
        let entry = cache.get(taskId);
        if (!entry || Date.now() - entry.at > RESUME_LOOKUP_TTL_MS) {
            const { manifest, reason } = await tapisCheckpoint.readManifest(this.getCheckpointRoot(), taskId, logger);
            const answer = manifest ? tapisCheckpoint.evaluateManifest(manifest) : emptyAnswer(reason);
            entry = { at: Date.now(), manifest, answer };
            cache.set(taskId, entry);
            for (const [key, value] of cache) if (Date.now() - value.at > RESUME_LOOKUP_TTL_MS) cache.delete(key);
        }

        if (entry.manifest) {
            try {
                this.assertCheckpointOwner(entry.manifest, token);
            } catch (error) {
                if (!(error instanceof tapisCheckpoint.ResumeRefusal)) throw error;
                return { answer: emptyAnswer(error.reason), manifest: null };
            }
        }
        return { answer: Object.assign({}, entry.answer), manifest: entry.manifest };
    }

    // GET /task/<uuid>/resume
    async lookupResume(taskId, token) {
        return (await this.resolveCheckpoint(taskId, token)).answer;
    }

    // Registry records that belong to a task: the original submission and every
    // earlier resume of it (replace mode reuses the uuid).
    recordsForTask(taskId) {
        if (!this.registry) return [];
        return this.registry.all().filter(record => record.taskId === taskId || record.newUuid === taskId);
    }

    // Node count a split task originally ran with: the manifest if the worker
    // recorded it, else the largest count any job for the task was submitted with.
    originalNodeCount(taskId, manifest) {
        const fromManifest = Number(manifest && (manifest.nodeCount || manifest.nodesPerJob));
        if (fromManifest > 0) return fromManifest;
        return this.recordsForTask(taskId).reduce((best, record) => Math.max(best, Number(record.nodeCount) || 0), 0);
    }

    normalizeTaskOptions(options) {
        if (typeof options === 'string') {
            try { options = JSON.parse(options); } catch (_error) { options = []; }
        }
        if (!Array.isArray(options)) return [];
        return options.filter(option => option && typeof option === 'object' && option.name).map(option => Object.assign({}, option));
    }

    // Submit a job that restores `taskId` from its checkpoint and re-runs it with
    // `taskOptions`. With `newVersion` the task runs under a fresh uuid (the
    // checkpoint is never modified); otherwise it replaces `taskId`. Resolves once
    // Tapis accepted the job; the worker registers later and the registration
    // webhook routes the task (libs/tapisRegistration.js completeResumeRegistration).
    async resumeTaskFromCheckpoint({ taskId, token, taskOptions = [], newVersion = false, resumeClass = null, name = null, imagesCount = null }) {
        const { ResumeRefusal, REASONS } = tapisCheckpoint;
        if (!this.isResumeEnabled()) throw new ResumeRefusal(REASONS.DISABLED, 'Checkpoint resume is not enabled');
        if (!token || token === 'missing') throw new Error('Tapis JWT token must be provided to resume a checkpointed task');

        const { answer, manifest } = await this.resolveCheckpoint(taskId, token);
        if (!answer.resumable) throw new ResumeRefusal(answer.reason);

        const requestedOptions = this.normalizeTaskOptions(taskOptions);
        let effectiveClass = null;
        if (answer.split) {
            effectiveClass = ['M', 'O'].includes(resumeClass) ? resumeClass : tapisCheckpoint.inferSplitClass(requestedOptions);
            if (!effectiveClass || !answer.resumableClasses.includes(effectiveClass)) {
                throw new ResumeRefusal('class_unavailable', effectiveClass
                    ? `Split task can only be resumed as class ${answer.resumableClasses.join(' or ')}, not ${effectiveClass}`
                    : 'Split task can only be resumed from rerun-from merge or odm_meshing and later; this change needs a full run');
            }
        }

        const records = this.recordsForTask(taskId);
        const resolvedImagesCount = parseInt(imagesCount || (manifest && manifest.imagesCount) ||
            records.reduce((best, record) => Math.max(best, Number(record.imagesCount) || 0), 0), 10) || 1;

        // Submodel work needs the original multi-node job; the shared-submodel path
        // fans out over its nodes.
        let jobOptions = requestedOptions;
        if (answer.split) {
            const original = this.originalNodeCount(taskId, manifest);
            // Neither the manifest nor the registry may know it (the manifest does not carry
            // nodeCount yet): then the request's tapis-node is accepted without enforcing.
            if (original) {
                const requested = Number(tapisTaskOptions.getTaskOption(requestedOptions, 'tapis-node')) || 0;
                if (requested && requested < original) {
                    throw new ResumeRefusal('node_count_too_small', `A split task needs at least its original ${original} node(s); ${requested} requested`);
                }
                jobOptions = requestedOptions.filter(option => option.name !== 'tapis-node')
                    .concat({ name: 'tapis-node', value: `${requested || original}` });
                if (this.calculateNodeSubmissionPlan(resolvedImagesCount, jobOptions).nodesForJob < original) {
                    throw new ResumeRefusal('node_count_too_small', `This configuration allows fewer than the original ${original} node(s)`);
                }
            }
        }

        const queue = tapisTaskOptions.getTaskOption(jobOptions, 'tapis-queue') || this.getDefaultQueue(resolvedImagesCount);
        const resumeOptions = tapisCheckpoint.buildResumeOptions(
            tapisTaskOptions.applyGpuQueuePolicy(jobOptions, queue),
            { split: answer.split, resumeClass: effectiveClass }
        );
        const stage = tapisCheckpoint.optionValue(resumeOptions, 'rerun-from');

        const target = newVersion ? crypto.randomUUID() : taskId;
        if (this.findPendingTask(target)) {
            throw new ResumeRefusal('resume_in_progress', `A resume is already in progress for task ${target}`);
        }

        const env = tapisCheckpoint.buildResumeEnv({
            taskId,
            newUuid: newVersion ? target : null,
            options: resumeOptions,
            nodeRoot: this.getCheckpointNodeRoot(),
            intervalSeconds: this.getCheckpointIntervalSeconds(),
            retentionSeconds: this.getCheckpointRetentionSeconds(),
            allowedRoots: this.getCheckpointScratchRoots(),
            importPath: manifest && manifest.importPath ? translateImportPathForNode(manifest.importPath, null) : null
        });
        const jobName = `${this.generateHostname(resolvedImagesCount)}-resume`;

        logger.info(`[TAPIS] resuming task ${taskId}${newVersion ? ` as ${target}` : ''} from checkpoint: ${JSON.stringify({
            user: describeTokenUser(token), jobName, class: effectiveClass, stage, split: answer.split
        })}`);
        // createNode writes the registry record (resumeOf, newUuid, class, stage,
        // state SUBMITTING) before it asks Tapis for the job.
        await this.createNode(null, resolvedImagesCount, token, jobName, null, jobOptions, [], null, target, null, {}, env, {
            resumeOf: taskId, newUuid: newVersion ? target : null, class: effectiveClass, stage
        });
        if (!newVersion && this.resumeLookupCache) this.resumeLookupCache.delete(taskId);

        const pending = this.findPendingTask(jobName);
        return {
            success: true,
            uuid: target,
            resumeOf: taskId,
            tapisJobId: pending ? pending.tapisJobId : null,
            jobName,
            name: name || (manifest && manifest.name) || null,
            imagesCount: resolvedImagesCount,
            options: resumeOptions,
            engineVersion: answer.engineVersion,
            class: effectiveClass,
            stage
        };
    }

    // Poll the checkpoint manifest until the worker has finished writing it
    // (synced, write_failed or partial) or the timeout passes. Teardown calls this
    // so a node is not destroyed while its terminal checkpoint is still copying.
    async waitForCheckpointSync(taskId, { tapisJobId = null, timeoutMs = this.getResumeSyncTimeoutMs(), pollMs = this.getResumeSyncPollMs() } = {}) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const { manifest } = await tapisCheckpoint.readManifest(this.getCheckpointRoot(), taskId, logger);
            if (tapisCheckpoint.syncFinished(manifest, tapisJobId)) return { state: manifest.state, timedOut: false };
            if (Date.now() >= deadline) {
                logger.warn(`[TAPIS] checkpoint for ${taskId} not synced after ${Math.round(timeoutMs / 1000)}s (state ${manifest ? manifest.state : 'none'}); tearing down anyway`);
                return { state: manifest ? manifest.state : null, timedOut: true };
            }
            await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
        }
    }

    // ---- Failure forwarding ---------------------------------------------------

    // Tasks that depend on a Tapis job: the one waiting for its worker and every
    // task routed to the worker. Read before the vacuum drops the routes.
    async collectJobTasks(tapisJobId, node, routetable) {
        const tasks = new Map();
        const pending = this.findPendingTask(tapisJobId);
        if (pending && pending.taskId) tasks.set(pending.taskId, pending.token || null);
        if (node) {
            const routes = (await routetable.findByNode(node)) || {};
            for (const [taskId, route] of Object.entries(routes)) tasks.set(taskId, route && route.token || null);
        }
        return [...tasks].map(([taskId, token]) => ({ taskId, token }));
    }

    failureMessage(job) {
        const status = String((job && job.status) || 'FAILED').toUpperCase();
        const text = [job && job.remoteOutcome, job && job.lastMessage]
            .filter(part => typeof part === 'string' && part.trim() !== '')
            .map(part => part.trim())
            .join(': ') || `Tapis job ${status}`;
        return TapisJobRegistry.stripSensitive(text.slice(0, MAX_FAILURE_MESSAGE_LENGTH));
    }

    // Fail each task in the task table with the reason Tapis gave, so WebODM's
    // last_error shows (for example) a Slurm time-limit kill, not a lost node.
    // A task that already ended on the worker is left alone.
    async failTasks(tasks, message, tasktable) {
        for (const { taskId, token } of tasks) {
            try {
                const existing = await tasktable.lookup(taskId);
                const info = existing && existing.taskInfo;
                const code = info && info.status && info.status.code;
                if ([statusCodes.FAILED, statusCodes.COMPLETED, statusCodes.CANCELED].includes(code)) continue;
                const taskInfo = Object.assign({
                    uuid: taskId, name: taskId, dateCreated: Date.now(), progress: 0, processingTime: -1
                }, info || {}, { status: { code: statusCodes.FAILED, errorMessage: message } });
                await tasktable.add(taskId, Object.assign({}, existing || {}, {
                    taskInfo,
                    output: ((existing && existing.output) || []).concat(message),
                    abort: null
                }), token);
                logger.info(`[TAPIS] task ${taskId} failed because its Tapis job ended: ${message}`);
            } catch (error) {
                logger.warn(`[TAPIS] could not fail task ${taskId}: ${error.message}`);
            }
        }
    }

    getDriverName() { return 'tapis'; }
    getCreateRetries() { return Number(this.getConfig('createRetries', 3)) || 3; }
    getMaxRuntime() { return Number(this.getConfig('maxRuntime', -1)); }
    getMaxUploadTime() { return Number(this.getConfig('maxUploadTime', -1)); }
    getMachinesLimit() { return Number(this.getConfig('jobLimit', -1)); }
    getNodesPendingCreation() { return new Set(this.pendingTasks.values()).size; }
    getDownloadsBaseUrl() { return `${this.getConfig('tapis.baseUrl')}/v3/files`; }

    getJobPropertiesFor(imagesCount) {
        return (this.getConfig('imageSizeMapping', []) || []).find(mapping => mapping.shapeOnly !== true && Number(mapping.maxImages) >= imagesCount) || null;
    }

    canHandle(imagesCount) { return this.getJobPropertiesFor(imagesCount) !== null; }

    // shapeOnly entries (never default tiers) are returned here too.
    // The imageSizeMapping tier whose logicalQueue is `queue`, if any. Used so that a
    // caller who overrides tapis-queue gets a job shaped for that queue (cores/memory)
    // instead of the shape of the image-count tier, which may not fit the queue at all
    // (e.g. a 64-core request sent to the 16-core vm-small queue).
    getJobShapeForQueue(queue) {
        if (!queue) return null;
        return (this.getConfig('imageSizeMapping', []) || [])
            .find(mapping => mapping && String(mapping.logicalQueue || '') === String(queue)) || null;
    }

    getDefaultQueue(imagesCount = null) {
        const mapping = imagesCount === null ? null : this.getJobPropertiesFor(imagesCount);
        return (mapping && mapping.logicalQueue) || this.getConfig('system.logicalQueue', 'vm-small');
    }

    getDefaultNodeCount(imagesCount = null) {
        const mapping = imagesCount === null ? null : this.getJobPropertiesFor(imagesCount);
        const configured = mapping && (mapping.computeNodeCount || mapping.nodeCount) || this.getConfig('job.nodeCount', 1);
        const maximum = Number(this.getConfig('job.maxNodesPerJob', 1)) || 1;
        return Math.max(1, Math.min(maximum, Number(configured) || 1));
    }

    getImageSizeDefaultMappings() {
        return (this.getConfig('imageSizeMapping', []) || [])
            .map(mapping => {
                if (mapping && mapping.shapeOnly === true) return null;
                const maxImages = Number(mapping && mapping.maxImages);
                if (!Number.isFinite(maxImages) || maxImages <= 0) return null;

                return {
                    maxImages,
                    queue: mappingDefault(mapping, 'logicalQueue', this.getConfig('system.logicalQueue', 'vm-small')),
                    maxMinutes: parseMinutes(mappingDefault(mapping, 'maxJobTime', this.getConfig('job.maxJobTime', '01:00:00'))),
                    nodeCount: Math.max(1, Math.min(
                        Number(this.getConfig('job.maxNodesPerJob', 1)) || 1,
                        Number(mappingDefault(mapping, 'computeNodeCount', mappingDefault(mapping, 'nodeCount', this.getConfig('job.nodeCount', 1)))) || 1
                    ))
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.maxImages - b.maxImages);
    }

    buildDefaultByImages(field) {
        return this.getImageSizeDefaultMappings()
            .map(mapping => mapping[field] === undefined || mapping[field] === null
                ? null
                : { maxImages: mapping.maxImages, value: `${mapping[field]}` })
            .filter(Boolean);
    }

    getClusterOptions() {
        const queues = this.getConfig('system.queueFilter', [this.getDefaultQueue()]);
        const queueDomain = Array.isArray(queues) ? queues : String(queues).split(',').map(value => value.trim()).filter(Boolean);
        return [
            { name: 'tapis-queue', label: 'Queue', type: 'enum', value: this.getDefaultQueue(), domain: queueDomain, defaultByImages: this.buildDefaultByImages('queue') },
            { name: 'tapis-allocation', label: 'Allocation', type: 'string', value: this.getConfig('scheduler.defaultAllocation', ''), domain: '' },
            { name: 'tapis-max-run-time', label: 'Max Run Time', type: 'int', value: `${parseMinutes(this.getConfig('job.maxJobTime', '01:00:00'))}`, domain: 'integer: 1 <= x <= 2880', defaultByImages: this.buildDefaultByImages('maxMinutes') },
            { name: 'tapis-node', label: 'Number of Nodes', type: 'int', value: `${this.getDefaultNodeCount()}`, domain: `integer: 1 <= x <= ${Number(this.getConfig('job.maxNodesPerJob', 1)) || 1}`, defaultByImages: this.buildDefaultByImages('nodeCount') }
        ];
    }

    getNodeOptions() {
        // Keep ClusterODM's established defaults and add the remaining NodeODX options.
        const defaultOptions = [
            {
                "name": "auto-boundary",
                "type": "bool",
                "value": "false",
                "domain": "",
                "help": "Automatically set a boundary using camera shot locations to limit the area of the reconstruction."
            },
            {
                "name": "boundary",
                "type": "string",
                "value": "",
                "domain": "json",
                "help": "Set a boundary using a GeoJSON polygon to limit the area of the reconstruction."
            },
            {
                "name": "crop",
                "type": "float",
                "value": "3",
                "domain": "positive float",
                "help": "Automatically crop image outputs by creating a smooth buffer around the dataset boundaries, shrunk by N meters."
            },
            {
                "name": "pc-classify",
                "type": "bool",
                "value": "false",
                "domain": "",
                "help": "Classify the point cloud and generate a DEM"
            },
            {
                "name": "pc-rectify",
                "type": "bool",
                "value": "false",
                "domain": "",
                "help": "Perform ground rectification on the point cloud."
            },
            {
                "name": "pc-filter",
                "type": "float",
                "value": "2.5",
                "domain": "positive float",
                "help": "Filters the point cloud by removing points that deviate more than N standard deviations from the local mean."
            },
            {
                "name": "pc-quality",
                "type": "string",
                "value": "medium",
                "domain": [
                    "ultra",
                    "high",
                    "medium",
                    "low",
                    "lowest"
                ],
                "help": "Set point cloud quality. Higher quality generates better, denser point clouds, but requires more memory and takes longer."
            },
            {
                "name": "feature-quality",
                "type": "string",
                "value": "high",
                "domain": [
                    "ultra",
                    "high",
                    "medium",
                    "low",
                    "lowest"
                ],
                "help": "Set feature extraction quality. Higher quality generates better features, but requires more memory and takes longer."
            },
            {
                "name": "feature-type",
                "type": "string",
                "value": "sift",
                "domain": [
                    "akaze",
                    "hahog",
                    "orb",
                    "sift"
                ],
                "help": "Choose the algorithm for extracting keypoints and computing descriptors."
            },
            {
                "name": "matcher-type",
                "type": "string",
                "value": "flann",
                "domain": [
                    "bow",
                    "bruteforce",
                    "flann",
                ],
                "help": "Matcher algorithm, Fast Library for Approximate Nearest Neighbors or Bag of Words."
            },
            {
                "name": "orthophoto-resolution",
                "type": "float",
                "value": "5",
                "domain": "float > 0.0",
                "help": "Orthophoto resolution in cm / pixel."
            },
            {
                "name": "orthophoto-compression",
                "type": "string",
                "value": "DEFLATE",
                "domain": [
                    "JPEG",
                    "LZW",
                    "PACKBITS",
                    "DEFLATE",
                    "LZMA",
                    "NONE"
                ],
                "help": "Set the compression to use for orthophotos."
            },
            {
                "name": "dem-resolution",
                "type": "float",
                "value": "5",
                "domain": "float",
                "help": "DSM/DTM resolution in cm / pixel."
            },
            {
                "name": "use-3dmesh",
                "type": "bool",
                "value": "false",
                "domain": "",
                "help": "Use a full 3D mesh to compute the orthophoto instead of a 2.5D mesh."
            },
            {
                "name": "skip-3dmodel",
                "type": "bool",
                "value": "false",
                "domain": "",
                "help": "Skip generation of a full 3D model. This can save time if you only need 2D results such as orthophotos and DEMs."
            },
            {
                "name": "optimize-disk-space",
                "type": "bool",
                "value": "false",
                "domain": "",
                "help": "Delete heavy intermediate files to optimize disk space usage."
            },
            {
                "name": "dtm",
                "type": "bool",
                "value": "false",
                "domain": "",
                "help": "Use this tag to build a DTM (Digital Terrain Model, ground only) using a simple morphological filter."
            },
            {
                "name": "dsm",
                "type": "bool",
                "value": "false",
                "domain": "",
                "help": "Use this tag to build a DSM (Digital Surface Model, ground + objects) using a progressive morphological filter."
            },
            {
                "name": "force-gps",
                "type": "bool",
                "value": "false",
                "domain": "",
                "help": "Use GPS information from EXIF even if a GCP file is provided."
            },
            {
                "name": "gps-accuracy",
                "type": "float",
                "value": "10",
                "domain": "positive float",
                "help": "Set a value in meters for the GPS Dilution of Precision (DOP) information for all images."
            },
            {
                "name": "ignore-gsd",
                "type": "bool",
                "value": "false",
                "domain": "",
                "help": "Ignore Ground Sampling Distance (GSD). GSD caps the maximum resolution of image outputs."
            },
            {
                "name": "max-concurrency",
                "type": "int",
                "value": "4",
                "domain": "positive integer",
                "help": "The maximum number of processes to use in various processes. Peak memory requirement is ~1GB per thread and 2 megapixel image resolution."
            },
            {
                "name": "min-num-features",
                "type": "int",
                "value": "10000",
                "domain": "integer",
                "help": "Minimum number of features to extract per image. More features lead to better results but slower execution."
            },
            {
                "name": "camera-lens",
                "type": "string",
                "value": "auto",
                "domain": [
                    "auto",
                    "perspective",
                    "brown",
                    "fisheye",
                    "spherical",
                    "equirectangular",
                    "dual"
                ],
                "help": "Set a camera lens model. By default the application tries to determine a lens model from the images."
            },
            {
                "name": "radiometric-calibration",
                "type": "string",
                "value": "none",
                "domain": [
                    "none",
                    "camera",
                    "camera+sun"
                ],
                "help": "Set the radiometric calibration to perform on images. When processing multispectral and thermal images you should set this option to obtain reflectance/temperature values."
            },
            {
                "name": "primary-band",
                "type": "string",
                "value": "auto",
                "domain": "string",
                "help": "When processing multispectral datasets, you can specify the name of the primary band that will be used for reconstruction."
            },
            {
                "name": "split",
                "type": "int",
                "value": "999999",
                "domain": "positive integer",
                "help": "Average number of images per submodel. Set to a positive integer to enable split-merge processing for large datasets. When set to 1, ODM will automatically determine the optimal split size."
            },
            {
                "name": "split-overlap",
                "type": "float",
                "value": "150",
                "domain": "positive integer",
                "help": "Overlap between submodels in meters. Ensures accurate tie points and georeferencing across submodel boundaries. Recommended: 100-200m for typical drone surveys."
            },
            {
                "name": "sm-cluster",
                "type": "string",
                "value": "None",
                "domain": "string",
                "help": "URL of the split-merge cluster coordinator. Automatically set by ClusterODM when using distributed processing. Leave empty for single-machine processing."
            }
        ];
        const nodeOptions = this.getConfig('nodeOptions', []);
        if (!Array.isArray(nodeOptions)) throw new Error('Invalid config key nodeOptions (array expected)');
        const fallbackOptions = defaultOptions.concat(nodeodxExtraOptions).map(option => ({
            ...option,
            type: Array.isArray(option.domain) ? 'enum' : option.type,
            value: option.type === 'bool' ? String(option.value).toLowerCase() : option.value
        }));
        return (nodeOptions.length ? nodeOptions : fallbackOptions).concat(this.getClusterOptions());
    }

    createApiClient(token) {
        if (!token || typeof token !== 'string') throw new Error('Tapis token is required');
        return axios.create({
            baseURL: this.getConfig('tapis.baseUrl'),
            headers: { 'X-Tapis-Token': token },
            timeout: 30000, // per-call options override this (submit uses tapis.submitTimeoutMs)
            maxRedirects: 0 // never follow a redirect carrying the token to another host
        });
    }

    async validateToken(token) {
        try {
            await this.createApiClient(token).get('/v3/systems');
        } catch (error) {
            logTapisRequestFailure('validate token', error, {
                baseUrl: this.getConfig('tapis.baseUrl')
            });
            throw error;
        }
        return true;
    }

    async getJobStatus(token, tapisJobId) {
        const response = await this.createApiClient(token).get(`/v3/jobs/${encodeURIComponent(tapisJobId)}`);
        const result = response && response.data && response.data.result;
        return typeof result === 'string' ? result : (result && result.status) || 'UNKNOWN';
    }

    // Resolves to the classified outcome from libs/tapisCancel.js; never throws on
    // a Tapis error so callers can park the job for a retry instead of losing it.
    async getJob(token, tapisJobId) {
        const response = await this.createApiClient(token).get(`/v3/jobs/${encodeURIComponent(tapisJobId)}`, { timeout: 30000 });
        return (response && response.data && response.data.result) || null;
    }

    tokenFor(tapisJobId) {
        const active = this.activeJobs.get(tapisJobId);
        if (active && active.token) return active.token;
        const pending = this.findPendingTask(tapisJobId);
        return pending && pending.token ? pending.token : null;
    }

    maxQueueWaitMs(queue) {
        const configured = Object.assign({}, DEFAULT_MAX_QUEUE_WAIT_MINUTES, this.getConfig('tapis.maxQueueWaitMinutes', {}) || {});
        const minutes = Number(configured[queue] !== undefined ? configured[queue] : configured.default) || DEFAULT_MAX_QUEUE_WAIT_MINUTES.default;
        return minutes * 60 * 1000;
    }

    // A worker registered for a job ClusterODX has no record of. Verify with Tapis
    // that the job is this user's, belongs to this instance's app, and is still
    // alive, then cancel it so it does not idle until its wall limit. Returns
    // { handled: true } when a cancel was attempted (whatever its outcome) so the
    // webhook can answer 410; { handled: false, reason } means fall through to 404.
    async cancelUnknownJob(token, identity, tapisJobId) {
        if (this.getConfig('worker.cancelUnknownJobs', false) !== true) return { handled: false, reason: 'disabled' };
        if (!token || !identity || !tapisJobId) return { handled: false, reason: 'missing input' };

        const known = this.registry && this.registry.get(tapisJobId);
        if (known && (known.state === STATES.SUBMITTING || known.state === STATES.SUBMITTED)) {
            return { handled: false, reason: 'job is being submitted or reconciled' };
        }

        const now = Date.now();
        const limits = this.unknownJobCancels || (this.unknownJobCancels = { byOwner: new Map(), byJob: new Map() });
        const lastForJob = limits.byJob.get(tapisJobId) || 0;
        if (now - lastForJob < 5 * 60 * 1000) return { handled: true, reason: 'recently cancelled' };
        const ownerKey = `${identity.username}@${identity.tenantId}`;
        const recent = (limits.byOwner.get(ownerKey) || []).filter(t => now - t < 60 * 1000);
        if (recent.length >= 10) {
            logger.warn(`[TAPIS] unknown-job cancel rate limit hit for ${ownerKey}`);
            return { handled: false, reason: 'rate limited' };
        }

        let job;
        try {
            job = await this.getJob(token, tapisJobId);
        } catch (error) {
            logTapisRequestFailure('verify unknown job', error, { tapisJobId, user: ownerKey });
            return { handled: false, reason: 'lookup failed' };
        }
        if (!job) return { handled: false, reason: 'job not found' };
        const ownerOk = String(job.owner || '') === identity.username && (!job.tenant || String(job.tenant) === identity.tenantId);
        const appOk = job.appId === this.getConfig('app.appId') && (!job.appVersion || job.appVersion === this.getConfig('app.appVersion'));
        const nameOk = this.jobNameBelongsHere(job.name);
        const alive = !TERMINAL_STATUSES.has(String(job.status || '').toUpperCase());
        if (!ownerOk || !appOk || !nameOk || !alive) {
            logger.info(`[TAPIS] unknown job ${tapisJobId} not cancelled: ${JSON.stringify({ user: ownerKey, ownerOk, appOk, nameOk, alive, status: job.status })}`);
            return { handled: false, reason: 'verification failed' };
        }

        recent.push(now);
        limits.byOwner.set(ownerKey, recent);
        limits.byJob.set(tapisJobId, now);
        this.recordUpsert({
            jobName: job.name, tapisJobId, owner: identity.username, ownerTenant: identity.tenantId,
            queue: job.execSystemLogicalQueue, state: STATES.CANCEL_REQUESTED, cancelRequestedAt: now, reason: 'unknown registration'
        });
        const cancelled = await this.cancelJob(token, tapisJobId);
        if (isTerminalOutcome(cancelled)) this.recordState(tapisJobId, STATES.DONE, { doneReason: 'unknown registration' });
        else this.parkCancelFailed(tapisJobId, token, cancelled, { jobId: job.name });
        return { handled: true, outcome: cancelled.outcome };
    }

    // Periodic sweep of the job registry and Tapis-backed nodes. Every action is
    // logged with the user; with tapis.vacuumDryRun the sweep only logs.
    async vacuum(deps = {}) {
        if (!this.registry || this.vacuumRunning) return { skipped: true };
        this.vacuumRunning = true;
        const nodes = deps.nodes || require('../nodes');
        const routetable = deps.routetable || require('../routetable');
        const tasktable = deps.tasktable || require('../tasktable');
        const removeAndCleanupNode = deps.removeAndCleanupNode || (node => require('../netutils').removeAndCleanupNode(node, this));
        const dryRun = this.getConfig('tapis.vacuumDryRun', false) === true;
        const graceMs = (Number(this.getConfig('tapis.registrationGraceMinutes', 20)) || 20) * 60 * 1000;
        const idleMs = (Number(this.getConfig('maxUploadTime', 3600)) || 3600) * 1000;
        const idleTicks = Number(this.getConfig('tapis.consecutiveIdleTicks', 3)) || 3;
        const retentionMs = (Number(this.getConfig('tapis.registryRetentionDays', 7)) || 7) * 24 * 3600 * 1000;
        const now = typeof deps.now === 'function' ? deps.now() : Date.now();
        const actions = [];

        const act = async (record, action, run) => {
            const line = JSON.stringify({ action, jobName: record.jobName, tapisJobId: record.tapisJobId || null,
                user: record.owner ? `${record.owner}@${record.ownerTenant || ''}` : 'unknown', state: record.state, queue: record.queue || null });
            actions.push({ action, jobName: record.jobName });
            if (dryRun) { logger.info(`[TAPIS] vacuum would ${action}: ${line}`); return; }
            logger.info(`[TAPIS] vacuum ${action}: ${line}`);
            await run();
        };
        const cancelRecord = async (record, token, reason) => {
            this.recordState(record.jobName, STATES.CANCEL_REQUESTED, { cancelRequestedAt: now, reason });
            const cancelled = await this.cancelJob(token, record.tapisJobId);
            if (isTerminalOutcome(cancelled)) {
                this.activeJobs.delete(record.tapisJobId);
                this.consumePendingTask(record.tapisJobId);
                this.recordState(record.jobName, STATES.DONE, { doneReason: reason });
            } else {
                this.parkCancelFailed(record.tapisJobId, token, cancelled, { jobId: record.jobName });
            }
        };
        const markUnreachable = (record, reason) => this.markUnreachable(record.jobName, reason, { dryRun });
        const maxUnauthorized = Number(this.getConfig('tapis.maxUnauthorizedCancelRetries', 3)) || 3;

        try {
            // Local hygiene first, with or without a token. A Tapis worker that has not
            // answered for longer than maxUploadTime is gone (wall limit, crash or an
            // external cancel) and must not keep a node entry or routes. No Tapis call
            // is needed to drop it; destroyNode cancels when it can and otherwise emits
            // the operator line. The silence is measured from the first sweep that found
            // the node offline (a failed probe zeroes Node.lastRefreshed, so that value
            // cannot be used) and lives in memory: a restart only delays removal.
            const offline = this.offlineByJob || (this.offlineByJob = new Map());
            const tapisNodes = typeof nodes.filter === 'function'
                ? nodes.filter(n => typeof n.getTapisJobId === 'function' && n.getTapisJobId()) : [];
            for (const node of tapisNodes) {
                const tapisJobId = node.getTapisJobId();
                try {
                    if (node.isOnline()) { offline.delete(tapisJobId); continue; }
                    const seen = offline.get(tapisJobId) || { ticks: 0, since: now };
                    seen.ticks += 1;
                    offline.set(tapisJobId, seen);
                    if (seen.ticks < idleTicks || now - seen.since <= idleMs) continue;
                    const record = this.registry.get(tapisJobId)
                        || { jobName: null, tapisJobId, owner: null, ownerTenant: null, state: null, queue: null };
                    await act(record, 'remove offline worker', async () => {
                        if (await removeAndCleanupNode(node)) offline.delete(tapisJobId);
                    });
                } catch (error) {
                    logger.warn(`[TAPIS] vacuum skipped offline check for ${node}: ${error.message}`);
                }
            }
            for (const tapisJobId of offline.keys()) {
                if (!tapisNodes.some(n => n.getTapisJobId() === tapisJobId)) offline.delete(tapisJobId);
            }

            for (const record of this.registry.open()) {
                try {
                    const token = record.tapisJobId ? this.tokenFor(record.tapisJobId) : null;
                    const age = now - Number(record.submittedAt || record.createdAt || now);
                    // A registered worker whose node still exists needs no token to be left
                    // alone: it becomes an orphan only once something has to be cancelled.
                    // Offline nodes are removed by the sweep above; destroyNode reports then.
                    const hasWorker = record.state === STATES.REGISTERED
                        && !!nodes.find(n => typeof n.getTapisJobId === 'function' && n.getTapisJobId() === record.tapisJobId);

                    if (!record.tapisJobId) {
                        // Submitted but never confirmed; Tapis may or may not have created it.
                        if (age > this.maxQueueWaitMs(record.queue) + graceMs) {
                            await act(record, 'close never-confirmed submission', async () =>
                                this.recordState(record.jobName, STATES.DONE, { doneReason: 'never confirmed' }));
                        }
                        continue;
                    }

                    if (!token) {
                        if (!hasWorker && age > this.maxQueueWaitMs(record.queue) + graceMs) markUnreachable(record, 'no token in memory');
                        continue;
                    }

                    if (record.bearerExpiresAt && record.bearerExpiresAt <= now) {
                        if (!hasWorker) markUnreachable(record, 'token expired');
                        continue;
                    }

                    if (record.state === STATES.CANCEL_REQUESTED || record.state === STATES.CANCEL_FAILED) {
                        if ((record.unauthorizedCount || 0) >= maxUnauthorized) {
                            markUnreachable(record, 'Tapis rejected the token repeatedly');
                            continue;
                        }
                        await act(record, 'retry cancel', () => cancelRecord(record, token, record.reason || 'cancel retry'));
                        continue;
                    }

                    // A handoff in progress owns this record; let it finish.
                    const claimed = this.findPendingTask(record.tapisJobId);
                    if (claimed && claimed.registrationClaimed) continue;

                    let job = null;
                    try {
                        job = await this.getJob(token, record.tapisJobId);
                    } catch (error) {
                        if (error.response && error.response.status === 404) {
                            await act(record, 'close missing job', async () => this.recordState(record.jobName, STATES.DONE, { doneReason: 'not found in Tapis' }));
                            continue;
                        }
                        logTapisRequestFailure('vacuum job lookup', error, { tapisJobId: record.tapisJobId, user: `${record.owner}@${record.ownerTenant || ''}` });
                        continue;
                    }
                    // The lookup awaited; a registration may have moved the record on.
                    const fresh = this.registry.get(record.jobName);
                    if (!fresh || fresh.state !== record.state) continue;
                    const tapisStatus = String((job && job.status) || '').toUpperCase();
                    if (!tapisStatus) {
                        logger.warn(`[TAPIS] vacuum: no status for job ${record.tapisJobId}; no decision this tick`);
                        continue;
                    }
                    if (TERMINAL_STATUSES.has(tapisStatus)) {
                        await act(record, `close ${tapisStatus.toLowerCase()} job`, async () => {
                            const node = nodes.find(n => n.getTapisJobId && n.getTapisJobId() === record.tapisJobId);
                            // Read who depends on the job before its pending entry and routes go.
                            const lostTasks = FAILED_STATUSES.has(tapisStatus)
                                ? await this.collectJobTasks(record.tapisJobId, node, routetable).catch(() => []) : [];
                            this.activeJobs.delete(record.tapisJobId);
                            this.consumePendingTask(record.tapisJobId);
                            this.recordState(record.jobName, STATES.DONE, {
                                doneReason: tapisStatus.toLowerCase(), tapisStatus, remoteOutcome: (job && job.remoteOutcome) || undefined
                            });
                            if (lostTasks.length) await this.failTasks(lostTasks, this.failureMessage(job), tasktable);
                            if (node) { await routetable.removeByNode(node); nodes.remove(node); }
                        });
                        continue;
                    }

                    if (record.state === STATES.SUBMITTED) {
                        if (PRE_RUN_STATUSES.has(tapisStatus)) {
                            if (age > this.maxQueueWaitMs(record.queue)) {
                                await act(record, 'cancel job queued too long', () => cancelRecord(record, token, 'queued too long'));
                            }
                            continue;
                        }
                        // RUNNING (or an unexpected status) without a registration.
                        const runningSince = Number(record.runningSeenAt || (job && job.remoteStarted && Date.parse(job.remoteStarted)) || 0) || now;
                        if (!record.runningSeenAt) this.recordUpsert({ jobName: record.jobName, runningSeenAt: runningSince, tapisStatus });
                        if (now - runningSince > graceMs) {
                            await act(record, 'cancel running job that never registered', () => cancelRecord(record, token, 'never registered'));
                        }
                        continue;
                    }

                    if (record.state === STATES.REGISTERED) {
                        const node = nodes.find(n => n.getTapisJobId && n.getTapisJobId() === record.tapisJobId);
                        if (!node) {
                            await act(record, 'cancel job whose node is gone', () => cancelRecord(record, token, 'node removed'));
                            continue;
                        }
                        if (node.isOnline()) {
                            const routes = await routetable.findByNode(node);
                            const busy = node.getInfoProperty('taskQueueCount', 0) > 0 || (routes && Object.keys(routes).length > 0) || node.transients > 0;
                            if (busy) {
                                if (record.idleTicks) this.recordUpsert({ jobName: record.jobName, idleTicks: 0, idleSince: null });
                                continue;
                            }
                            const ticks = (record.idleTicks || 0) + 1;
                            const idleSince = record.idleSince || now;
                            this.recordUpsert({ jobName: record.jobName, idleTicks: ticks, idleSince });
                            if (ticks >= idleTicks && now - idleSince > idleMs) {
                                await act(record, 'remove idle worker', () => removeAndCleanupNode(node));
                            }
                            continue;
                        }
                        // Offline: the node sweep at the top of this pass removes it once it has
                        // been silent for maxUploadTime, token or not. Idle counting restarts.
                        if (record.idleTicks) this.recordUpsert({ jobName: record.jobName, idleTicks: 0, idleSince: null });
                    }
                } catch (error) {
                    logger.warn(`[TAPIS] vacuum skipped ${record.jobName}: ${error.message}`);
                }
            }
            const pruned = this.registry.prune(retentionMs);
            if (pruned) logger.info(`[TAPIS] vacuum pruned ${pruned} closed job record(s)`);
        } finally {
            this.vacuumRunning = false;
        }
        return { actions, dryRun };
    }

    async cancelJob(token, tapisJobId) {
        let result;
        try {
            result = await cancelTapisJob(this.createApiClient(token), tapisJobId);
        } catch (error) {
            result = { outcome: 'failed', tapisJobId, message: String(error.message || error).slice(0, 300) };
        }
        const line = `[TAPIS] job cancel ${result.outcome}: ${JSON.stringify({
            tapisJobId,
            user: describeTokenUser(token),
            status: result.status,
            elapsedMs: result.elapsedMs,
            message: result.message
        })}`;
        if (isTerminalOutcome(result)) logger.info(line); else logger.warn(line);
        return result;
    }

    // Keep a job whose cancel did not succeed so a later sweep can retry while
    // the token is still valid. Tokens live only in memory.
    parkCancelFailed(tapisJobId, token, outcome, extra = {}) {
        this.activeJobs.set(tapisJobId, Object.assign(this.activeJobs.get(tapisJobId) || {}, extra, {
            tapisJobId,
            token,
            status: 'cancelFailed',
            cancelOutcome: outcome && outcome.outcome,
            cancelRequestedAt: Date.now()
        }));
        const previous = this.registry && this.registry.get(tapisJobId);
        this.recordState(tapisJobId, STATES.CANCEL_FAILED, {
            cancelOutcome: outcome && outcome.outcome,
            cancelRequestedAt: Date.now(),
            unauthorizedCount: ((previous && previous.unauthorizedCount) || 0) + (outcome && outcome.outcome === 'unauthorized' ? 1 : 0)
        });
    }

    // Registry helpers tolerate a provider used before initialize() in tests.
    recordState(identifier, state, extra = {}) {
        if (!this.registry) return null;
        return this.registry.setState(identifier, state, extra);
    }

    recordUpsert(record) {
        if (!this.registry) return null;
        return this.registry.upsert(record);
    }

    // A restored record gets the worker's validated bearer so it can be cancelled later.
    adoptToken(tapisJobId, token) {
        const active = this.activeJobs.get(tapisJobId);
        if (active && !active.token) active.token = token;
        const pending = this.findPendingTask(tapisJobId);
        if (pending && !pending.token) pending.token = token;
        const identity = extractUserFromToken(token);
        const record = this.registry && this.registry.get(tapisJobId);
        if (record) {
            this.recordUpsert({
                jobName: record.jobName,
                bearerExpiresAt: identity ? identity.expiresAt : null,
                unauthorizedCount: 0,
                state: record.state === STATES.UNREACHABLE ? STATES.SUBMITTED : record.state
            });
        }
    }

    // Single place that gives up on a job ClusterODX cannot cancel itself. Emits
    // the operator line once, with everything needed to cancel it by hand.
    markUnreachable(identifier, reason, { dryRun = false } = {}) {
        const record = this.registry && this.registry.get(identifier);
        if (!record || record.state === STATES.UNREACHABLE) return record || null;
        logger.error(`[TAPIS] orphan requires operator action: ${JSON.stringify({
            jobName: record.jobName,
            tapisJobId: record.tapisJobId || null,
            user: record.owner ? `${record.owner}@${record.ownerTenant || ''}` : 'unknown',
            queue: record.queue || null,
            reason
        })}`);
        if (dryRun) return record;
        return this.recordState(record.jobName, STATES.UNREACHABLE, { reason, unreachableAt: Date.now() });
    }

    // Called by the registration webhook once the task has been handed to the worker.
    markRegistered(tapisJobId, node) {
        return this.recordState(tapisJobId, STATES.REGISTERED, {
            registeredAt: Date.now(),
            node: node && typeof node.hostname === 'function' ? { hostname: node.hostname(), port: node.port() } : null
        });
    }

    // Look a submission up by its unique job name when Tapis did not answer in time.
    // Returns the Tapis job object or null. Never throws.
    async reconcileSubmission(token, jobName, startedAt, status = null) {
        const seconds = Number(this.getConfig('tapis.submitReconcileSeconds', 120));
        const cap = Number(this.getConfig('tapis.maxReconcileConcurrency', 5)) || 5;
        const pollMs = Number(this.getConfig('tapis.reconcilePollMs', 10000)) || 10000;
        if (!(seconds > 0)) return null;
        if (activeReconciles >= cap) {
            logger.warn(`[TAPIS] submission reconcile skipped for ${jobName}: ${activeReconciles} lookups already running`);
            return null;
        }
        activeReconciles++;
        const identity = extractUserFromToken(token);
        const appId = this.getConfig('app.appId');
        const appVersion = this.getConfig('app.appVersion');
        const deadline = Date.now() + seconds * 1000;
        let delay = pollMs;
        try {
            for (;;) {
                try {
                    const response = await this.createApiClient(token).get('/v3/jobs/search', {
                        params: { search: `name.eq.${jobName}` },
                        timeout: 30000
                    });
                    const jobs = ((response && response.data && response.data.result) || []).filter(job =>
                        job && job.name === jobName &&
                        (!job.appId || job.appId === appId) &&
                        (!job.appVersion || job.appVersion === appVersion) &&
                        (!identity || !job.owner || job.owner === identity.username) &&
                        (!job.created || Date.parse(job.created) >= startedAt - 60000));
                    if (jobs.length === 1 && jobs[0].uuid) return jobs[0];
                    if (jobs.length > 1) {
                        logger.warn(`[TAPIS] submission reconcile for ${jobName} found ${jobs.length} jobs; refusing to guess`);
                        return null;
                    }
                } catch (error) {
                    logTapisRequestFailure('reconcile submission', error, { jobName, user: describeTokenUser(token) });
                }
                // An abort while polling does not stop the lookup: the uuid is
                // needed to cancel the job, and createNode cancels on return.
                if (Date.now() >= deadline) return null;
                await sleep(Math.max(1, Math.min(delay, deadline - Date.now())));
                delay = Math.min(Math.round(delay * 1.5), 30000);
            }
        } finally {
            activeReconciles--;
        }
    }

    calculateNodeSubmissionPlan(imagesCount, taskOptions = []) {
        const mapping = this.getJobPropertiesFor(imagesCount) || {};
        const requested = Number(tapisTaskOptions.getTaskOption(taskOptions, 'tapis-node')) ||
            Number(mapping.computeNodeCount || mapping.nodeCount || this.getConfig('job.nodeCount', 1)) || 1;
        const maximum = Number(this.getConfig('job.maxNodesPerJob', 1)) || 1;
        return {
            jobProps: mapping,
            nodesForJob: Math.max(1, Math.min(maximum, requested)),
            requestedNodeCount: requested,
            maxNodesPerJob: maximum,
            jobsToSubmit: Math.max(1, Number(mapping.tapisJobCount || mapping.jobCount || 1)),
            nodesToSubmit: Math.max(1, Number(mapping.jobCount || 1))
        };
    }

    async submitJobWithoutData(token, jobId, imagesCount, taskOptions = [], status = null, extraEnvVariables = []) {
        const plan = this.calculateNodeSubmissionPlan(imagesCount, taskOptions);
        const mapping = plan.jobProps || {};
        const queue = tapisTaskOptions.getTaskOption(taskOptions, 'tapis-queue') || this.getDefaultQueue(imagesCount);
        const allocation = tapisTaskOptions.getTaskOption(taskOptions, 'tapis-allocation') || this.getConfig('scheduler.defaultAllocation', '');
        const maxMinutes = parseMinutes(tapisTaskOptions.getTaskOption(taskOptions, 'tapis-max-run-time') || mapping.maxJobTime || this.getConfig('job.maxJobTime', '01:00:00'));
        // Cores and memory follow the queue when it has its own tier; otherwise the image-count tier.
        const shape = this.getJobShapeForQueue(queue) || mapping;
        const job = {
            name: String(jobId),
            appId: this.getConfig('app.appId'),
            appVersion: this.getConfig('app.appVersion'),
            execSystemId: this.getConfig('system.executionSystemId'),
            execSystemLogicalQueue: queue,
            archiveSystemId: this.getConfig('system.archiveSystemId'),
            nodeCount: plan.nodesForJob,
            coresPerNode: Number(shape.coresPerNode || mapping.coresPerNode || this.getConfig('job.coresPerNode', 1)),
            memoryMB: Number(shape.memoryMB || mapping.memoryMB || this.getConfig('job.memoryMB', 4096)),
            maxMinutes,
            archiveOnAppError: this.getConfig('job.archiveOnAppError', true),
            parameterSet: {
                appArgs: this.getConfig('job.appArgs', []),
                envVariables: buildWorkerEnvVariables(this.getConfig('job.envVariables', []), token,
                    this.getConfig('worker.allowSharedSecretPrimaryRegistration', false) === true
                        ? config.registration_secret || this.getConfig('worker.registrationSecret', '') : '',
                    extraEnvVariables),
                schedulerOptions: allocation ? [{ arg: `-A ${allocation}`, name: 'TACC Allocation' }] : []
            },
            subscriptions: []
        };
        const jobSummary = summarizeJob(job);
        const identity = extractUserFromToken(token);
        logger.info(`[TAPIS] Submission plan resolved: ${JSON.stringify({
            jobId: String(jobId),
            user: describeTokenUser(token),
            imagesCount,
            mappingMaxImages: mapping.maxImages || null,
            shapeSource: shape === mapping ? 'imageCount' : 'queue',
            appId: job.appId,
            appVersion: job.appVersion,
            queue: job.execSystemLogicalQueue,
            nodeCount: job.nodeCount,
            coresPerNode: job.coresPerNode,
            memoryMB: job.memoryMB,
            maxMinutes: job.maxMinutes,
            appArgNames: jobSummary.appArgNames,
            envVariableKeys: jobSummary.envVariableKeys
        })}`);
        const timeoutMs = this.getSubmitTimeoutMs();
        const startedAt = Date.now();
        this.recordUpsert({
            jobName: job.name,
            state: STATES.SUBMITTING,
            owner: identity ? identity.username : null,
            ownerTenant: identity ? identity.tenantId : null,
            bearerExpiresAt: identity ? identity.expiresAt : null,
            imagesCount,
            queue: job.execSystemLogicalQueue,
            nodeCount: job.nodeCount,
            maxMinutes: job.maxMinutes,
            submittedAt: startedAt
        });
        let uuid = null;
        let httpStatus = null;
        let reconciled = false;
        try {
            const response = await this.createApiClient(token).post('/v3/jobs/submit', job, { timeout: timeoutMs });
            httpStatus = response && response.status;
            uuid = response && response.data && response.data.result && response.data.result.uuid;
            if (!uuid) throw new Error('Tapis response did not include a job UUID');
        } catch (error) {
            const responseStatus = error.response && error.response.status;
            logTapisRequestFailure('submit job', error, {
                baseUrl: this.getConfig('tapis.baseUrl'),
                jobId: String(jobId),
                user: describeTokenUser(token),
                status: httpStatus || responseStatus,
                timeoutMs,
                elapsedMs: Date.now() - startedAt,
                job: summarizeJob(job)
            });
            // A definite 4xx means Tapis rejected the request and no job exists.
            // Anything else (timeout, no response, 5xx, missing uuid) is ambiguous:
            // Tapis may have created the job, so look it up by its unique name.
            const definiteRejection = responseStatus && responseStatus >= 400 && responseStatus < 500;
            if (!definiteRejection) {
                const found = await this.reconcileSubmission(token, job.name, startedAt, status);
                if (found) {
                    uuid = found.uuid;
                    reconciled = true;
                    logger.info(`[TAPIS] Job submission reconciled: ${JSON.stringify({
                        jobId: String(jobId),
                        user: describeTokenUser(token),
                        tapisJobId: uuid,
                        tapisStatus: found.status,
                        elapsedMs: Date.now() - startedAt
                    })}`);
                }
            }
            if (!uuid) {
                this.recordUpsert({
                    jobName: job.name,
                    state: definiteRejection ? STATES.DONE : STATES.SUBMITTING,
                    doneReason: definiteRejection ? 'rejected' : undefined,
                    submitFailedAt: Date.now(),
                    lastError: { status: responseStatus || null, code: error.code || null }
                });
                throw error;
            }
        }
        if (!reconciled) {
            logger.info(`[TAPIS] Job submission accepted: ${JSON.stringify({
                jobId: String(jobId),
                user: describeTokenUser(token),
                tapisJobId: uuid,
                status: httpStatus,
                elapsedMs: Date.now() - startedAt
            })}`);
        }
        this.activeJobs.set(uuid, { jobId, imagesCount, status: 'SUBMITTING', token });
        this.recordUpsert({ jobName: job.name, tapisJobId: uuid, state: STATES.SUBMITTED, acceptedAt: Date.now(), reconciled });
        return { primaryJobId: uuid, submittedJobs: [{ tapisJobId: uuid, jobName: job.name }] };
    }

    async createNode(req, imagesCount, token, hostname, status, taskOptions = [], fileNames = [], tmpPath = null, clusterTaskId = null, pathImport = null, submissionParams = {}, extraEnvVariables = [], resume = null) {
        if (!token) throw new Error('Tapis token is required for Tapis-backed task creation');
        if (!this.canHandle(imagesCount)) throw new Error(`Cannot handle ${imagesCount} images.`);

        await this.validateToken(token);
        const identity = extractUserFromToken(token);
        // Write-ahead: the task-level fields a restored record needs for handoff.
        this.recordUpsert(Object.assign({
            jobName: hostname,
            taskId: clusterTaskId || hostname,
            state: STATES.SUBMITTING,
            owner: identity ? identity.username : null,
            ownerTenant: identity ? identity.tenantId : null,
            bearerExpiresAt: identity ? identity.expiresAt : null,
            imagesCount,
            taskOptions: tapisTaskOptions.stripTapisOptions(taskOptions),
            fileNames,
            tmpPath,
            pathImport,
            submissionParams
        }, resume ? {
            // Registered before the submit so a restart cannot orphan the resume.
            checkpointResume: true, resumeOf: resume.resumeOf, newUuid: resume.newUuid, class: resume.class, stage: resume.stage
        } : {}));
        const submission = await this.submitJobWithoutData(token, hostname, imagesCount, taskOptions, status, extraEnvVariables);
        if (status && status.aborted) {
            const cancelled = await this.cancelJob(token, submission.primaryJobId);
            if (isTerminalOutcome(cancelled)) {
                this.activeJobs.delete(submission.primaryJobId);
                this.recordState(submission.primaryJobId, STATES.DONE, { doneReason: 'aborted' });
            } else {
                this.parkCancelFailed(submission.primaryJobId, token, cancelled, { jobId: hostname, taskId: clusterTaskId || hostname });
            }
            throw new Error('Aborted');
        }
        const pending = {
            taskId: clusterTaskId || hostname,
            jobId: hostname,
            tapisJobId: submission.primaryJobId,
            imagesCount,
            taskOptions: tapisTaskOptions.stripTapisOptions(taskOptions),
            fileNames,
            tmpPath,
            pathImport,
            submissionParams,
            token,
            nodeUser: identity ? identity.fullUser : null,
            tapisJobOwner: identity ? identity.username : null,
            tapisJobOwnerTenant: identity ? identity.tenantId : null,
            submittedJobs: submission.submittedJobs
        };
        if (resume) {
            Object.assign(pending, {
                checkpointResume: true,
                resumeTaskUuid: resume.resumeOf,
                resumeNewUuid: resume.newUuid || null,
                resumeClass: resume.class || null
            });
        }
        this.activeJobs.set(submission.primaryJobId, Object.assign(this.activeJobs.get(submission.primaryJobId) || {}, {
            tapisJobId: submission.primaryJobId,
            tapisJobOwner: pending.tapisJobOwner,
            tapisJobOwnerTenant: pending.tapisJobOwnerTenant
        }));
        this.pendingTasks.set(hostname, pending);
        this.pendingTasks.set(submission.primaryJobId, pending);
        this.pendingTasks.set(pending.taskId, pending);
        return null;
    }

    findRegistrationJob(identifier) {
        const job = this.findPendingTask(identifier) || this.activeJobs.get(identifier);
        if (!job) return null;
        // Active jobs are keyed by the actual submitted Tapis UUID.
        if (job.tapisJobId && job.tapisJobId !== identifier) return null;
        return job;
    }

    findPendingTask(identifier) {
        if (!identifier) return null;
        return this.pendingTasks.get(identifier) || null;
    }

    findPendingTaskByUser(identity) {
        if (!identity) return { task: null, count: 0 };

        const uniqueTasks = [...new Set(this.pendingTasks.values())];
        const matches = uniqueTasks.filter(task => sameUser(task, identity));
        return {
            task: matches.length === 1 ? matches[0] : null,
            count: matches.length
        };
    }

    claimPendingTask(pending) {
        if (!pending || pending.registrationClaimed) return false;
        pending.registrationClaimed = true;
        pending.registrationClaimedAt = Date.now();
        return true;
    }

    releasePendingTask(pending) {
        if (!pending) return false;
        delete pending.registrationClaimed;
        delete pending.registrationClaimedAt;
        return true;
    }

    consumePendingTask(identifier) {
        const pending = this.findPendingTask(identifier);
        if (!pending) return null;
        for (const [key, value] of this.pendingTasks.entries()) {
            if (value === pending) this.pendingTasks.delete(key);
        }
        return pending;
    }

    async cancelPendingTask(identifier, reason = 'cancelled') {
        const pending = this.findPendingTask(identifier);
        if (!pending) return false;
        // Consume first: once a cancel is requested the task must never be handed
        // to a worker, even if Tapis refuses or times out below.
        this.consumePendingTask(identifier);
        if (!pending.token) {
            this.markUnreachable(pending.tapisJobId, 'cancel requested but no token in memory (submitted before a restart)');
            return true;
        }
        this.recordState(pending.tapisJobId, STATES.CANCEL_REQUESTED, { cancelRequestedAt: Date.now() });
        let cancelled = await this.cancelJob(pending.token, pending.tapisJobId);
        if (!isTerminalOutcome(cancelled)) {
            // A job that is already ending (a failed resume's worker exits by itself) can
            // refuse the cancel; if Tapis says it is terminal there is nothing to retry.
            const job = await this.getJob(pending.token, pending.tapisJobId).catch(() => null);
            if (job && TERMINAL_STATUSES.has(String(job.status || '').toUpperCase())) cancelled = { outcome: 'cancelled' };
        }
        if (isTerminalOutcome(cancelled)) {
            this.activeJobs.delete(pending.tapisJobId);
            this.recordState(pending.tapisJobId, STATES.DONE, { doneReason: reason });
        } else {
            this.parkCancelFailed(pending.tapisJobId, pending.token, cancelled, { jobId: pending.jobId, taskId: pending.taskId });
        }
        return true;
    }

    async destroyMachine(identifier) {
        return this.cancelPendingTask(identifier);
    }

    async destroyNode(node) {
        if (!node || !node.getTapisJobId) return false;
        const tapisJobId = node.getTapisJobId();
        const active = this.activeJobs.get(tapisJobId);
        if (!active || !active.token) {
            logger.warn(`[TAPIS] cannot cancel job ${tapisJobId} for ${node}: no token in memory`);
            this.markUnreachable(tapisJobId, 'node removed but no token in memory (submitted before a restart)');
            return false;
        }
        // An expired bearer cannot cancel anything; say so once instead of sending a
        // request that fails 401 and reopening a record already given up on.
        const identity = extractUserFromToken(active.token);
        const record = this.registry && this.registry.get(tapisJobId);
        if ((identity && identity.expiresAt && identity.expiresAt <= Date.now()) || (record && record.state === STATES.UNREACHABLE)) {
            logger.warn(`[TAPIS] cannot cancel job ${tapisJobId} for ${node}: token expired`);
            this.markUnreachable(tapisJobId, 'node removed but token expired');
            return false;
        }
        this.recordState(tapisJobId, STATES.CANCEL_REQUESTED, { cancelRequestedAt: Date.now() });
        const cancelled = await this.cancelJob(active.token, tapisJobId);
        if (isTerminalOutcome(cancelled)) {
            this.activeJobs.delete(tapisJobId);
            this.recordState(tapisJobId, STATES.DONE, { doneReason: 'node removed' });
            return true;
        }
        this.parkCancelFailed(tapisJobId, active.token, cancelled);
        return false;
    }

    getActiveJobStatuses() { return new Set(ACTIVE_STATUSES); }
};
