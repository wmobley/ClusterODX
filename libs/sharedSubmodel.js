"use strict";
const nodes = require('./nodes');
const routes = require('./routetable');
const { translateImportPathForNode } = require('./tapisRegistration');
const fields = ['shared_submodel_version', 'seed_path', 'parent_task_uuid', 'attempt_id', 'shared_source_job_uuid'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const job = node => node && node.nodeData && node.nodeData.tapisJobUuid;
const eligible = (node, source) => !!(source && job(node) === source && node.isOnline() && !node.isLocked() && node.getInfo().capabilities && node.getInfo().capabilities.shared_submodel_v1 === true);
async function select(source) {
    await nodes.updateInfo();
    return nodes.filter(node => eligible(node, source)).sort((a, b) => b.availableSlots() - a.availableSlots())[0] || null;
}
async function authorize(params, token, taskId) {
    if (params.shared_source_job_uuid !== undefined) throw new Error('Client supplied shared source allocation is forbidden');
    if (params.shared_submodel_version === undefined) return null;
    if (params.shared_submodel_version !== '1' || !uuid.test(params.parent_task_uuid || '') || !uuid.test(params.attempt_id || '') || params.attempt_id !== taskId || !params.pathImport || !params.seed_path || params.fileNames.length || params.skipPostProcessing !== 'true') throw new Error('Invalid shared submodel request');
    let outputs;
    try { outputs = JSON.parse(params.outputs); } catch (_) {}
    if (!Array.isArray(outputs) || outputs.some(value => typeof value !== 'string')) throw new Error('Invalid shared submodel outputs');
    const parent = await routes.lookup(params.parent_task_uuid);
    if (!token || !parent || parent.token !== token || !job(parent.node)) throw new Error('Shared submodel parent ownership cannot be verified');
    params.shared_source_job_uuid = job(parent.node);
    return params.shared_source_job_uuid;
}
function forwarded(params, node) {
    const result = {};
    for (const field of fields) if (params[field] !== undefined) result[field] = field === 'seed_path' ? translateImportPathForNode(params[field], node.hostname()) : params[field];
    return result;
}
async function capability(token) {
    if (!token) return false;
    const owned = await routes.findByToken(token);
    const jobs = new Set(Object.values(owned).map(route => job(route.node)).filter(Boolean));
    return nodes.filter(node => jobs.has(job(node)) && eligible(node, job(node))).length > 0;
}
module.exports = {fields, job, eligible, select, authorize, forwarded, capability};
