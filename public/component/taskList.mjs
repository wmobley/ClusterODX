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

export const TaskList = ({ tasks = [], loading = false, error = "" }) => html`
  <section class="mt-4" aria-label="Tasks" aria-busy=${loading}>
    <h4>Tasks</h4>
    <p class="text-muted small">
      Local handoff state: assigned tasks have a worker route. This does not confirm processing progress.
    </p>
    ${loading && html`<p role="status">Loading tasks…</p>`}
    ${error && html`<div class="alert alert-danger" role="alert">${error}</div>`}
    ${!tasks.length && !loading && !error && html`<p class="text-muted">No tracked tasks.</p>`}
    ${tasks.length > 0 && html`
      <div class="table-responsive">
        <table class="table table-hover table-striped">
          <thead><tr>
            <th scope="col">Task</th><th scope="col">State</th>
            <th scope="col">Tapis job</th><th scope="col">Worker</th>
            <th scope="col">Images</th><th scope="col">Created</th>
          </tr></thead>
          <tbody>${tasks.map((task) => html`
            <tr key=${task.uuid}>
              <td class="text-break">${task.name}<div class="small text-muted">${task.uuid}</div></td>
              <td>${STATE_LABELS[task.state] || STATE_LABELS.unknown}</td>
              <td class="text-break">${task.tapisJobId || "—"}</td>
              <td class="text-break">${task.node ? `${task.node.hostname}:${task.node.port}` : "Unassigned"}</td>
              <td>${task.imagesCount ?? "—"}</td>
              <td>${task.dateCreated === null ? "—" : new Date(task.dateCreated).toLocaleString()}</td>
            </tr>
          `)}</tbody>
        </table>
      </div>
    `}
  </section>
`;
