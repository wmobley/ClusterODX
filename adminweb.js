/**
 *  ClusterODX - A reverse proxy, load balancer and task tracker for NodeODX
 *  Copyright (C) 2018-present WebODM Contributors
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as
 *  published by the Free Software Foundation, either version 3 of the
 *  License, or (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
const logger = require("./libs/logger");
const express = require("express");
const basicAuth = require("express-basic-auth");
const nodes = require("./libs/nodes");
const package_info = require("./package_info");
const netutils = require("./libs/netutils");
const asrProvider = require("./libs/asrProvider");
const config = require("./config");
const tasktable = require("./libs/tasktable");
const routetable = require("./libs/routetable");
const { listTasks } = require("./libs/adminTasks");
const utils = require("./libs/utils");
const { extractBearerToken, normalizeRegistration } = require("./libs/tapisRegistration");
const { submitPendingTask } = require("./libs/tapisWorker");
const { classifySubmitError, logHandoffEvent, safeNodeEndpoint } = require("./libs/observability");
const crypto = require("crypto");
const { isIP } = require("net");

const safeStringEqual = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const decodeJwtPayload = (token) => {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const claims = JSON.parse(payload);
    return claims && typeof claims === 'object' ? claims : null;
  } catch (_error) {
    return null;
  }
};

const tapisClaim = (claims, name, fallback) => {
  if (!claims) return null;
  return claims[`tapis/${name}`] || claims[name] || claims[fallback] || null;
};

const pendingTaskBelongsToIdentity = (pending, identity) => {
  if (!pending || !identity) return false;
  const owner = pending.tapisJobOwner || pending.nodeUser;
  if (!owner) return false;

  const normalizedOwner = String(owner).trim().toLowerCase();
  const username = String(identity.username || '').trim().toLowerCase();
  const tenant = String(identity.tenantId || '').trim().toLowerCase();
  const ownerTenant = String(pending.tapisJobOwnerTenant || '').trim().toLowerCase();
  if (!username || !tenant || !ownerTenant) return false;
  const ownerMatches = normalizedOwner.includes('@')
    ? normalizedOwner === `${username}@${tenant}`
    : normalizedOwner === username;

  return ownerMatches && (!ownerTenant || ownerTenant === tenant);
};

module.exports = {
  create: function (options) {
    logger.info("Starting admin web interface on " + options.port);

    const app = express();
    app.use(express.json());

    const rejectForeignOrigin = (req, res, next) => {
      const origin = req.get("origin");
      const stateChanging = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
      if (!stateChanging || !origin) return next();
      try {
        const originUrl = new URL(origin);
        if (originUrl.host !== req.get("host")) {
          return res.status(403).json({ error: "Cross-origin request rejected" });
        }
      } catch (_error) {
        return res.status(403).json({ error: "Cross-origin request rejected" });
      }
      return next();
    };
    app.use(rejectForeignOrigin);

    // Tapis workers cannot use the admin Basic Auth credentials. This endpoint
    // is therefore authenticated with the request-scoped Tapis token (or an
    // explicitly configured registration secret) and is registered before the
    // admin-only middleware below.
    app.post("/webhook/register-node", async (req, res) => {
      logHandoffEvent(logger, "webhook_received");
      let registration;
      try {
        registration = normalizeRegistration(req.body);
      } catch (error) {
        logHandoffEvent(logger, "webhook_rejected", { outcome: "rejected", error_class: "validation_error" });
        return res.status(400).json({ error: error.message });
      }

      const registrationFields = () => ({
        node: safeNodeEndpoint(registration.hostname, registration.port),
        tapis_job_id: registration.tapisJobUuid,
        task_id: registration.registrationUuid
      });

      const provider = asrProvider.get();
      if (!provider || typeof provider.getDriverName !== "function" || provider.getDriverName() !== "tapis") {
        logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
          outcome: "rejected",
          error_class: "not_enabled"
        }));
        return res.status(404).json({ error: "Tapis worker registration is not enabled" });
      }

      const bearerToken = extractBearerToken(req.headers);
      const effectiveTapisToken = bearerToken || registration.tapisToken;
      let authenticated = false;
      let authMethod = null;
      let validatedIdentity = null;

      if (effectiveTapisToken) {
        try {
          await provider.validateToken(effectiveTapisToken);
          authenticated = true;
          authMethod = "tapis-jwt";
          const claims = decodeJwtPayload(effectiveTapisToken);
          const username = claims && claims['tapis/username'];
          const tenantId = claims && claims['tapis/tenant_id'];
          if (!username || !tenantId) throw new Error('Canonical Tapis identity claims are missing');
          validatedIdentity = {
            username: String(username),
            tenantId: String(tenantId)
          };
        } catch (error) {
          logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
            outcome: "rejected",
            error_class: "auth_error"
          }));
          return res.status(401).json({ error: "Tapis token validation failed" });
        }
      } else {
        const configuredSecret = config.registration_secret ||
          (typeof provider.getConfig === "function" ? provider.getConfig('worker.registrationSecret', '') : '');
        if (!configuredSecret || !registration.registrationSecret) {
          logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
            outcome: "rejected",
            error_class: "auth_error"
          }));
          return res.status(401).json({ error: "Tapis token or registration secret required" });
        }
        const expected = Buffer.from(String(configuredSecret));
        const supplied = Buffer.from(registration.registrationSecret);
        if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) {
          authenticated = true;
          authMethod = "registration-secret";
        }
      }

      if (!authenticated) {
        logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
          outcome: "rejected",
          error_class: "auth_error"
        }));
        return res.status(401).json({ error: "Tapis token or registration secret required" });
      }

      const sharedSecretPrimaryEnabled = typeof provider.getConfig === 'function' &&
        provider.getConfig('worker.allowSharedSecretPrimaryRegistration', false) === true;
      if (authMethod === 'registration-secret' && sharedSecretPrimaryEnabled && registration.role === 'worker') {
        const job = registration.tapisJobUuid && typeof provider.findRegistrationJob === 'function' &&
          provider.findRegistrationJob(registration.tapisJobUuid);
        if (!job || !job.tapisJobOwner || !job.tapisJobOwnerTenant) {
          return res.status(403).json({ error: 'Known Tapis job ownership required for secret worker registration' });
        }
        validatedIdentity = { username: job.tapisJobOwner, tenantId: job.tapisJobOwnerTenant };
      }

      // Preserve the original ClusterODM contract for explicitly marked
      // worker registrations. These nodes are authenticated, ordinary
      // cluster nodes and must not claim, consume, or submit a pending Tapis
      // task. Keep task-bound handoff behavior for every other role.
      if (registration.role === 'worker') {
        let node = nodes.find(existing =>
          existing.hostname() === registration.hostname && existing.port() === registration.port);
        if (node && node.isAutoSpawned()) {
          logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
            outcome: "rejected",
            error_class: "validation_error"
          }));
          return res.status(409).json({ error: "Node is already managed by a Tapis task" });
        }

        if (node) {
          const recordedOwner = node.nodeData.tapisJobOwner || node.nodeData.tapisUser || node.nodeData.tapisUsername;
          const recordedTenant = node.nodeData.tapisJobOwnerTenant;
          const ownerMatches = authMethod !== "tapis-jwt" || !recordedOwner ||
            (validatedIdentity && recordedTenant && String(recordedOwner) === validatedIdentity.username &&
             String(recordedTenant).toLowerCase() === String(validatedIdentity.tenantId || '').toLowerCase());
          if (!ownerMatches) {
            logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
              outcome: "rejected",
              error_class: "auth_error"
            }));
            return res.status(403).json({ error: "Tapis token does not own the registered node" });
          }

          node.updateInfo();
          logHandoffEvent(logger, "webhook_completed", Object.assign(registrationFields(), {
            outcome: "success"
          }));
          logger.info(`Confirmed legacy worker ${registration.hostname}:${registration.port}`);
          return res.json({
            success: true,
            message: "Node already registered",
            nodeId: nodes.all().indexOf(node) + 1,
            authMethod,
            registrationMode: node.nodeData.registrationMode || "legacy-worker"
          });
        }

        node = nodes.addUnique(registration.hostname, registration.port, registration.nodeToken);
        if (!node) {
          logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
            outcome: "rejected",
            error_class: "validation_error"
          }));
          return res.status(409).json({ error: "Node already exists or registration is invalid" });
        }

        const legacyMetadata = Object.assign({}, registration.metadata, {
          registrationMode: "legacy-worker",
          nodeReady: registration.nodeReady,
          tapisJobOwner: validatedIdentity ? validatedIdentity.username : null,
          tapisJobOwnerTenant: validatedIdentity ? validatedIdentity.tenantId : null
        });
        Object.assign(node.nodeData, legacyMetadata);
        await nodes.saveToDisk();
        node.updateInfo();

        logHandoffEvent(logger, "webhook_completed", Object.assign(registrationFields(), {
          outcome: "success"
        }));
        logger.info(`Registered legacy worker ${registration.hostname}:${registration.port}`);
        return res.json({
          success: true,
          message: "Node registered successfully",
          nodeId: nodes.all().indexOf(node) + 1,
          authMethod,
          registrationMode: "legacy-worker"
        });
      }

      if (authMethod !== 'tapis-jwt' && !sharedSecretPrimaryEnabled) {
        logHandoffEvent(logger, 'webhook_rejected', Object.assign(registrationFields(), {
          outcome: 'rejected',
          error_class: 'auth_error'
        }));
        return res.status(401).json({ error: 'Tapis JWT required for task-bound registration' });
      }

      let pending = provider.findPendingTask(registration.tapisJobUuid) ||
                    (authMethod === 'tapis-jwt' && provider.findPendingTask(registration.registrationUuid));
      if (authMethod === 'registration-secret' && !pending && registration.tapisJobUuid) {
        const completedNode = nodes.find(node => node.getTapisJobId &&
          node.getTapisJobId() === registration.tapisJobUuid &&
          node.hostname() === registration.hostname && node.port() === registration.port &&
          node.nodeData.tapisJobOwner && node.nodeData.tapisJobOwnerTenant);
        if (completedNode) {
          return res.json({ success: true, message: 'Tapis worker registration already completed',
            nodeId: nodes.all().indexOf(completedNode) + 1,
            tapisJobUuid: registration.tapisJobUuid, authMethod });
        }
      }
      if (authMethod === 'registration-secret' && (!pending ||
          pending.tapisJobId !== registration.tapisJobUuid ||
          !pending.tapisJobOwner || !pending.tapisJobOwnerTenant)) {
        return res.status(403).json({ error: 'Exact pending Tapis job and ownership required for secret registration' });
      }
      let pendingMatchMode = pending ? 'identifier' : null;

      // The UUIDs are correlation metadata, not the ownership boundary. The
      // old ClusterODM path matched pending work to the authenticated Tapis
      // user when the UUID sent by the worker differed from the UUID recorded
      // at submission time. Preserve that behavior, but reject ambiguity so
      // one user's concurrent jobs cannot claim each other accidentally.
      if (!pending && authMethod === 'tapis-jwt' && validatedIdentity &&
          typeof provider.findPendingTaskByUser === 'function') {
        const ownerMatch = provider.findPendingTaskByUser(validatedIdentity);
        if (ownerMatch.count > 1) {
          logHandoffEvent(logger, 'webhook_rejected', Object.assign(registrationFields(), {
            outcome: 'rejected',
            error_class: 'ambiguous_owner_match'
          }));
          return res.status(409).json({
            error: 'Multiple pending Tapis tasks belong to this user; registration correlation is required'
          });
        }
        if (ownerMatch.task) {
          pending = ownerMatch.task;
          pendingMatchMode = 'user';
          logger.info(`Matched pending Tapis task ${pending.taskId} to authenticated user ${validatedIdentity.username}@${validatedIdentity.tenantId}`);
        }
      }
      if (!pending) {
        const existingNode = registration.tapisJobUuid && nodes.find(node =>
          node.getTapisJobId && node.getTapisJobId() === registration.tapisJobUuid);
        const existingRoute = registration.registrationUuid && await routetable.lookup(registration.registrationUuid);
        if (existingNode || existingRoute) {
          return res.json({
            success: true,
            message: "Tapis worker registration already completed",
            nodeId: existingNode ? nodes.all().indexOf(existingNode) + 1 : null,
            tapisJobUuid: registration.tapisJobUuid || null,
            taskUuid: registration.registrationUuid || null,
            authMethod
          });
        }
        logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
          outcome: "rejected",
          error_class: "not_found"
        }));
        return res.status(404).json({ error: "No pending Tapis task matches this registration" });
      }

      // A valid Tapis token may claim only work owned by the same Tapis user.
      // Exact token equality is retained only for old in-memory pending records
      // that predate owner metadata.
      const ownerMatches = pendingTaskBelongsToIdentity(pending, validatedIdentity);
      const tokenMatches = effectiveTapisToken && pending.token && safeStringEqual(effectiveTapisToken, pending.token);
      if (effectiveTapisToken && pending.tapisJobOwner && !ownerMatches) {
        logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
          task_id: pending.taskId,
          tapis_job_id: pending.tapisJobId,
          outcome: "rejected",
          error_class: "auth_error"
        }));
        return res.status(403).json({ error: "Tapis token does not own the pending task" });
      }
      if (effectiveTapisToken && !pending.tapisJobOwner && pending.token && !tokenMatches) {
        logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
          task_id: pending.taskId,
          tapis_job_id: pending.tapisJobId,
          outcome: "rejected",
          error_class: "auth_error"
        }));
        return res.status(403).json({ error: "Tapis token does not own the pending task" });
      }
      if (effectiveTapisToken && !pending.tapisJobOwner && !pending.token) {
        logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
          task_id: pending.taskId,
          tapis_job_id: pending.tapisJobId,
          outcome: "rejected",
          error_class: "auth_error"
        }));
        return res.status(403).json({ error: "Pending task ownership is not configured" });
      }

      let node = nodes.find(existing => existing.hostname() === registration.hostname && existing.port() === registration.port);
      const nodeExisted = !!node;
      const existingTapisJobId = node && node.getTapisJobId && node.getTapisJobId();
      if (existingTapisJobId && existingTapisJobId !== pending.tapisJobId) {
        logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
          task_id: pending.taskId,
          tapis_job_id: pending.tapisJobId,
          outcome: "rejected",
          error_class: "validation_error"
        }));
        return res.status(409).json({ error: "Node is already assigned to another Tapis task" });
      }

      if (typeof provider.claimPendingTask === 'function' && !provider.claimPendingTask(pending)) {
        logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
          task_id: pending.taskId,
          tapis_job_id: pending.tapisJobId,
          outcome: "rejected",
          error_class: "conflict"
        }));
        return res.status(409).json({ error: "Tapis task registration is already in progress" });
      }

      if (!node) node = nodes.addUnique(registration.hostname, registration.port, registration.nodeToken);
      if (!node) {
        if (typeof provider.releasePendingTask === 'function') provider.releasePendingTask(pending);
        logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
          task_id: pending.taskId,
          tapis_job_id: pending.tapisJobId,
          outcome: "rejected",
          error_class: "validation_error"
        }));
        return res.status(409).json({ error: "Node already exists or registration is invalid" });
      }

      node.setTapisJob(pending.tapisJobId);
      const registrationMetadata = Object.assign({}, pending.registrationMeta || {}, registration.metadata);
      delete registrationMetadata.tapisJobOwner;
      delete registrationMetadata.tapisJobOwnerTenant;
      Object.assign(node.nodeData, registrationMetadata, {
        nodeReady: registration.nodeReady,
        tapisJobOwner: pending.tapisJobOwner || (validatedIdentity && validatedIdentity.username),
        tapisJobOwnerTenant: pending.tapisJobOwnerTenant || (validatedIdentity && validatedIdentity.tenantId)
      });

      let nodeWasAdded = false;
      let taskSubmitted = false;
      try {
        nodeWasAdded = !nodeExisted;
        await nodes.saveToDisk();
        await submitPendingTask(pending, node);
        taskSubmitted = true;
        await routetable.add(pending.taskId, node, pending.token);
        await tasktable.delete(pending.taskId);
        provider.consumePendingTask(pending.taskId);
        if (pending.tmpPath) utils.rmdir(pending.tmpPath);

        logHandoffEvent(logger, "webhook_completed", {
          task_id: pending.taskId,
          tapis_job_id: pending.tapisJobId,
          node: safeNodeEndpoint(registration.hostname, registration.port),
          outcome: "success"
        });
        logger.info(`Registered Tapis worker ${registration.hostname}:${registration.port} and routed task ${pending.taskId}`);
        return res.json({
          success: true,
          message: "Tapis worker registered and task submitted",
          nodeId: nodes.all().indexOf(node) + 1,
          tapisJobUuid: pending.tapisJobId,
          taskUuid: pending.taskId,
          authMethod,
          registrationMode: pendingMatchMode === 'user' ? 'user-bound' : 'identifier-bound'
        });
      } catch (error) {
        if (typeof provider.releasePendingTask === 'function') provider.releasePendingTask(pending);
        if (nodeWasAdded && !taskSubmitted) {
          nodes.remove(node);
          await nodes.saveToDisk();
        }
        logHandoffEvent(logger, "webhook_failed", {
          task_id: pending.taskId,
          tapis_job_id: pending.tapisJobId,
          node: safeNodeEndpoint(registration.hostname, registration.port),
          outcome: "failure",
          error_class: classifySubmitError(error, "handoff_error")
        });
        return res.status(502).json({ error: "Worker registered, but task submission failed; retry registration" });
      }
    });

    // NodeODX calls this endpoint during shutdown. It is intentionally outside
    // the admin middleware because workers authenticate with their Tapis token,
    // not with the browser/CLI admin credentials.
    app.post("/webhook/deregister-node", async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const provider = options.tapisProvider || asrProvider.get();
      const bearerToken = extractBearerToken(req.headers);
      const bodyToken = typeof body.tapisToken === 'string' ? body.tapisToken : null;
      const effectiveTapisToken = bearerToken || bodyToken;
      let authMethod = null;
      let identity = null;

      if (effectiveTapisToken) {
        if (!provider || typeof provider.validateToken !== 'function') {
          return res.status(503).json({ error: 'Tapis authentication is unavailable' });
        }

        try {
          await provider.validateToken(effectiveTapisToken);
        } catch (error) {
          if (error && error.response && [401, 403].includes(error.response.status)) {
            return res.status(401).json({ error: 'Tapis JWT is invalid or expired' });
          }
          return res.status(503).json({ error: 'Tapis authentication is unavailable' });
        }

        const claims = decodeJwtPayload(effectiveTapisToken);
        const username = claims && claims['tapis/username'];
        const tenantId = claims && claims['tapis/tenant_id'];
        if (!username || !tenantId) return res.status(401).json({ error: 'Tapis JWT identity is missing' });

        identity = {
          username: String(username),
          tenantId: tenantId ? String(tenantId) : null
        };
        authMethod = 'tapis-jwt';
      } else {
        const configuredSecret = config.registration_secret || options.registrationSecret ||
          (provider && typeof provider.getConfig === 'function'
            ? provider.getConfig('worker.registrationSecret', '')
            : '');
        const suppliedSecret = typeof body.registrationSecret === 'string' ? body.registrationSecret : '';
        if (!configuredSecret || !suppliedSecret || !safeStringEqual(String(configuredSecret), suppliedSecret)) {
          return res.status(401).json({ error: 'Tapis token or registration secret required' });
        }
        authMethod = 'registration-secret';
      }

      const hasNodeId = body.nodeId !== undefined && body.nodeId !== null && body.nodeId !== '';
      let node = null;
      if (hasNodeId) {
        const nodeId = Number(body.nodeId);
        if (!Number.isInteger(nodeId) || nodeId < 1) {
          return res.status(400).json({ error: 'Invalid nodeId' });
        }
        node = nodes.nth(nodeId);
      } else if (typeof body.registrationUuid === 'string' && body.registrationUuid.trim()) {
        const registrationUuid = body.registrationUuid.trim();
        node = nodes.find(existing => existing.nodeData.registrationUuid === registrationUuid);
      }

      if (!node) {
        const hostname = typeof body.hostname === 'string' ? body.hostname.trim() : '';
        const port = Number(body.port);
        if (hostname || body.port !== undefined) {
          if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
            return res.status(400).json({ error: 'Valid hostname and port or nodeId required' });
          }
          node = nodes.find(existing => existing.hostname() === hostname && existing.port() === port);
        }
      }

      if (!hasNodeId && !(typeof body.registrationUuid === 'string' && body.registrationUuid.trim()) &&
          !(typeof body.hostname === 'string' && body.hostname.trim()) && body.port === undefined) {
        return res.status(400).json({ error: 'nodeId, registrationUuid, or hostname and port required' });
      }
      if (!node) return res.status(404).json({ error: 'Node not found' });

      if (authMethod === 'tapis-jwt') {
        const owner = node.nodeData.tapisJobOwner || node.nodeData.tapisUser || node.nodeData.tapisUsername;
        if (!owner) return res.status(403).json({ error: 'Node ownership is not configured' });

        const ownerValue = String(owner).trim().toLowerCase();
        const username = identity.username.toLowerCase();
        const tenantId = identity.tenantId && identity.tenantId.toLowerCase();
        const fullPrincipal = tenantId ? `${username}@${tenantId}` : null;
        const ownerTenant = node.nodeData.tapisJobOwnerTenant && String(node.nodeData.tapisJobOwnerTenant).toLowerCase();
        if ((ownerValue.includes('@')
          ? ownerValue !== fullPrincipal
          : ownerValue !== username)
          || (ownerTenant && ownerTenant !== tenantId)) {
          return res.status(403).json({ error: 'Tapis token does not own the node' });
        }
      }

      const nodeEndpoint = safeNodeEndpoint(node.hostname(), node.port());
      const wasAutoSpawned = node.isAutoSpawned();
      nodes.remove(node);
      await nodes.saveToDisk();

      if (wasAutoSpawned && provider && typeof provider.destroyNode === 'function') {
        try {
          await provider.destroyNode(node);
        } catch (error) {
          logger.warn(`Cannot destroy Tapis worker ${nodeEndpoint} after deregistration: ${error.message}`);
        }
      }

      logger.info(`Deregistered worker ${nodeEndpoint} via ${authMethod}`);
      return res.json({ success: true, message: 'Node de-registered successfully', authMethod });
    });

    const useTapisJwt = options.useTapisJwt === true;
    const allowedTenants = Array.isArray(options.allowedTenants) ? options.allowedTenants : [];
    const allowedUsers = Array.isArray(options.allowedUsers) ? options.allowedUsers : [];

    const validateTapisAdminToken = async (token) => {
      const provider = options.tapisProvider || asrProvider.get();
      if (!provider || typeof provider.validateToken !== 'function') {
        const error = new Error('Tapis provider is not initialized');
        error.code = 'TAPIS_UNAVAILABLE';
        throw error;
      }

      await provider.validateToken(token);

      const claims = decodeJwtPayload(token);
      if (claims && claims.exp && Number(claims.exp) * 1000 <= Date.now()) {
        const error = new Error('Tapis token is expired');
        error.code = 'TOKEN_INVALID';
        throw error;
      }

      const tenant = tapisClaim(claims, 'tenant_id', 'tenantId');
      const username = tapisClaim(claims, 'username', 'user');
      if (allowedTenants.length && !allowedTenants.includes(tenant)) {
        const error = new Error('Tapis tenant is not allowed');
        error.code = 'ADMIN_FORBIDDEN';
        throw error;
      }
      if (allowedUsers.length && !allowedUsers.includes(username)) {
        const error = new Error('Tapis user is not allowed');
        error.code = 'ADMIN_FORBIDDEN';
        throw error;
      }
    };

    const requireTapisJwt = async (req, res, next) => {
      const token = extractBearerToken(req.headers);
      if (!token) return res.status(401).json({ error: 'Tapis JWT bearer token required' });

      try {
        await validateTapisAdminToken(token);
        return next();
      } catch (error) {
        if (error && error.code === 'ADMIN_FORBIDDEN') {
          return res.status(403).json({ error: 'Tapis identity is not authorized for admin access' });
        }
        if (error && error.code === 'TOKEN_INVALID') {
          return res.status(401).json({ error: 'Tapis JWT is invalid or expired' });
        }
        if (error && error.response && [401, 403].includes(error.response.status)) {
          return res.status(401).json({ error: 'Tapis JWT is invalid or expired' });
        }
        return res.status(503).json({ error: 'Tapis authentication is unavailable' });
      }
    };

    app.use("/r/task/list", (_req, res, next) => {
      res.set("Cache-Control", "no-store");
      next();
    });

    if (useTapisJwt) {
      app.use(express.static("public"));

      app.post('/r/auth/validate', async (req, res) => {
        const token = extractBearerToken(req.headers);
        if (!token) return res.status(401).json({ error: 'Tapis JWT bearer token required' });
        try {
          await validateTapisAdminToken(token);
          res.set('Cache-Control', 'no-store');
          return res.json({ authenticated: true });
        } catch (error) {
          if (error && error.code === 'ADMIN_FORBIDDEN') {
            return res.status(403).json({ error: 'Tapis identity is not authorized for admin access' });
          }
          if (error && error.code === 'TOKEN_INVALID') {
            return res.status(401).json({ error: 'Tapis JWT is invalid or expired' });
          }
          if (error && error.response && [401, 403].includes(error.response.status)) {
            return res.status(401).json({ error: 'Tapis JWT is invalid or expired' });
          }
          return res.status(503).json({ error: 'Tapis authentication is unavailable' });
        }
      });

      app.use('/r', requireTapisJwt);
    } else if (!options.password) {
      logger.warn(`No admin password specified; protected admin web interface is disabled`);
      app.use((_req, res) => {
        res.status(503).json({ error: "Admin authentication is not configured" });
      });
    } else {
      app.use(
        basicAuth({
          users: { admin: options.password },
          challenge: true,
          realm: "ClusterODX",
        })
      );

      app.get("/signout", (req, res) => {
        res.status(401).send('Signed out. <br /> <a href="/">Sign back in</a>');
      });

      app.use(express.static("public"));
    }

    // API
    app.get("/r/info", (req, res) => {
      const { name, version } = package_info;
      res.json({ name, version });
    });

    app.get("/r/node/list", (req, res) => {
      const list = nodes.all();
      res.json(list.map((node) => nodeToJson(node)));
    });

    app.get("/r/task/list", async (_req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        res.json(await listTasks({ tasktable, routetable, provider: asrProvider.get() }));
      } catch (_error) {
        logger.warn('Cannot build admin task list');
        res.status(500).json({ error: 'Unable to load tasks' });
      }
    });

    app.delete("/r/node", async (req, res) => {
      const { number } = req.body;
      if (number) {
        const isSuccess = await netutils.removeAndCleanupNode(nodes.nth(number), asrProvider.get());
        res.status(200).json(isSuccess);
      } else {
        res.status(403).send();
      }
    });

    app.post("/r/node/unlock", (req, res) => {
      const { number } = req.body;
      if (number) {
        const isSuccess = nodes.unlock(nodes.nth(number));
        res.status(200).json(isSuccess);
      } else {
        res.status(403).send();
      }
    });

    app.post("/r/node/lock", (req, res) => {
      const { number } = req.body;
      if (number) {
        const isSuccess = nodes.lock(nodes.nth(number));
        res.status(200).json(isSuccess);
      } else {
        res.status(403).send();
      }
    });

    app.post("/r/node/add", (req, res) => {
      const hostname = typeof req.body.hostname === "string" ? req.body.hostname.trim() : "";
      const port = ["string", "number"].includes(typeof req.body.port) ? Number(req.body.port) : NaN;
      const { token } = req.body;
      if (!hostname || (!/^[a-zA-Z0-9._-]+$/.test(hostname) && !isIP(hostname))) {
        return res.status(400).json({ error: "Enter a hostname or IP address only, without http://, https://, a port, or a path." });
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: "Enter a port between 1 and 65535." });
      }
      const node = nodes.addUnique(hostname, port, token);

      if (node) {
        node.updateInfo();
        res.send({ success: true });
      } else {
        res.status(409).json({ error: "Node already exists or has invalid parameters." });
      }
    });

    return new Promise((resolve, reject) => {
      const onListen = () => resolve(server);
      const server = options.host
        ? app.listen(options.port, options.host, onListen)
        : app.listen(options.port, onListen);
      server.once("error", reject);
    });
  },
};

const nodeToJson = (node) => ({
  name: node.toString(),
  isLocked: node.isLocked(),
  isAutoSpawned: node.isAutoSpawned(),
  isOnline: node.isOnline(),
  getTaskQueueCount: node.getTaskQueueCount(),
  getMaxParallelTasks: node.getMaxParallelTasks(),
  getEngineInfo: node.getEngineInfo(),
  getVersion: node.getVersion(),
  nodeData: node.nodeData,
});
