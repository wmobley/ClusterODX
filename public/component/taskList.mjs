import { html } from "../lib/preact.html.mjs";
import { useState } from "../lib/hooks.module.js";
import { Dialog } from "./dialog.mjs";

const STATE_LABELS = {
  submitting: "Submitting / launching worker",
  waiting_registration: "Waiting for worker registration",
  queued: "Queued",
  assigned: "Assigned to worker",
  failed: "Failed",
  completed: "Completed",
  canceled: "Canceled",
  unknown: "Unknown",
};

const STALE_REASONS = {
  worker_offline: "The worker this task is routed to is offline.",
  inactive: "No activity for longer than the configured stale window.",
};

const badgeClass = state => ({
  completed: "bg-success", failed: "bg-danger", canceled: "bg-secondary",
  assigned: "bg-primary", queued: "bg-info text-dark", waiting_registration: "bg-warning text-dark",
  submitting: "bg-warning text-dark",
}[state] || "bg-secondary");

export const formatTaskDate = value => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

// "5m", "3h", "2d" since a timestamp; "—" when unknown.
export const formatAge = (value, now = Date.now()) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value > now) return "—";
  const minutes = Math.floor((now - value) / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

const NO_FILTER = { owner: "", state: "", text: "", staleOnly: false };

export const filterTasks = (tasks = [], filters = NO_FILTER) => {
  const needle = String(filters.text || "").trim().toLowerCase();
  return tasks.filter(task => {
    if (filters.owner && (task.owner || "") !== filters.owner) return false;
    if (filters.state && task.state !== filters.state) return false;
    if (filters.staleOnly && !task.stale) return false;
    if (!needle) return true;
    const haystack = [task.uuid, task.name, task.owner, task.node && `${task.node.hostname}:${task.node.port}`]
      .filter(Boolean).join("\n").toLowerCase();
    return haystack.includes(needle);
  });
};

// "Select stale" never picks a routed task whose worker is online.
export const staleRows = (tasks = []) => tasks.filter(task =>
  task.stale && !(task.source === "route" && task.node && task.node.online === true));

// Stopping a worker is pre-checked only when every routed selection sits on an
// auto-spawned worker, and unavailable when none does.
export const stopWorkerDefaults = (tasks = [], selected = []) => {
  const chosen = tasks.filter(task => selected.includes(task.uuid));
  const routed = chosen.filter(task => task.node);
  const spawned = routed.filter(task => task.node.autoSpawned === true);
  return { available: spawned.length > 0, checked: routed.length > 0 && spawned.length === routed.length };
};

// One line describing a removal response: "Removed 3. 1 already gone. 1 failed: <uuid> <message>".
export const summarizeRemoval = (response) => {
  const results = response && Array.isArray(response.results) ? response.results : [];
  const removed = results.filter(result => result.outcome === "removed").length;
  const gone = results.filter(result => result.outcome === "not_found").length;
  const failed = results.filter(result => result.outcome === "failed");
  const parts = [`Removed ${removed}.`];
  if (gone) parts.push(`${gone} already gone.`);
  if (failed.length) {
    parts.push(`${failed.length} failed: ${failed.map(result => `${result.uuid} ${(result.errors || [""])[0]}`.trim()).join("; ")}`);
  }
  if (response && response.persist === "failed") parts.push("The route table could not be saved to disk.");
  return parts.join(" ");
};

const describeStep = (result, stopWorker) => {
  const steps = result.steps || {};
  const worker = stopWorker ? (steps.wouldStopWorker ?? steps.workerStopped) : null;
  const notes = [];
  if (result.outcome === "not_found") return "Already gone";
  if (steps.pendingCancelled) notes.push("cancel pending Tapis job");
  if (steps.routeRemoved) notes.push("remove worker route");
  if (steps.tasktableRemoved) notes.push("remove tracking record");
  if (worker === true) notes.push("stop idle worker");
  else if (typeof worker === "string" && worker) notes.push(`worker: ${worker}`);
  return notes.join(", ") || "Nothing to do";
};

const RemoveDialog = ({ dialog, tasks, onChangeStop, onClose, onConfirm, busy }) => {
  if (!dialog) return null;
  const byUuid = new Map(tasks.map(task => [task.uuid, task]));
  const defaults = stopWorkerDefaults(tasks, dialog.uuids);
  const rows = dialog.preview && Array.isArray(dialog.preview.results) ? dialog.preview.results : [];
  return html`<${Dialog}
    open=${true}
    title=${`Remove ${dialog.uuids.length} task${dialog.uuids.length === 1 ? "" : "s"}?`}
    handlerClose=${onClose}
    handlerApply=${busy || dialog.loading ? () => {} : onConfirm}
    labelApply=${busy ? "Removing…" : "Remove"}
    modalBody=${html`<div>
      ${dialog.error && html`<div class="alert alert-danger" role="alert">${dialog.error}</div>`}
      ${dialog.loading && html`<p role="status">Checking what would happen…</p>`}
      <ul class="small">
        ${dialog.uuids.map(uuid => {
          const task = byUuid.get(uuid) || {};
          const result = rows.find(row => row.uuid === uuid);
          return html`<li key=${uuid} class="text-break">
            <strong>${task.name || uuid}</strong> <span class="text-muted">${uuid}</span>
            <div>Owner: ${task.owner || "Unknown"}${result ? html` · ${describeStep(result, dialog.stopWorker)}` : ""}</div>
          </li>`;
        })}
      </ul>
      <label class="form-check">
        <input type="checkbox" class="form-check-input" disabled=${!defaults.available}
          checked=${dialog.stopWorker} onChange=${event => onChangeStop(event.currentTarget.checked)} />
        <span class="form-check-label">Also stop idle auto-spawned workers (cancels their Tapis job)</span>
      </label>
      <p class="small text-muted mt-2 mb-0">
        Removal cannot be undone. A worker that cannot be reached keeps running until the lifecycle vacuum or an operator stops it.
      </p>
    </div>`}
  />`;
};

export const TaskList = ({ tasks = [], loading = false, error = "", onRemove = null, onChanged = () => {} }) => {
  const [filters, setFilters] = useState(NO_FILTER);
  const [selected, setSelected] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState("");

  const visible = filterTasks(tasks, filters);
  const owners = Array.from(new Set(tasks.map(task => task.owner).filter(Boolean))).sort();
  const staleCount = tasks.filter(task => task.stale).length;
  const known = new Set(tasks.map(task => task.uuid));
  const chosen = selected.filter(uuid => known.has(uuid));
  const toggle = uuid => setSelected(chosen.includes(uuid) ? chosen.filter(item => item !== uuid) : [...chosen, uuid]);
  const allVisible = visible.length > 0 && visible.every(task => chosen.includes(task.uuid));
  const removable = typeof onRemove === "function";

  const openDialog = async uuids => {
    if (!removable || !uuids.length || busy) return;
    const defaults = stopWorkerDefaults(tasks, uuids);
    const initial = { uuids: [...uuids], stopWorker: defaults.checked, loading: true, preview: null, error: "" };
    setDialog(initial);
    try {
      const preview = await onRemove(initial.uuids, { dryRun: true, stopWorker: defaults.available });
      setDialog({ ...initial, loading: false, preview });
    } catch (previewError) {
      setDialog({ ...initial, loading: false, error: previewError.message || "Preview failed" });
    }
  };

  const confirm = async () => {
    if (!dialog || busy) return;
    const snapshot = dialog;
    setBusy(true);
    try {
      const response = await onRemove(snapshot.uuids, { dryRun: false, stopWorker: snapshot.stopWorker });
      setSummary(summarizeRemoval(response));
      setSelected(chosen.filter(uuid => !snapshot.uuids.includes(uuid)));
      setDialog(null);
      onChanged();
    } catch (removeError) {
      setDialog({ ...snapshot, error: removeError.message || "Removal failed" });
    } finally {
      setBusy(false);
    }
  };

  return html`
  <section class="dashboard-panel mt-4" aria-label="Tasks" aria-busy=${loading}>
    <h4>Registered Tasks <span class="badge bg-light text-dark">${visible.length} of ${tasks.length}</span>
      ${staleCount > 0 && html` <span class="badge bg-warning text-dark" title="Advisory: see the Stale column">${staleCount} stale</span>`}</h4>
    <p class="text-muted small">
      Local handoff state: assigned tasks have a worker route. This does not confirm processing progress.
      Stale is advisory: a job legitimately waiting in a long queue also shows as stale.
    </p>
    ${loading && html`<p role="status">Loading tasks…</p>`}
    ${error && html`<div class="alert alert-danger" role="alert">${error}</div>`}
    ${summary && html`<div class="alert alert-info" role="status">${summary}</div>`}
    ${!tasks.length && !loading && !error && html`<p class="text-muted">No tracked tasks.</p>`}
    ${tasks.length > 0 && html`
      <div class="d-flex flex-wrap gap-2 mb-2 align-items-center">
        <select class="form-select form-select-sm w-auto" aria-label="Filter by owner" value=${filters.owner}
          onChange=${event => setFilters({ ...filters, owner: event.currentTarget.value })}>
          <option value="">All owners</option>
          ${owners.map(owner => html`<option key=${owner} value=${owner}>${owner}</option>`)}
        </select>
        <select class="form-select form-select-sm w-auto" aria-label="Filter by state" value=${filters.state}
          onChange=${event => setFilters({ ...filters, state: event.currentTarget.value })}>
          <option value="">All states</option>
          ${Object.entries(STATE_LABELS).map(([state, label]) => html`<option key=${state} value=${state}>${label}</option>`)}
        </select>
        <input type="search" class="form-control form-control-sm w-auto" placeholder="Search id, name, owner, worker"
          aria-label="Search tasks" value=${filters.text}
          onInput=${event => setFilters({ ...filters, text: event.currentTarget.value })} />
        <label class="form-check form-check-inline mb-0">
          <input type="checkbox" class="form-check-input" checked=${filters.staleOnly}
            onChange=${event => setFilters({ ...filters, staleOnly: event.currentTarget.checked })} />
          <span class="form-check-label">Stale only</span>
        </label>
        ${removable && html`
          <button type="button" class="btn btn-sm btn-outline-secondary" disabled=${busy}
            onClick=${() => setSelected(staleRows(visible).map(task => task.uuid))}>Select stale</button>
          <button type="button" class="btn btn-sm btn-outline-danger" disabled=${busy || !chosen.length}
            onClick=${() => openDialog(chosen)}>Remove selected (${chosen.length})</button>`}
      </div>
      <div class="table-responsive">
        <table class="table table-hover table-striped">
          <thead class="table-primary"><tr>
            ${removable && html`<th scope="col"><input type="checkbox" aria-label="Select all visible tasks"
              checked=${allVisible} onChange=${event => setSelected(event.currentTarget.checked ? visible.map(task => task.uuid) : [])} /></th>`}
            <th scope="col">Task</th><th scope="col">Owner</th><th scope="col">State</th>
            <th scope="col">Tapis job</th><th scope="col">Worker</th>
            <th scope="col">Images</th><th scope="col">Age</th><th scope="col">Last Activity</th><th scope="col">Details</th>
            ${removable && html`<th scope="col">Actions</th>`}
          </tr></thead>
          <tbody>${visible.map((task) => html`
            <tr key=${task.uuid} class=${task.stale ? "table-warning" : ""}>
              ${removable && html`<td><input type="checkbox" aria-label=${`Select ${task.uuid}`}
                checked=${chosen.includes(task.uuid)} onChange=${() => toggle(task.uuid)} /></td>`}
              <td class="text-break">${task.name}<div class="small text-muted">${task.uuid}</div></td>
              <td class="text-break">${task.owner || "Unknown"}</td>
              <td><span class=${`badge ${badgeClass(task.state)}`}>${STATE_LABELS[task.state] || STATE_LABELS.unknown}</span>
                ${task.stale && html` <span class="badge bg-warning text-dark" title=${STALE_REASONS[task.staleReason] || "Stale"}>Stale</span>`}</td>
              <td class="text-break">${task.tapisJobId || "—"}</td>
              <td class="text-break">${task.node ? `${task.node.hostname}:${task.node.port}` : "Unassigned"}</td>
              <td>${task.imagesCount ?? "—"}</td>
              <td class="text-nowrap">${formatAge(task.dateCreated ?? task.accessed)}</td>
              <td class="text-nowrap">${formatTaskDate(task.accessed)}</td>
              <td>
                <details class="task-details">
                  <summary>View details</summary>
                  <dl class="small mt-2 mb-0">
                    <dt>Task UUID</dt><dd class="text-break">${task.uuid}</dd>
                    <dt>Owner</dt><dd class="text-break">${task.owner || "Unknown"}</dd>
                    <dt>Tapis job</dt><dd class="text-break">${task.tapisJobId || "—"}</dd>
                    <dt>Source</dt><dd>${task.source === "route" ? "Worker route" : task.source === "pending" ? "Pending task" : "Unknown"}</dd>
                    <dt>Created</dt><dd>${formatTaskDate(task.dateCreated)}</dd>
                    <dt>Last activity</dt><dd>${formatTaskDate(task.accessed)}</dd>
                    ${task.stale && html`<dt>Stale</dt><dd>${STALE_REASONS[task.staleReason] || "Stale"}</dd>`}
                  </dl>
                </details>
              </td>
              ${removable && html`<td><button type="button" class="btn btn-sm btn-outline-danger" disabled=${busy}
                onClick=${() => openDialog([task.uuid])}>Remove</button></td>`}
            </tr>
          `)}</tbody>
        </table>
      </div>
    `}
    <${RemoveDialog} dialog=${dialog} tasks=${tasks} busy=${busy}
      onChangeStop=${value => dialog && setDialog({ ...dialog, stopWorker: value })}
      onClose=${() => !busy && setDialog(null)} onConfirm=${confirm} />
  </section>
`;
};
