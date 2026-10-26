'use strict';

const axios = require('axios');
const AbstractASRProvider = require('../classes/AbstractASRProvider');
const tapisTaskOptions = require('../tapisTaskOptions');
const logger = require('../logger');

const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|credential|api.?key)/i;
const MAX_LOG_VALUE_LENGTH = 2000;
const SUBMISSION_TIMEOUT_MS = 60000;

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

const extractUserFromToken = token => {
    if (!token || typeof token !== 'string') return null;

    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const username = claims['tapis/username'];
        const tenantId = claims['tapis/tenant_id'];
        if (!username || !tenantId) return null;

        return {
            username: String(username),
            tenantId: String(tenantId),
            fullUser: `${username}@${tenantId}`
        };
    } catch (_error) {
        return null;
    }
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

const buildWorkerEnvVariables = (configuredEnv, tapisToken) => {
    const envVariables = Array.isArray(configuredEnv) ? configuredEnv : [];

    // Current Tapis leaves the historical ${_tapisAccessToken} macro literal.
    // Pass the request JWT explicitly so NodeODX can authenticate its webhook.
    return envVariables
        .filter(variable => variable && variable.key !== 'TAPIS_ACCESS_TOKEN' && variable.key !== '_tapisAccessToken')
        .concat({
            key: 'TAPIS_ACCESS_TOKEN',
            value: tapisToken,
            description: 'Request-scoped Tapis JWT for NodeODX worker authentication'
        });
};

