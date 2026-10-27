import { html } from "../lib/preact.html.mjs";

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

export const TaskList = ({ tasks = [], loading = false, error = "" }) => html`
  <section class="dashboard-panel mt-4" aria-label="Tasks" aria-busy=${loading}>
    <h4>Registered Tasks <span class="badge bg-light text-dark">${tasks.length}</span></h4>
    <p class="text-muted small">
      Local handoff state: assigned tasks have a worker route. This does not confirm processing progress.
    </p>
    ${loading && html`<p role="status">Loading tasks…</p>`}
    ${error && html`<div class="alert alert-danger" role="alert">${error}</div>`}
    ${!tasks.length && !loading && !error && html`<p class="text-muted">No tracked tasks.</p>`}
    ${tasks.length > 0 && html`
      <div class="table-responsive">
        <table class="table table-hover table-striped">
          <thead class="table-primary"><tr>
            <th scope="col">Task</th><th scope="col">State</th>
            <th scope="col">Tapis job</th><th scope="col">Worker</th>
            <th scope="col">Images</th><th scope="col">Last Activity</th><th scope="col">Details</th>
          </tr></thead>
          <tbody>${tasks.map((task) => html`
            <tr key=${task.uuid}>
              <td class="text-break">${task.name}<div class="small text-muted">${task.uuid}</div></td>
              <td><span class=${`badge ${badgeClass(task.state)}`}>${STATE_LABELS[task.state] || STATE_LABELS.unknown}</span></td>
              <td class="text-break">${task.tapisJobId || "—"}</td>
              <td class="text-break">${task.node ? `${task.node.hostname}:${task.node.port}` : "Unassigned"}</td>
              <td>${task.imagesCount ?? "—"}</td>
              <td class="text-nowrap">${formatTaskDate(task.accessed)}</td>
              <td>
                <details class="task-details">
                  <summary>View details</summary>
                  <dl class="small mt-2 mb-0">
                    <dt>Task UUID</dt><dd class="text-break">${task.uuid}</dd>
                    <dt>Tapis job</dt><dd class="text-break">${task.tapisJobId || "—"}</dd>
                    <dt>Source</dt><dd>${task.source === "route" ? "Worker route" : task.source === "pending" ? "Pending task" : "Unknown"}</dd>
                    <dt>Created</dt><dd>${formatTaskDate(task.dateCreated)}</dd>
                    <dt>Last activity</dt><dd>${formatTaskDate(task.accessed)}</dd>
                  </dl>
                </details>
              </td>
            </tr>
          `)}</tbody>
        </table>
      </div>
    `}
  </section>
`;
