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

// True when the Tapis job that launched a node belongs to `identity`. Both the
// owner and the tenant must be recorded on the node and match; a node with no
// recorded owner belongs to nobody, so ownership can never be bypassed by
// omission. `identity` is the result of extractUserFromToken (or null).
const nodeOwnedBy = (nodeData, identity) => {
    if (!nodeData || !identity) return false;
    const owner = String(nodeData.tapisJobOwner || '').trim().toLowerCase();
    const ownerTenant = String(nodeData.tapisJobOwnerTenant || '').trim().toLowerCase();
    if (!owner || !ownerTenant) return false;
    const username = String(identity.username || '').trim().toLowerCase();
    const tenantId = String(identity.tenantId || '').trim().toLowerCase();
    if (!username || !tenantId) return false;
    const ownerMatches = owner.includes('@') ? owner === `${username}@${tenantId}` : owner === username;
    return ownerMatches && ownerTenant === tenantId;
};

// Advisory "user@tenant" label for display: the token claims win, then an
// explicit { owner, tenant } record, else null. Never used for authorization.
const ownerLabel = (token, fallback = null) => {
    const identity = extractUserFromToken(token);
    if (identity) return identity.fullUser;
    const owner = fallback && typeof fallback.owner === 'string' ? fallback.owner.trim() : '';
    if (!owner) return null;
    const tenant = fallback && typeof fallback.tenant === 'string' ? fallback.tenant.trim() : '';
    return owner.includes('@') || !tenant ? owner : `${owner}@${tenant}`;
};

module.exports = { extractUserFromToken, describeTokenUser, nodeOwnedBy, ownerLabel };