module.exports = class TapisAsrProvider extends AbstractASRProvider {
    constructor(userConfig) {
        super({
            tapis: { baseUrl: 'https://portals.tapis.io', tenantId: 'portals' },
            app: { appId: 'nodeodx-ls6', appVersion: '1.0.17' },
            system: { executionSystemId: 'CHANGEME!', archiveSystemId: 'CHANGEME!', logicalQueue: 'vm-small' },
            scheduler: { defaultAllocation: '' },
            job: { maxJobTime: '01:00:00', nodeCount: 1, coresPerNode: 1, memoryMB: 4096, archiveOnAppError: true, maxNodesPerJob: 1, appArgs: [], envVariables: [] },
            worker: { registrationSecret: '' },
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
        mappings.sort((a, b) => Number(a.maxImages || 0) - Number(b.maxImages || 0));
    }

    getDriverName() { return 'tapis'; }
    getCreateRetries() { return Number(this.getConfig('createRetries', 3)) || 3; }
    getMaxRuntime() { return Number(this.getConfig('maxRuntime', -1)); }
    getMaxUploadTime() { return Number(this.getConfig('maxUploadTime', -1)); }
    getMachinesLimit() { return Number(this.getConfig('jobLimit', -1)); }
    getNodesPendingCreation() { return new Set(this.pendingTasks.values()).size; }
    getDownloadsBaseUrl() { return `${this.getConfig('tapis.baseUrl')}/v3/files`; }

    getJobPropertiesFor(imagesCount) {
        return (this.getConfig('imageSizeMapping', []) || []).find(mapping => Number(mapping.maxImages) >= imagesCount) || null;
    }

    canHandle(imagesCount) { return this.getJobPropertiesFor(imagesCount) !== null; }

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
        const nodeOptions = this.getConfig('nodeOptions', []);
        if (!Array.isArray(nodeOptions)) throw new Error('Invalid config key nodeOptions (array expected)');
        return nodeOptions.concat(this.getClusterOptions());
    }

    createApiClient(token) {
        if (!token || typeof token !== 'string') throw new Error('Tapis token is required');
        return axios.create({
            baseURL: this.getConfig('tapis.baseUrl'),
            headers: { 'X-Tapis-Token': token }
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

    async cancelJob(token, tapisJobId) {
        await this.createApiClient(token).put(`/v3/jobs/${encodeURIComponent(tapisJobId)}`, { operation: 'stop' });
        return true;
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

    async submitJobWithoutData(token, jobId, imagesCount, taskOptions = []) {
        const plan = this.calculateNodeSubmissionPlan(imagesCount, taskOptions);
        const mapping = plan.jobProps || {};
        const queue = tapisTaskOptions.getTaskOption(taskOptions, 'tapis-queue') || this.getDefaultQueue(imagesCount);
        const allocation = tapisTaskOptions.getTaskOption(taskOptions, 'tapis-allocation') || this.getConfig('scheduler.defaultAllocation', '');
        const maxMinutes = parseMinutes(tapisTaskOptions.getTaskOption(taskOptions, 'tapis-max-run-time') || mapping.maxJobTime || this.getConfig('job.maxJobTime', '01:00:00'));
        const job = {
            name: String(jobId),
            appId: this.getConfig('app.appId'),
            appVersion: this.getConfig('app.appVersion'),
            execSystemId: this.getConfig('system.executionSystemId'),
            execSystemLogicalQueue: queue,
            archiveSystemId: this.getConfig('system.archiveSystemId'),
            nodeCount: plan.nodesForJob,
            coresPerNode: Number(mapping.coresPerNode || this.getConfig('job.coresPerNode', 1)),
            memoryMB: Number(mapping.memoryMB || this.getConfig('job.memoryMB', 4096)),
            maxMinutes,
            archiveOnAppError: this.getConfig('job.archiveOnAppError', true),
            parameterSet: {
                appArgs: this.getConfig('job.appArgs', []),
                envVariables: buildWorkerEnvVariables(this.getConfig('job.envVariables', []), token),
                schedulerOptions: allocation ? [{ arg: `-A ${allocation}`, name: 'TACC Allocation' }] : []
            },
            subscriptions: []
        };
        const jobSummary = summarizeJob(job);
        logger.info(`[TAPIS] Submission plan resolved: ${JSON.stringify({
            jobId: String(jobId),
            imagesCount,
            mappingMaxImages: mapping.maxImages || null,
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
        let response;
        const startedAt = Date.now();
        try {
            response = await this.createApiClient(token).post('/v3/jobs/submit', job, {
                timeout: SUBMISSION_TIMEOUT_MS
            });
            const uuid = response && response.data && response.data.result && response.data.result.uuid;
            if (!uuid) throw new Error('Tapis response did not include a job UUID');
        } catch (error) {
            logTapisRequestFailure('submit job', error, {
                baseUrl: this.getConfig('tapis.baseUrl'),
                jobId: String(jobId),
                status: response ? response.status : error.response && error.response.status,
                timeoutMs: SUBMISSION_TIMEOUT_MS,
                elapsedMs: Date.now() - startedAt,
                job: summarizeJob(job)
            });
            throw error;
        }
        const uuid = response.data.result.uuid;
        logger.info(`[TAPIS] Job submission accepted: ${JSON.stringify({
            jobId: String(jobId),
            tapisJobId: uuid,
            status: response.status,
            elapsedMs: Date.now() - startedAt
        })}`);
        this.activeJobs.set(uuid, { jobId, imagesCount, status: 'SUBMITTING', token });
        return { primaryJobId: uuid, submittedJobs: [{ tapisJobId: uuid, jobName: job.name }] };
    }

    async createNode(req, imagesCount, token, hostname, status, taskOptions = [], fileNames = [], tmpPath = null, clusterTaskId = null, pathImport = null) {
        if (!token) throw new Error('Tapis token is required for Tapis-backed task creation');
        if (!this.canHandle(imagesCount)) throw new Error(`Cannot handle ${imagesCount} images.`);

        await this.validateToken(token);
        const identity = extractUserFromToken(token);
        const submission = await this.submitJobWithoutData(token, hostname, imagesCount, taskOptions);
        if (status && status.aborted) {
            await this.cancelJob(token, submission.primaryJobId);
            this.activeJobs.delete(submission.primaryJobId);
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
            token,
            nodeUser: identity ? identity.fullUser : null,
            tapisJobOwner: identity ? identity.username : null,
            tapisJobOwnerTenant: identity ? identity.tenantId : null,
            submittedJobs: submission.submittedJobs
        };
        this.pendingTasks.set(hostname, pending);
        this.pendingTasks.set(submission.primaryJobId, pending);
        this.pendingTasks.set(pending.taskId, pending);
        return null;
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

    async cancelPendingTask(identifier) {
        const pending = this.findPendingTask(identifier);
        if (!pending) return false;
        await this.cancelJob(pending.token, pending.tapisJobId);
        this.consumePendingTask(identifier);
        this.activeJobs.delete(pending.tapisJobId);
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
            return false;
        }
        await this.cancelJob(active.token, tapisJobId);
        this.activeJobs.delete(tapisJobId);
        return true;
    }

    getActiveJobStatuses() { return new Set(ACTIVE_STATUSES); }
};
