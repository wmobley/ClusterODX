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
const utils = require("./libs/utils");
const { extractBearerToken, normalizeRegistration } = require("./libs/tapisRegistration");
const { submitPendingTask } = require("./libs/tapisWorker");
const { classifySubmitError, logHandoffEvent, safeNodeEndpoint } = require("./libs/observability");
const crypto = require("crypto");

const safeStringEqual = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
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

      if (effectiveTapisToken) {
        try {
          await provider.validateToken(effectiveTapisToken);
          authenticated = true;
          authMethod = "tapis-jwt";
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

      const pending = provider.findPendingTask(registration.tapisJobUuid) ||
                      provider.findPendingTask(registration.registrationUuid);
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

      // A valid Tapis token alone must not be able to claim another user's
      // pending job. The worker token is expected to be the same request token
      // that created the Tapis submission.
      if (effectiveTapisToken && pending.token && !safeStringEqual(effectiveTapisToken, pending.token)) {
        logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
          task_id: pending.taskId,
          tapis_job_id: pending.tapisJobId,
          outcome: "rejected",
          error_class: "auth_error"
        }));
        return res.status(403).json({ error: "Tapis token does not own the pending task" });
      }

      let node = nodes.find(existing => existing.hostname() === registration.hostname && existing.port() === registration.port);
      if (!node) node = nodes.addUnique(registration.hostname, registration.port, registration.nodeToken);
      if (!node) {
        logHandoffEvent(logger, "webhook_rejected", Object.assign(registrationFields(), {
          task_id: pending.taskId,
          tapis_job_id: pending.tapisJobId,
          outcome: "rejected",
          error_class: "validation_error"
        }));
        return res.status(409).json({ error: "Node already exists or registration is invalid" });
      }

      node.setTapisJob(pending.tapisJobId);
      Object.assign(node.nodeData, pending.registrationMeta || {}, registration.metadata, {
        nodeReady: registration.nodeReady
      });
      await nodes.saveToDisk();

      try {
        await submitPendingTask(pending, node);
        await routetable.add(pending.taskId, node, pending.token);
        await tasktable.delete(pending.taskId);
        provider.consumePendingTask(registration.tapisJobUuid || registration.registrationUuid);
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
          authMethod
        });
      } catch (error) {
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

    if (!options.password) {
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
      const { hostname, port, token } = req.body;
      const node = nodes.addUnique(hostname, port, token);

      if (node) {
        node.updateInfo();
        res.send({ success: true });
      } else {
        res.send({ error: "Invalid" });
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
