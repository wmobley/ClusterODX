'use strict';
const http = require('http');
const https = require('https');
const {fail} = require('./splatAuth');

// Same trust model as NodeODX: the worker registers its own host:port through the
// authenticated webhook and ClusterODX connects to it. Destination checks are limited
// to the URL shape; the registration secret and job binding are the trust boundary.
function parseWorkerUrl(raw) {
    let target;
    try { target = new URL(raw); } catch (_) { fail(403, 'worker_destination', 'Worker destination is not allowed.'); }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/' || !target.hostname) fail(403, 'worker_destination', 'Worker destination is not allowed.');
    return target;
}
async function workerRequest(raw, pathname, token, method = 'GET', body) {
    const target = parseWorkerUrl(raw);
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        // Node's http client never follows redirects; any non-2xx (including 3xx) is a failure.
        const request = (target.protocol === 'https:' ? https : http).request({
            protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: pathname, method,
            headers: {Authorization: `Bearer ${token}`, ...(data ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)} : {})},
            timeout: 15000
        }, response => {
            const chunks = []; let bytes = 0;
            response.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) response.destroy(new Error('Worker response too large')); else chunks.push(chunk); });
            response.on('error', reject);
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error('Worker request rejected'));
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(new Error('Invalid worker response')); }
            });
        });
        request.on('timeout', () => request.destroy(new Error('Worker request timed out')));
        request.on('error', reject);
        if (data) request.write(data);
        request.end();
    });
}
module.exports = {parseWorkerUrl, workerRequest};
