'use strict';

const fs = require('fs');
const path = require('path');

// Durable, metadata-only record of every Tapis job ClusterODX has asked for.
//
// The registry exists so a restart does not forget which jobs are queued or
// running on the HPC side. It deliberately never stores bearer tokens: cancels
// after a restart need a fresh token (a worker's registration bearer, or the
// operator), and that limitation is logged rather than papered over.
//
// Persistence mirrors libs/nodes.js and libs/routetable.js (one JSON file under
// data/) with two upgrades: writes are serialised and atomic (temp file with mode
// 0600, then rename), and a corrupt file loads as empty with a warning instead of
// crashing startup.

const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|credential|api.?key)/i;

const STATES = Object.freeze({
    SUBMITTING: 'submitting',        // write-ahead: request about to be / being sent
    SUBMITTED: 'submitted',          // Tapis accepted; waiting for the worker to register
    REGISTERED: 'registered',        // worker registered and the task was handed off
    CANCEL_REQUESTED: 'cancelRequested',
    CANCEL_FAILED: 'cancelFailed',   // Tapis refused or errored; retry while a token exists
    UNREACHABLE: 'unreachable',      // no usable token left; operator action required
    DONE: 'done'                     // terminal on the Tapis side (or never created)
});

const OPEN_STATES = new Set([STATES.SUBMITTING, STATES.SUBMITTED, STATES.REGISTERED,
    STATES.CANCEL_REQUESTED, STATES.CANCEL_FAILED]);

// A JWT or a token-bearing URL/query hidden inside a value, not just a key.
const SENSITIVE_VALUE_PATTERN = /([A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,})|([?&](token|secret|api[_-]?key|password)=)/i;

const stripSensitive = (value, depth = 0) => {
    if (typeof value === 'string') return SENSITIVE_VALUE_PATTERN.test(value) ? '[redacted]' : value;
    if (!value || typeof value !== 'object' || depth > 3) return value;
    if (Array.isArray(value)) return value.map(item => stripSensitive(item, depth + 1));
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) continue;
        clean[key] = stripSensitive(item, depth + 1);
    }
    return clean;
};

class TapisJobRegistry {
    constructor(filePath = 'data/tapis-jobs.json', options = {}) {
        this.filePath = filePath;
        this.logger = options.logger || require('./logger');
        this.now = options.now || (() => Date.now());
        this.records = new Map(); // jobName -> record
        this.writeChain = Promise.resolve();
        this.loaded = false;
    }

    load() {
        this.records.clear();
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (!Array.isArray(parsed)) throw new Error('registry root is not an array');
            for (const record of parsed) {
                if (record && typeof record.jobName === 'string') {
                    this.records.set(record.jobName, stripSensitive(record));
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.warn(`[TAPIS] job registry ${this.filePath} unreadable, starting empty: ${error.message}`);
            }
        }
        this.loaded = true;
        return this;
    }

    all() {
        return [...this.records.values()];
    }

    open() {
        return this.all().filter(record => OPEN_STATES.has(record.state));
    }

    // Look up by job name, Tapis job uuid, or ClusterODX task id.
    get(identifier) {
        if (!identifier) return null;
        if (this.records.has(identifier)) return this.records.get(identifier);
        for (const record of this.records.values()) {
            if (record.tapisJobId === identifier || record.taskId === identifier) return record;
        }
        return null;
    }

    upsert(partial) {
        if (!partial || typeof partial !== 'object') throw new Error('registry record required');
        const existing = partial.jobName ? this.records.get(partial.jobName) : this.get(partial.tapisJobId || partial.taskId);
        const jobName = partial.jobName || (existing && existing.jobName);
        if (!jobName) throw new Error('registry record needs a jobName');
        const record = Object.assign({}, existing || { createdAt: this.now() }, stripSensitive(partial), {
            jobName,
            updatedAt: this.now()
        });
        this.records.set(jobName, record);
        this.save();
        return record;
    }

    setState(identifier, state, extra = {}) {
        const record = this.get(identifier);
        if (!record) return null;
        return this.upsert(Object.assign({ jobName: record.jobName, state }, extra));
    }

    remove(identifier) {
        const record = this.get(identifier);
        if (!record) return false;
        this.records.delete(record.jobName);
        this.save();
        return true;
    }

    // Drop closed records older than maxAgeMs so the file does not grow forever.
    prune(maxAgeMs) {
        const cutoff = this.now() - maxAgeMs;
        let removed = 0;
        for (const record of this.all()) {
            if (!OPEN_STATES.has(record.state) && Number(record.updatedAt || record.createdAt || 0) < cutoff) {
                this.records.delete(record.jobName);
                removed++;
            }
        }
        if (removed) this.save();
        return removed;
    }

    save() {
        this.writeChain = this.writeChain
            .then(() => this.writeNow())
            .catch(error => this.logger.warn(`[TAPIS] cannot save job registry ${this.filePath}: ${error.message}`));
        return this.writeChain;
    }

    // Resolves when every scheduled write has finished.
    flush() {
        return this.writeChain;
    }

    async writeNow() {
        const directory = path.dirname(this.filePath);
        await fs.promises.mkdir(directory, { recursive: true });
        const tmpPath = `${this.filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpPath, JSON.stringify(this.all()), { mode: 0o600 });
        await fs.promises.rename(tmpPath, this.filePath);
        await fs.promises.chmod(this.filePath, 0o600).catch(() => {});
    }
}

TapisJobRegistry.STATES = STATES;
TapisJobRegistry.OPEN_STATES = OPEN_STATES;
TapisJobRegistry.stripSensitive = stripSensitive;

module.exports = TapisJobRegistry;
