import { deleteFetch, postFetch } from "../common.fetch.js";
import { useState } from "../lib/hooks.module.js";
import { html } from "../lib/preact.html.mjs";
import { DeleteInstanceDialog } from "./dialog.mjs";
export const NodeList = ({ nodes = [], getData = () => {} }) => {
  const LockBtn = ({ isLock, number }) =>
    isLock
      ? html`<button class="btn btn-sm btn-outline-secondary mx-1" onClick=${(e) => doUnLock(number)}>
          <i class="bi bi-lock"></i>
          UNLOCK
        </button>`
      : html`<button class="btn btn-sm btn-outline-primary mx-1" onClick=${(e) => doLock(number)}>
          <i class="bi bi-lock-fill"></i>
          LOCK
        </button>`;
  const DelBtn = ({ number }) => {
    // onClick=${(e) => doDelete(number)}
    const [open, setOpen] = useState(false);
    const handlerOnClickBtn = (e) => {
      setOpen(!open);
    };
    const handlerClose = () => {
      setOpen(false);
    };
    return html`<div>
      <button class="btn btn-sm  btn-outline-danger" onClick=${handlerOnClickBtn}>
        <i class="bi bi-trash-fill"></i>
        DEL
      </button>
      <${DeleteInstanceDialog}
        open=${open}
        handlerClose=${handlerClose}
        handlerApply=${() => {
          doDelete(number);
        }}
      />
    </div>`;
  };

  const doLock = (number) => {
    postFetch("/r/node/lock", {
      body: { number },
    })
      .then((res) => res.json())
      .then((isSuccess) => {
        getData();
      })
      .catch((ex) => {
        console.error(ex);
      });
  };

  const doUnLock = (number) => {
    postFetch("/r/node/unlock", {
      body: { number },
    })
      .then((res) => res.json())
      .then((isSuccess) => {
        getData();
      })
      .catch((ex) => {
        console.error(ex);
      });
  };

  const doDelete = (number) => {
    deleteFetch("/r/node", {
      body: { number },
    })
      .then((res) => res.json())
      .then((isSuccess) => {
        getData();
      })
      .catch((ex) => {
        console.error(ex);
      });
  };
  return html`<section class="dashboard-panel" aria-label="Nodes">
    <h4>Registered Nodes <span class="badge bg-light text-dark">${nodes.length}</span></h4>
    ${!nodes.length && html`<p class="text-muted">No registered nodes.</p>`}
    <div class="table-responsive"><table class="table table-hover table-striped">
    <thead>
      <tr class="table-primary">
        <th>#</th>
        <th>Node</th>
        <th>Status</th>
        <th>Queue</th>
        <th>Engine</th>
        <th>API</th>
        <th>CPU Cores</th>
        <th>RAM available</th>
        <!--<th>Last updated</th>-->
        <th>Flags</th>
        <th>Link</th><th>Actions</th>
      </tr>
    </thead>
    <tbody>
      ${nodes &&
      nodes.map((node, idx) => {
        const flags = [];
        if (node.isLocked) flags.push("L");
        if (node.isAutoSpawned) flags.push("A");
        return html`<tr key=${`${node.nodeData?.hostname}:${node.nodeData?.port}:${idx}`}>
          <td>${idx + 1}</td>
          <td>${node.name}</td>
          <td>
            <${IsOnline} isOnline=${node.isOnline} />
          </td>
          <td>${node.getTaskQueueCount ?? "—"}/${node.getMaxParallelTasks ?? "—"}</td>
          <td>${node.getEngineInfo}</td>
          <td>${node.getVersion}</td>
          <td>${node.nodeData?.info?.cpuCores ?? "—"}</td>
          <td>${getRamAvailable(node)}</td>
          <td>${flags.map(flag => html`<span class="badge bg-secondary me-1" title=${flag === "L" ? "Locked" : "Automatically provisioned"}>${flag}</span>`)}</td>
          <td>${nodeUrl(node.nodeData) ? html`<a href=${nodeUrl(node.nodeData)} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open node</a>` : "—"}</td>
          <td>
            <div class="btn-group" role="group">
              <${LockBtn} isLock=${node.isLocked} number=${idx + 1} />
              <${DelBtn} number=${idx + 1} />
            </div>
          </td>
        </tr>`;
      })}
    </tbody>
  </table></div></section>`;
};

const IsOnline = ({ isOnline = false }) =>
  isOnline ? html`<span class="badge bg-success">Online</span>` : html`<span class="badge bg-danger">Offline</span>`;

const getRamAvailable = (node) => {
  const { availableMemory, totalMemory } = node?.nodeData?.info || {};

  if (!Number.isFinite(availableMemory) || !Number.isFinite(totalMemory) || availableMemory < 0 || totalMemory <= 0) return "—";

  const percent = (availableMemory / totalMemory) * 100;
  const ram = `${bytesToSize(availableMemory)}/${bytesToSize(totalMemory)}`;
  const strPercent = `${percent.toFixed(2)}%`;
  return html`<span data-bs-toggle="tooltip" title=${ram}>${strPercent}</span>`;
};

const bytesToSize = (bytes, decimals = 2) => {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
};

// Only a bare HTTP(S) endpoint is allowed; never carry worker credentials into links.
export const nodeUrl = (data = {}) => {
  const { hostname, port } = data || {};
  const numericPort = Number(port);
  if (typeof hostname !== "string" || !hostname || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return null;
  if (/[\s/@?#\\]/.test(hostname)) return null;
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  try {
    const url = new URL(`${numericPort === 443 ? "https" : "http"}://${host}:${numericPort}/`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.href;
  } catch (_) { return null; }
};
