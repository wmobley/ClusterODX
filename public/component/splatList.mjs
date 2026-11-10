import { html } from "../lib/preact.html.mjs";
import { formatTaskDate } from "./taskList.mjs";

const badgeClass = state => ({
  running: "bg-primary", ready: "bg-success", failed: "bg-danger", canceled: "bg-secondary",
  result_ready: "bg-success", cancel_pending: "bg-warning text-dark", queued: "bg-info text-dark",
  submitting: "bg-warning text-dark", submission_unknown: "bg-warning text-dark",
}[state] || "bg-secondary");

const timestamp = value => (typeof value === "string" ? Date.parse(value) : value);

export const SplatList = ({ workers = [], onRemove }) => html`<section class="dashboard-panel mt-4" aria-label="NodeSplat workers">
  <h4>NodeSplat Workers <span class="badge bg-light text-dark">${workers.length}</span></h4>
  <p class="text-muted small">
    GPU training workers started per run. They are tracked separately from NodeODX nodes and never receive ODM tasks.
  </p>
  ${!workers.length && html`<p class="text-muted">No NodeSplat workers.</p>`}
  ${workers.length > 0 && html`<div class="table-responsive"><table class="table table-hover table-striped">
    <thead>
      <tr class="table-primary">
        <th>Run</th><th>Owner</th><th>State</th><th>Registered</th><th>Worker</th><th>Tapis job</th><th>Last seen</th><th></th>
      </tr>
    </thead>
    <tbody>
      ${workers.map(worker => html`<tr key=${worker.uuid}>
        <td title=${worker.uuid}>${worker.runId ?? worker.uuid}</td>
        <td>${worker.owner ?? "—"}</td>
        <td><span class=${`badge ${badgeClass(worker.state)}`}>${worker.state}</span>${worker.phase ? html` <span class="text-muted small">${worker.phase}</span>` : ""}</td>
        <td>${worker.registered ? html`<span class="badge bg-success">Registered</span>` : html`<span class="badge bg-secondary">Not registered</span>`}</td>
        <td>${worker.worker ?? "—"}</td>
        <td>${worker.tapisJobUuid ?? "—"}</td>
        <td>${formatTaskDate(timestamp(worker.lastHeartbeat) || timestamp(worker.updatedAt))}</td>
      </tr>`)}
    </tbody>
  </table></div>`}
</section>`;
