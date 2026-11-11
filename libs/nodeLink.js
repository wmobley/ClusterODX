'use strict';

const { safeNodeEndpoint } = require('./observability');

// URL an administrator opens to reach a worker's own web UI. It carries the
// worker's token because NodeODX requires it, so it is only ever produced for an
// authenticated admin request and is never part of any list response or log.
const nodeUrlWithToken = node => {
    if (!node || typeof node.hostname !== 'function' || typeof node.port !== 'function') return null;
    const hostname = node.hostname();
    const port = Number(node.port());
    if (!safeNodeEndpoint(hostname, port)) return null;
    const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
    try {
        const url = new URL(`${port === 443 ? 'https' : 'http'}://${host}:${port}/`);
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
        const token = typeof node.getToken === 'function' ? node.getToken() : '';
        if (token) url.searchParams.set('token', token);
        return url.href;
    } catch (_) { return null; }
};

module.exports = { nodeUrlWithToken };
