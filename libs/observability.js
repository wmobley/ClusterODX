'use strict';

const HANDOFF_EVENT = 'odx_node_handoff';
const PHASES = new Set([
    'webhook_received',
    'webhook_rejected',
    'webhook_failed',
    'webhook_completed',
    'task_submit_started',
    'task_submit_finished'
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HOSTNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const NODE_ENDPOINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}:[0-9]{1,5}$/;
const ALLOWED_FIELDS = [
    'task_id',
    'tapis_job_id',
    'node',
    'path_mode',
    'timeout_ms',
    'elapsed_ms',
    'http_status',
    'outcome',
    'error_class'
];

const safeId = value => typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;

const safeNodeEndpoint = (hostname, port) => {
    if (typeof hostname !== 'string' || !HOSTNAME_PATTERN.test(hostname)) return undefined;
    const numericPort = Number(port);
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return undefined;
    return `${hostname}:${numericPort}`;
};

const safeInteger = (value, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max) return undefined;
    return value;
};

const safePathMode = value => value === 'shared_import_path' || value === 'uploaded_files' ? value : undefined;
const safeOutcome = value => value === 'success' || value === 'failure' || value === 'rejected' ? value : undefined;
const safeNodeField = value => {
    if (typeof value !== 'string' || !NODE_ENDPOINT_PATTERN.test(value)) return undefined;
    const port = Number(value.slice(value.lastIndexOf(':') + 1));
    return port >= 1 && port <= 65535 ? value : undefined;
};
const safeErrorClass = value => [
    'auth_error',
    'filesystem_error',
    'handoff_error',
    'http_error',
    'network_error',
    'not_found',
    'not_enabled',
    'timeout',
    'unknown_error',
    'validation_error'
].indexOf(value) !== -1 ? value : undefined;

const logHandoffEvent = (logger, phase, fields = {}) => {
    if (!PHASES.has(phase)) throw new Error('Invalid observability phase');

    const event = { event: HANDOFF_EVENT, phase };
    const values = {
        task_id: safeId(fields.task_id),
        tapis_job_id: safeId(fields.tapis_job_id),
        node: safeNodeField(fields.node),
        path_mode: safePathMode(fields.path_mode),
        timeout_ms: safeInteger(fields.timeout_ms, 0, 86400000),
        elapsed_ms: safeInteger(fields.elapsed_ms, 0, 86400000),
        http_status: safeInteger(fields.http_status, 100, 599),
        outcome: safeOutcome(fields.outcome),
        error_class: safeErrorClass(fields.error_class)
    };

    for (const field of ALLOWED_FIELDS){
        if (values[field] !== undefined) event[field] = values[field];
    }

    logger.info(JSON.stringify(event));
};

const classifySubmitError = (error, fallback = 'unknown_error') => {
    if (error && error.odxErrorClass && safeErrorClass(error.odxErrorClass)) return error.odxErrorClass;
    if (error && error.response && safeInteger(error.response.status, 100, 599)) return 'http_error';
    if (error && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')) return 'timeout';
    if (error && (error.request || [
        'ECONNREFUSED',
        'ECONNRESET',
        'EAI_AGAIN',
        'ENETUNREACH',
        'ENOTFOUND'
    ].indexOf(error.code) !== -1)) return 'network_error';
    if (error && ['EACCES', 'EISDIR', 'ENFILE', 'ENOENT', 'ENOTDIR', 'EMFILE'].indexOf(error.code) !== -1) {
        return 'filesystem_error';
    }
    return safeErrorClass(fallback) || 'unknown_error';
};

module.exports = {
    classifySubmitError,
    logHandoffEvent,
    safeId,
    safeNodeEndpoint
};
