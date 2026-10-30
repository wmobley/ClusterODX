'use strict';
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');
const {fail} = require('./splatAuth');

function ipv4(value) {
    if (net.isIP(value) !== 4) return null;
    return value.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}
function inCidr(address, cidr) {
    const [base, bitsText] = cidr.split('/');
    const bits = bitsText === undefined ? (net.isIP(base) === 4 ? 32 : 128) : Number(bitsText);
    if (net.isIP(address) === 6) return bits === 128 && address.toLowerCase() === base.toLowerCase();
    const value = ipv4(address), root = ipv4(base);
    if (value === null || root === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((root & mask) >>> 0);
}
// Exact names, or "*.suffix" for exactly one extra leading label (a compute node under a cluster
// domain). The resolved-address CIDR check below stays the authoritative guard.
function hostAllowed(hostname, patterns) {
    const host = hostname.toLowerCase();
    return patterns.some(pattern => {
        pattern = String(pattern).toLowerCase();
        if (!pattern.startsWith('*.')) return pattern === host;
        const suffix = pattern.slice(1);
        const label = host.slice(0, -suffix.length);
        return suffix.length > 1 && !suffix.includes('*') && host.endsWith(suffix) && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);
    });
}
async function targetFor(raw, policy) {
    let target;
    try { target = new URL(raw); } catch (_) { fail(403, 'worker_destination', 'Worker destination is not allowed.'); }
    const scheme = target.protocol.slice(0,-1);
    const port = Number(target.port || (scheme === 'https' ? 443 : 80));
    if (target.username || target.password || target.search || target.hash || target.pathname !== '/' || !policy.schemes.includes(scheme) || !hostAllowed(target.hostname, policy.hosts) || !policy.ports.map(Number).includes(port)) fail(403, 'worker_destination', 'Worker destination is not allowed.');
    const addresses = await dns.lookup(target.hostname, {all:true});
    if (!addresses.length || addresses.some(entry => !policy.cidrs.some(cidr => inCidr(entry.address,cidr)))) fail(403, 'worker_destination', 'Worker address is not allowed.');
    return {target, address: addresses[0], port};
}
async function workerRequest(raw, pathname, token, policy, method='GET', body) {
    const {target,address,port} = await targetFor(raw,policy);
    return new Promise((resolve,reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const request = (target.protocol === 'https:' ? https : http).request({
            protocol:target.protocol, hostname:target.hostname, port, path:pathname, method,
            // Resolve/check every connection, then pin the validated address to prevent rebinding.
            lookup: (_host,_opts,callback) => callback(null,address.address,address.family),
            headers: {Authorization:`Bearer ${token}`, ...(data ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)} : {})},
            timeout:15000
        }, response => {
            const chunks=[]; let bytes=0;
            response.on('data',chunk => { bytes+=chunk.length; if(bytes>1024*1024) response.destroy(new Error('Worker response too large')); else chunks.push(chunk); });
            response.on('error',reject);
            response.on('end',() => {
                if(response.statusCode < 200 || response.statusCode >= 300) return reject(new Error('Worker request rejected'));
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch(_){ reject(new Error('Invalid worker response')); }
            });
        });
        request.on('timeout',() => request.destroy(new Error('Worker request timed out')));
        request.on('error',reject);
        if(data) request.write(data);
        request.end();
    });
}
module.exports={inCidr,hostAllowed,targetFor,workerRequest};
