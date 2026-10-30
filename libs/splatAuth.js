'use strict';
const crypto = require('crypto');
const {UUID} = require('./splatTaskStore');

class SplatError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new SplatError(status, code, message); };
const canonical = value => {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    throw new Error('Unsupported canonical value');
};
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function validateRequest(body, config) {
    if (!body || !UUID.test(body.run_id) || !UUID.test(body.source_task_id) || !/^[a-f0-9]{64}$/.test(body.manifest_sha256 || '')) fail(400, 'invalid_input', 'Invalid training input identifiers.');
    if (body.profile_id !== config.profileId) fail(400, 'invalid_profile', 'Unsupported training profile.');
    const s = body.settings;
    if (!s || !Number.isInteger(s.num_iterations) || s.num_iterations < 1 || s.num_iterations > 1000 || !Number.isInteger(s.image_size) || (s.image_size !== 0 && (s.image_size < 16 || s.image_size > 4096))) fail(400, 'invalid_settings', 'Invalid training settings.');
    const allowed = ['run_id', 'source_task_id', 'manifest_sha256', 'profile_id', 'settings', 'grant'];
    if (Object.keys(body).some(key => !allowed.includes(key)) || Object.keys(s).some(key => !['num_iterations','image_size'].includes(key))) fail(400, 'invalid_input', 'Unexpected training fields.');
    return hash(canonical({run_id: body.run_id, source_task_id: body.source_task_id, manifest_sha256: body.manifest_sha256, profile_id: body.profile_id, settings: s}));
}
function verifyGrant(grant, body, owner, config, replay = false) {
    if (!grant || grant.version !== 1 || typeof grant.key_id !== 'string' || !grant.payload || typeof grant.signature !== 'string') fail(403, 'invalid_grant', 'Training authorization is invalid.');
    const p = grant.payload;
    const issuerKeys = config.grantKeys[p.issuer];
    const secret = issuerKeys && issuerKeys[grant.key_id];
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) fail(403, 'invalid_grant', 'Training authorization is invalid.');
    const signature = crypto.createHmac('sha256', secret).update(canonical({version:1,key_id:grant.key_id,payload:p})).digest('base64url');
    if (!same(signature, grant.signature) || p.audience !== config.instanceId || p.run_id !== body.run_id || p.source_task_id !== body.source_task_id || p.manifest_sha256 !== body.manifest_sha256 || !p.owner || p.owner.username !== owner.username || p.owner.tenant !== owner.tenant || canonical(p.settings) !== canonical(body.settings)) fail(403, 'invalid_grant', 'Training authorization does not match this request.');
    const now = Math.floor(Date.now()/1000);
    if (!Number.isInteger(p.issued_at) || !Number.isInteger(p.expires_at) || p.expires_at - p.issued_at > config.grantMaxAgeSeconds || p.expires_at <= p.issued_at || (!replay && (p.expires_at < now || p.issued_at > now + 30))) fail(403, 'expired_grant', 'Training authorization has expired.');
    return hash(canonical(grant));
}
module.exports = {SplatError, fail, canonical, hash, same, validateRequest, verifyGrant};
