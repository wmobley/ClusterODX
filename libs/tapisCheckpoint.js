'use strict';

const fs = require('fs');
const path = require('path');

// Pure helpers for LS6 checkpoint resume: where a task's checkpoint manifest lives,
// whether that checkpoint is resumable, and the per-job environment a resuming
// worker needs. No provider state and no network; libs/asr-providers/tapis.js and
// libs/proxy.js own the orchestration.
//
// The manifest is written by the worker (nodeodx-ls6 lib/checkpoint.sh, schema 2);
// ClusterODX only reads it.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN_SCHEMA_VERSION = 2;

// Every reason a lookup can give for "not resumable".
const REASONS = Object.freeze({
    NO_MANIFEST: 'no_manifest',
    LEGACY_MANIFEST: 'legacy_manifest',
    PARTIAL: 'partial',
    WRITE_FAILED: 'write_failed',
    EXPIRED: 'expired',
    OPTIMIZE_DISK_SPACE: 'optimize_disk_space',
    INCONSISTENT: 'inconsistent',
    DISABLED: 'disabled',
    NOT_OWNER: 'not_owner',
    NO_DATA: 'no_data' // manifest_only: the worker wrote a manifest but copying was off
});

// Manifest states after which the worker is done writing, for better or worse.
const SYNC_FINISHED_STATES = new Set(['synced', 'write_failed', 'partial']);

// Fields a schema 2 manifest must carry for the rule below to be evaluated.
const REQUIRED_FIELDS = ['schemaVersion', 'state', 'dataComplete', 'expiresAt', 'stagesCompleted', 'split', 'optimizeDiskSpace'];

const SPLIT_CLASSES = Object.freeze({ MERGE: 'M', SURFACE: 'O' });
const SUBMODEL_RERUN_STAGE = 'odm_meshing';

// A resume the lookup or the request rules out. `reason` is a REASONS code or one of
// the request-level codes (class_not_resumable, node_count_too_small, ...).
class ResumeRefusal extends Error {
    constructor(reason, message) {
        // The reason code is always in the text: WebODM shows the message as the task error.
        super(message ? (message.includes(reason) ? message : `${message} (${reason})`) : `Task cannot be resumed (${reason})`);
        this.name = 'ResumeRefusal';
        this.reason = reason;
    }
}

const isTaskUuid = value => typeof value === 'string' && UUID_PATTERN.test(value);

const assertTaskUuid = taskId => {
    if (!isTaskUuid(taskId)) throw new Error(`Invalid task UUID for checkpoint resume: ${taskId || ''}`);
};

const manifestPath = (root, taskId) => {
    assertTaskUuid(taskId);
    return path.join(root, taskId, 'manifest.json');
};

