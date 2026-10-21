'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { translateImportPathForNode } = require('./tapisRegistration');
const logger = require('./logger');
const {
    classifySubmitError,
    logHandoffEvent,
    safeNodeEndpoint
} = require('./observability');

const TASK_SUBMIT_TIMEOUT_MS = 300000;

const submitPendingTask = async (pending, node) => {
    const startedAt = process.hrtime.bigint();
    const taskId = pending && pending.taskId || undefined;
    const tapisJobId = pending && pending.tapisJobId || undefined;
    const nodeEndpoint = node && typeof node.hostname === 'function' && typeof node.port === 'function' ?
        safeNodeEndpoint(node.hostname(), node.port()) : undefined;
    let pathMode;
    let httpStatus;
    let finished = false;

    const eventFields = () => ({
        task_id: taskId,
        tapis_job_id: tapisJobId,
        node: nodeEndpoint,
        path_mode: pathMode,
        timeout_ms: TASK_SUBMIT_TIMEOUT_MS,
        elapsed_ms: Math.max(0, Math.round(Number(process.hrtime.bigint() - startedAt) / 1000000)),
        http_status: httpStatus
    });
    const finish = fields => {
        if (finished) return;
        finished = true;
        logHandoffEvent(logger, 'task_submit_finished', Object.assign(eventFields(), fields));
    };

    logHandoffEvent(logger, 'task_submit_started', eventFields());

    try {
        if (!pending || !node) throw new Error('Pending task and node are required');

        const form = new FormData();
        form.append('name', `tapis_job_${pending.jobId || pending.tapisJobId}`);
        form.append('options', JSON.stringify(Array.isArray(pending.taskOptions) ? pending.taskOptions : []));

        let usedImportPath = false;
        if (pending.pathImport){
            const translated = translateImportPathForNode(pending.pathImport, node.hostname());
            if (translated){
                form.append('import_path', translated);
                usedImportPath = true;
            }
        }

        pathMode = usedImportPath ? 'shared_import_path' : 'uploaded_files';
        if (!usedImportPath && pending.fileNames && pending.tmpPath){
            for (const fileName of pending.fileNames){
                const filePath = path.join(pending.tmpPath, fileName);
                if (!fs.existsSync(filePath)) {
                    const error = new Error(`Pending upload file is missing: ${fileName}`);
                    error.odxErrorClass = 'filesystem_error';
                    throw error;
                }
                form.append('images', fs.createReadStream(filePath));
            }
        }

        if (!usedImportPath && (!pending.fileNames || pending.fileNames.length === 0)){
            const error = new Error('Pending task has no import path or uploaded images');
            error.odxErrorClass = 'validation_error';
            throw error;
        }

        const taskHeaderId = pending.taskId || null;
        const response = await axios.post(node.urlFor('/task/new'), form, {
            headers: Object.assign({}, form.getHeaders(), taskHeaderId ? { 'set-uuid': taskHeaderId } : {}),
            timeout: TASK_SUBMIT_TIMEOUT_MS,
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });
        httpStatus = response && response.status;
        const responseUuid = response && response.data && response.data.uuid;
        if (!responseUuid) {
            const error = new Error('NodeODX response missing task UUID');
            error.odxErrorClass = 'validation_error';
            throw error;
        }
        if (taskHeaderId && responseUuid !== taskHeaderId) {
            const error = new Error(`NodeODX returned mismatched UUID ${responseUuid}`);
            error.odxErrorClass = 'validation_error';
            throw error;
        }

        finish({ outcome: 'success' });
        return { taskUuid: taskHeaderId || responseUuid, usedImportPath };
    } catch (error) {
        httpStatus = httpStatus || error && error.response && error.response.status;
        finish({
            outcome: 'failure',
            error_class: classifySubmitError(error, 'validation_error')
        });
        throw error;
    }
};

module.exports = { submitPendingTask, TASK_SUBMIT_TIMEOUT_MS };
