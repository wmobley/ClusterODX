'use strict';

const path = require('path');
const config = require('../config');

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
        metadata: {
            childIndex: payload.childIndex !== undefined ? payload.childIndex : null,
            role: payload.role || null,
            hostId: payload.hostId !== undefined ? payload.hostId : null,
            workerId: payload.workerId !== undefined ? payload.workerId : null,
            jobIndex: payload.jobIndex !== undefined ? payload.jobIndex : null,
            jobCount: payload.jobCount !== undefined ? payload.jobCount : null,
            replicasPerJob: payload.replicasPerJob !== undefined ? payload.replicasPerJob : null,
            registrationUuid: typeof payload.registrationUuid === 'string' ? payload.registrationUuid : null,
            tapisJobUuid: typeof payload.tapisJobUuid === 'string' ? payload.tapisJobUuid : null
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

module.exports = {
    extractBearerToken,
    normalizeRegistration,
    translateImportPathForNode
};