// Resolves { manifest } or { manifest: null, reason }. Never throws for a missing
// or unreadable file: the caller turns that into a "not resumable" answer.
const readManifest = async (root, taskId, logger = null) => {
    let text;
    try {
        text = await fs.promises.readFile(manifestPath(root, taskId), 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT' && logger) logger.warn(`[TAPIS] cannot read checkpoint manifest for ${taskId}: ${error.code || error.message}`);
        return { manifest: null, reason: REASONS.NO_MANIFEST };
    }
    try {
        const manifest = JSON.parse(text);
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest root is not an object');
        return { manifest };
    } catch (error) {
        if (logger) logger.warn(`[TAPIS] checkpoint manifest for ${taskId} is not valid JSON: ${error.message}`);
        return { manifest: null, reason: REASONS.PARTIAL };
    }
};

// expiresAt is epoch seconds in the worker's schema 2; epoch milliseconds and ISO text are accepted too.
const expiryMillis = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    if (typeof value === 'string' && value.trim() !== '') {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

// The worker's `submodelCloudsPresent` boolean (null when not split); when it is
// absent, fall back to the per-submodel map `submodelClouds` ({name: bool}, all
// values must be true). Missing or empty means a class O re-run is not possible.
const allSubmodelCloudsPresent = (value, perSubmodel = null) => {
    if (value === true || value === false) return value;
    const source = perSubmodel !== null && perSubmodel !== undefined ? perSubmodel : value;
    const items = Array.isArray(source) ? source : (source && typeof source === 'object' ? Object.values(source) : []);
    return items.length > 0 && items.every(item => item === true);
};

// The resumability rule (spec A.5 as ClusterODX can evaluate it from the manifest):
//   state == synced && dataComplete && !expired && !optimizeDiskSpace
// The worker re-checks engine version, image digest and stage prerequisites at
// restore and reports a resumeFallbackReason if they fail; ClusterODX does not
// know the worker image, so those are not part of the lookup.
//
// Returns { resumable, reason, expiresAt, engineVersion, stagesCompleted,
// checkpointBytes, split, resumableClasses, schemaVersion }. resumableClasses is
// [] for a non-split task (one implicit class), ['M', 'O'] for a split task whose
// submodels all kept their point clouds, ['M'] when some did not (classReason
// says why O is missing).
const evaluateManifest = (manifest, { now = Date.now() } = {}) => {
    const answer = {
        resumable: false,
        reason: null,
        expiresAt: null,
        engineVersion: null,
        stagesCompleted: [],
        checkpointBytes: null,
        split: false,
        resumableClasses: [],
        schemaVersion: null
    };
    if (!manifest || typeof manifest !== 'object') return Object.assign(answer, { reason: REASONS.NO_MANIFEST });

    Object.assign(answer, {
        expiresAt: manifest.expiresAt === undefined ? null : manifest.expiresAt,
        engineVersion: manifest.engineVersion === undefined ? null : manifest.engineVersion,
        stagesCompleted: Array.isArray(manifest.stagesCompleted) ? manifest.stagesCompleted.slice() : [],
        checkpointBytes: Number.isFinite(Number(manifest.checkpointBytes)) && manifest.checkpointBytes !== null ? Number(manifest.checkpointBytes) : null,
        split: manifest.split === true,
        schemaVersion: Number.isFinite(Number(manifest.schemaVersion)) ? Number(manifest.schemaVersion) : null
    });

    const missing = REQUIRED_FIELDS.some(field => manifest[field] === undefined || manifest[field] === null);
    const expiresAtMs = expiryMillis(manifest.expiresAt);
    if (missing || !(answer.schemaVersion >= MIN_SCHEMA_VERSION) || expiresAtMs === null) {
        return Object.assign(answer, { reason: REASONS.LEGACY_MANIFEST });
    }
    answer.expiresAt = expiresAtMs; // always epoch milliseconds, whatever the worker wrote

    const state = String(manifest.state);
    if (state === 'write_failed') return Object.assign(answer, { reason: REASONS.WRITE_FAILED });
    if (state === 'inconsistent') return Object.assign(answer, { reason: REASONS.INCONSISTENT });
    if (state === 'expired') return Object.assign(answer, { reason: REASONS.EXPIRED });
    if (state === 'manifest_only') return Object.assign(answer, { reason: REASONS.NO_DATA });
    if (state !== 'synced' || manifest.dataComplete !== true) return Object.assign(answer, { reason: REASONS.PARTIAL });
    if (expiresAtMs <= now) return Object.assign(answer, { reason: REASONS.EXPIRED });
    if (manifest.optimizeDiskSpace === true) return Object.assign(answer, { reason: REASONS.OPTIMIZE_DISK_SPACE });

    answer.resumable = true;
    if (answer.split) {
        if (allSubmodelCloudsPresent(manifest.submodelCloudsPresent, manifest.submodelClouds)) {
            answer.resumableClasses = [SPLIT_CLASSES.MERGE, SPLIT_CLASSES.SURFACE];
        } else {
            answer.resumableClasses = [SPLIT_CLASSES.MERGE];
            answer.classReason = 'submodel_clouds_missing';
        }
    }
    return answer;
};

// True once the worker has finished writing the checkpoint. A manifest left by an
// earlier run of the same task (replace-mode resume) must not release the teardown:
// when the manifest names its writer job it has to be the job that is waiting.
const syncFinished = (manifest, tapisJobId = null) => {
    if (!manifest || !SYNC_FINISHED_STATES.has(String(manifest.state))) return false;
    if (tapisJobId && manifest.writerJobUuid && String(manifest.writerJobUuid) !== String(tapisJobId)) return false;
    return true;
};

// Stages from which each submodel is re-run (class O): odm_meshing onward.
const SURFACE_STAGES = new Set(['odm_meshing', 'mvs_texturing', 'odm_georeferencing', 'odm_dem', 'odm_orthophoto', 'odm_report', 'odm_postprocess']);

// Class for a split resume when the request does not name one, from `rerun-from`:
// merge -> M; odm_meshing or later -> O; an earlier stage or none -> null (the
// caller refuses with class_unavailable: that needs a full run).
const inferSplitClass = options => {
    const list = Array.isArray(options) ? options : [];
    const option = list.find(item => item && item.name === 'rerun-from');
    const stage = option ? String(option.value) : '';
    if (stage === 'merge') return SPLIT_CLASSES.MERGE;
    return SURFACE_STAGES.has(stage) ? SPLIT_CLASSES.SURFACE : null;
};

const optionValue = (options, name) => {
    const option = options.find(item => item && item.name === name);
    return option ? option.value : null;
};

// The options the resumed task runs with. Non-split tasks run the requested options
// as given (they carry their own rerun-from). Split tasks are re-run by class:
// M re-merges (`rerun-from merge`); O also re-runs each submodel from odm_meshing
// through the internal `submodel-rerun-from` option. Any caller-supplied value for
// those names is replaced, so a request cannot widen or narrow the class.
const buildResumeOptions = (options, { split = false, resumeClass = null } = {}) => {
    const requested = Array.isArray(options) ? options.filter(option => option && typeof option === 'object' && option.name) : [];
    if (!split) return requested.map(option => Object.assign({}, option));

    const result = requested
        .filter(option => option.name !== 'rerun-from' && option.name !== 'submodel-rerun-from')
        .map(option => Object.assign({}, option));
    result.push({ name: 'rerun-from', value: 'merge' });
    if (resumeClass === SPLIT_CLASSES.SURFACE) result.push({ name: 'submodel-rerun-from', value: SUBMODEL_RERUN_STAGE });
    return result;
};

// Worker environment for a resume job, in addition to the usual job env.
const buildResumeEnv = ({ taskId, newUuid = null, options, nodeRoot, intervalSeconds, retentionSeconds, allowedRoots = [], importPath = null }) => {
    assertTaskUuid(taskId);
    const env = [
        { key: 'NODEODM_CHECKPOINT_ROOT', value: nodeRoot },
        { key: 'NODEODM_CHECKPOINT_INTERVAL_SECONDS', value: `${intervalSeconds}` },
        { key: 'NODEODM_CHECKPOINT_RETENTION_SECONDS', value: `${retentionSeconds}` },
        { key: 'NODEODM_RESUME_TASK_UUID', value: taskId },
        { key: 'NODEODM_RESUME_CHECKPOINT_PATH', value: path.posix.join(nodeRoot, taskId) },
        { key: 'NODEODM_RESUME_OPTIONS_JSON', value: JSON.stringify(options) },
        { key: 'NODEODM_RESUME_ALLOW_COLD_START', value: '0' },
        { key: 'NODEODM_RESUME_ALLOWED_ROOTS', value: allowedRoots.join(':') }
    ];
    if (newUuid) env.splice(4, 0, { key: 'NODEODM_RESUME_AS_UUID', value: newUuid });
    if (importPath) env.push({ key: 'NODEODM_RESUME_IMPORT_PATH', value: importPath });
    return env;
};

module.exports = {
    ResumeRefusal,
    REASONS,
    SPLIT_CLASSES,
    SUBMODEL_RERUN_STAGE,
    MIN_SCHEMA_VERSION,
    isTaskUuid,
    assertTaskUuid,
    manifestPath,
    readManifest,
    evaluateManifest,
    allSubmodelCloudsPresent,
    syncFinished,
    buildResumeOptions,
    buildResumeEnv,
    optionValue,
    inferSplitClass
};
