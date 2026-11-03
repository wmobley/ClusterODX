'use strict';

// Decode the identity claims of a Tapis JWT without verifying it. Callers use
// this only for logging and for matching records that were created by a token
// Tapis has already accepted; it is never an authentication check on its own.
const extractUserFromToken = token => {
    if (!token || typeof token !== 'string') return null;

    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const username = claims['tapis/username'];
        const tenantId = claims['tapis/tenant_id'];
        if (!username || !tenantId) return null;

        return {
            username: String(username),
            tenantId: String(tenantId),
            fullUser: `${username}@${tenantId}`,
            expiresAt: Number.isFinite(Number(claims.exp)) ? Number(claims.exp) * 1000 : null
        };
    } catch (_error) {
        return null;
    }
};

// Short label for log lines: "user@tenant" or "unknown".
const describeTokenUser = token => {
    const identity = extractUserFromToken(token);
    return identity ? identity.fullUser : 'unknown';
};

module.exports = { extractUserFromToken, describeTokenUser };
