'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One process owns the store. Records are committed before external effects.
class SplatTaskStore {
    constructor(directory) {
        this.directory = path.resolve(directory);
        fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
        if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('Unsafe splat store');
        this.lockPath = path.join(this.directory, '.writer.lock');
        this.lockId = crypto.randomBytes(16).toString('hex');
        try {
            this.lockFd = fs.openSync(this.lockPath, 'wx', 0o600);
        } catch (error) {
            // Never guess whether another writer is alive, especially across hosts.
            throw new Error('Splat store is locked; verify previous writer stopped before removing its lock');
        }
        fs.writeSync(this.lockFd, JSON.stringify({pid: process.pid, id: this.lockId}));
        fs.fsyncSync(this.lockFd);
        this.records = new Map();
        for (const name of fs.readdirSync(this.directory)) {
            if (!name.endsWith('.json')) continue;
            const id = name.slice(0, -5);
            if (!UUID.test(id)) continue;
            const file = path.join(this.directory, name);
            if (!fs.lstatSync(file).isFile()) throw new Error('Unsafe splat record');
            const record = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (record.uuid !== id || record.version !== 1) throw new Error('Invalid splat record');
            this.records.set(id, record);
        }
    }
    all() { return [...this.records.values()]; }
    get(id) { return this.records.get(id); }
    save(record) {
        if (!UUID.test(record.uuid)) throw new Error('Invalid task UUID');
        record.updated_at = new Date().toISOString();
        const temporary = path.join(this.directory, `${record.uuid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temporary, path.join(this.directory, `${record.uuid}.json`));
        const dir = fs.openSync(this.directory, 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        this.records.set(record.uuid, record);
        return record;
    }
    close() {
        if (this.lockFd === undefined) return;
        fs.closeSync(this.lockFd);
        this.lockFd = undefined;
        if (JSON.parse(fs.readFileSync(this.lockPath, 'utf8')).id === this.lockId) fs.unlinkSync(this.lockPath);
    }
}
module.exports = {SplatTaskStore, UUID};
