# ClusterODX admin: task owners, stale flags, and task removal

## Status

Implemented (2026-11-11; deviations under Decisions)

## Objective

Let an administrator see which Tapis user each tracked task belongs to, spot tasks that are
hung or abandoned, and remove them (optionally stopping the idle worker and cancelling its
Tapis job) from the admin web page, without exposing any user's bearer token and without
cancelling anything that is not the task's own job.

## User need

Only administrators can open the ClusterODX admin page. Today the **Registered Tasks** table
shows UUID, state, Tapis job, worker, image count and last activity, but not whose task it is.
When a worker dies or a submission is abandoned the row stays until the retention timers expire
(two days for pending records, five days for routes), and the only way to clear it is the telnet
CLI or a restart. Will asked on 2026-11-04 for the admin page to show the owning user and to
allow removing hung or old tasks.

## Non-goals

- Changing WebODM-facing behaviour or the NodeODX `/task/*` proxy API.
- Showing live processing progress from workers (the task list stays metadata-only and never
  probes a node; see `docs/design/2026-10-26-admin-task-list.md`).
- Any new way to cancel a Tapis job. Cancellation reuses the lifecycle work in
  `docs/design/2026-11-03-tapis-job-lifecycle-reconciliation.md`: `cancelPendingTask`,
  `destroyNode`, the registry, and the `unreachable` operator line.
- A service account. Cancels still use the owner's token held in memory.
- Changing the retention timers.
- Listing or removing registry-only records. A pending job rehydrated from
  `data/tapis-jobs.json` after a restart has no tasktable row, so it does not appear in the
  admin list and cannot be removed from it; the lifecycle vacuum owns those.
- Fixing the pre-existing persistence of user JWTs in `data/routes.json` (see Risks); a
  follow-up.

## Current code/system summary

- `libs/adminTasks.js` builds the admin task list from `tasktable.listSummaries()` and
  `routetable.findByNode()`, enriched with `provider.findPendingTask(uuid)` and
  `node.getTapisJobId()`. Rows are an explicit allowlist (`uuid, name, source, state,
  statusCode, imagesCount, dateCreated, accessed, tapisJobId, node`). It never probes a node.
  Neither `listSummaries` nor `findByNode` bumps `accessed`; `tasktable.lookup` and
  `routetable.lookup` / `lookupNode` do.
- The submitting user's JWT is the `token` stored on both the tasktable entry
  (`tasktable.add(taskId, obj, token)`) and the route (`routetable.add(taskId, node, token)`).
  `libs/tapisIdentity.extractUserFromToken(token)` decodes `username@tenant` from it without
  verifying. Route tokens are persisted to `data/routes.json` by `routetable.saveToDisk`
  (plain `fs.writeFile`, no mode, not awaited by `add`/`removeByNode`) and reloaded at
  startup; tasktable tokens are in memory only.
- Registration stores `tapisJobOwner` and `tapisJobOwnerTenant` on `node.nodeData`
  (`adminweb.js:454-458`). The provider's pending records carry `tapisJobOwner`,
  `tapisJobOwnerTenant`, `nodeUser` and are indexed under three keys: job name, Tapis job
  UUID and task id (`tapis.js:1152-1154`). `consumePendingTask` removes all keys for a record.
- `adminweb.js` protects `/r/*` with `requireTapisJwt` (`adminweb.js:653-672`) or Basic Auth.
  `allowedTenants` / `allowedUsers` are enforced only when non-empty, and both default to
  empty (`config-default.json:10-11`), so in the default configuration any Tapis user whose
  token passes `provider.validateToken` is an administrator. The validated claims are not
  kept for later handlers. The only write endpoints are node lock/unlock/add/delete.
- The registration webhook claims a pending task (`claimPendingTask`, `adminweb.js:428`), then
  awaits `nodes.saveToDisk`, `submitPendingTask` (the upload, minutes long), then
  `routetable.add`, `tasktable.delete`, `consumePendingTask`, `markRegistered`
  (`adminweb.js:462-471`). Nothing re-checks the pending record before `routetable.add`.
- The proxy's `/task/remove` (`libs/proxy.js:500-560`) forwards routed tasks to the worker
  and never deletes the route; for a pending task it calls `entry.abort()`, deletes
  `tmp/<uuid>`, and drops the tasktable record. `abort()` (`taskNew.js:520`) ends in
  `destroyMachine(dmHostname)`, which is `cancelPendingTask`. `taskNew.js:626-631` adds the
  route after the upload without re-checking `status.aborted`.
- `netutils.removeAndCleanupNode(node, asr)` calls `asr.destroyNode(node)`, ignores its
  result, removes all routes on the node, removes the node, and returns `nodes.remove`'s
  result. `destroyNode` cancels via the in-memory token or `markUnreachable`.
- The lifecycle vacuum's idle predicate is `taskQueueCount > 0 || routes on node > 0 ||
  node.transients > 0` (`tapis.js:795`). `Node.postRequest` returns `{error}` rather than
  throwing, bounded by `node.timeout` (10 s).
- `public/component/taskList.mjs` is a stateless table; `public/app.mjs` fetches
  `/r/task/list` and owns refresh/auth lifecycle with session and generation guards.
  `test/test-admin-task-ui.js` rewrites only the first `import` line of `taskList.mjs`, calls
  `TaskList({})` as a plain function, and has a hook harness used for `App`.

## Proposed design

Delivered as two commits / PRs on one branch. Part A is read-only and ships alone; Part B
adds the write endpoint and depends on Part A.

### Part A: owners and stale flags (read-only)

- `libs/tapisIdentity.js` gains `ownerLabel(token, fallbacks)`: returns `user@tenant` from the
  token, else from an explicit `{owner, tenant}` fallback, else `null`. Used by both stores.
- `tasktable.listSummaries()` adds `owner: ownerLabel(entry.token)`. Tokens are still never
  returned.
- `libs/adminTasks.listTasks` adds to each row:
  - `owner`: route token → tasktable summary owner → pending record
    (`tapisJobOwner`/`tapisJobOwnerTenant`, else `nodeUser`) → `node.nodeData.tapisJobOwner`
    + `tapisJobOwnerTenant`. No new provider method; no registry read. Advisory, never used
    for authorization.
  - `node.online` (`node.isOnline()`, a local heartbeat flag) and `node.autoSpawned`
    (`node.isAutoSpawned()`).
  - `stale` and `staleReason`:
    - routed row (`source: "route"`), non-terminal: stale only when `node.online === false`
      → `"worker_offline"`. Inactivity is **not** used for routed rows, because `accessed` is
      bumped by every WebODM poll and a healthy multi-hour job with a closed browser would
      otherwise look stale.
    - pending row (`submitting`, `waiting_registration`, `queued`, `unknown`): stale when
      `now - accessed > staleAfterMs` → `"inactive"`.
    - terminal rows are never stale.
    - `staleAfterMs` comes from `admin-task-stale-hours` (new integer config key, default
      `6`), passed to `adminweb.create` as `taskStaleHours`. Documented as advisory: a job
      legitimately waiting in the `normal` queue for hours will show as stale.
- UI: **Owner** column (username, tenant beneath, "Unknown" when null), **Age** column
  (from `dateCreated`, falling back to `accessed`), **Stale** badge with the reason as title
  and a `table-warning` row class, filter bar (owner select, state select, free-text search
  over uuid/name/owner/worker, "Stale only"), "n of total" count, and a **Stale** summary
  tile. Pure helpers (`filterTasks`, `staleRows`, `formatAge`) are exported and unit-tested.
- Config wiring: `config.js` string + int lists + help text; `config-default.json`;
  `index.js` passes `taskStaleHours`.

### Part B: task removal (write path)

#### Endpoint

`POST /r/task/remove`, JSON body `{ "uuids": [...], "stopWorker": false, "dryRun": false }`,
behind the existing admin middleware plus the checks below. Always `Cache-Control: no-store`.

- **Fail closed.** In JWT mode the endpoint answers `403 {"error": "Task removal requires
  admin-web-allowed-tenants or admin-web-allowed-users to be configured"}` unless at least one
  allowlist is non-empty. `adminweb.create` logs one startup `warn` when JWT mode is on with
  both lists empty. (Lock/unlock/add/delete node have the same exposure today; tightening them
  is a follow-up noted in Risks.)
- `requireTapisJwt` stores the validated identity on `res.locals.admin` as
  `{ username, tenantId, label: "user@tenant" }`; Basic mode stores
  `{ label: "basic", remoteAddress }`. In Basic mode the route additionally requires
  `Sec-Fetch-Site: same-origin` or a same-host `Origin` header (browsers attach Basic
  credentials automatically, so `rejectForeignOrigin`'s "no Origin passes" rule is not
  enough there).
- Body validation: `Content-Type: application/json`; `uuids` is 1 to 25 strings matching
  `^[A-Za-z0-9_-]{1,64}$`, duplicates collapsed; `stopWorker` and `dryRun` optional booleans.
  Anything else → `400`.
- Denied attempts (401/403) on this route are logged at `warn` with method, path and remote
  address, never the token.
- Requests run under a module-level single-flight lock shared with nothing else but itself;
  a second concurrent removal request gets `409 {"error": "Another removal is in progress"}`.
  Within a request, tasks are processed with concurrency 5 and distinct workers to stop are
  capped at 10 per request (`stopWorker` beyond that reports `skipped: worker cap`).

#### Per-task algorithm (`libs/adminTasks.removeTask(uuid, { stopWorker, dryRun, deps })`)

Identity is resolved **only** against tasktable and routetable keys. A pending record is
acted on only when `pending.taskId === uuid`; a match on job name or Tapis job UUID is
ignored and reported as `not_found`. Registry-only records are never touched. Each step runs
in its own try/catch and error strings pass through `sanitizeError` (reuse
`SENSITIVE_VALUE_PATTERN` from `libs/tapisJobRegistry.js`, strip control characters, truncate
to 200) before being returned or logged.

1. **Pending cancel.** If `provider.findPendingTask(uuid)` returns a record with
   `taskId === uuid` (duck-typed: only when the provider has `cancelPendingTask`), await
   `provider.cancelPendingTask(uuid)`. This consumes the handoff synchronously before any
   await, then cancels the Tapis job with the owner's in-memory token, parking `cancelFailed`
   or emitting the `unreachable` operator line as the lifecycle spec defines. Result:
   `pendingCancelled: true | false`. For non-Tapis providers this step is skipped and
   `abort()` in step 2 is the only cancel path.
2. **Tasktable.** New `tasktable.take(uuid)`: deletes synchronously and returns the entry
   object without bumping `accessed`. If the entry has `abort`, call it (stops an in-flight
   upload; its `destroyMachine` call finds the pending record already consumed and returns
   false). Then `utils.rmdir('tmp/<uuid>')` as the proxy does (uuid re-validated inside
   `removeTask`). Result: `tasktableRemoved`.
3. **Route.** Read the entry as `routetable.findByNode()[uuid]` (no `accessed` bump). If
   present: `await node.taskRemove(uuid)` → `workerRemove: "ok" | "failed: <sanitized>"`;
   then new `routetable.remove(uuid, { persist: false })` which deletes from memory
   synchronously. The request persists once at the end with `await routetable.saveToDisk()`
   inside try/catch (a disk error is logged and reported as `persist: "failed"` on the
   response, not as a failed removal). Result: `routeRemoved`.
4. **Stop worker** (only when `stopWorker` and the route's node exists):
   - server re-checks `node.isAutoSpawned()`; otherwise `workerStopped: "skipped: not
     auto-spawned"`.
   - `node.setLocked(true)` so the scheduler places nothing new on it, then evaluate the
     shared busy predicate extracted from the vacuum into `libs/nodeBusy.js`:
     `routes on node (after step 3) > 0 || taskQueueCount > 0 || transients > 0`. Busy →
     `workerStopped: "skipped: worker busy"` and the lock is released.
   - Not busy → `await provider.destroyNode(node)` (gives the cancel result; `true` =
     Tapis confirmed, `false` = parked `cancelFailed` or `unreachable`, read back from
     `provider.registry` state when available), then `routetable.removeByNode(node)`,
     `nodes.remove(node)`, `await nodes.saveToDisk()`. Result: `workerStopped:
     "cancelled" | "cancel_failed" | "unreachable" | "skipped: ..."`. Non-Tapis auto-spawned
     nodes go through `netutils.removeAndCleanupNode` and report `"removed"`.
   - Workers are de-duplicated within a batch so each is stopped at most once.
5. `outcome`: `"removed"` if any of steps 1 to 3 found something, `"not_found"` if none did,
   `"failed"` only if an exception escaped a step. `dryRun: true` performs every lookup and
   predicate but no mutation or Tapis call, and returns the same shape with
   `wouldStopWorker` instead of `workerStopped`.

Response: `200 { "dryRun": bool, "persist": "ok" | "failed", "results": [ { uuid, outcome,
owner, steps: { pendingCancelled, tasktableRemoved, workerRemove, routeRemoved,
workerStopped } } ] }`. One unknown uuid in a batch does not fail the others.

Audit line per task (`info`): `[ADMIN] task remove` with a JSON object
`{uuid, owner, admin, remoteAddress, outcome, stopWorker, dryRun, steps}`. Task `name` is
user-controlled and is not logged. A test asserts the captured log contains no JWT-shaped
string and no `token=`.

#### Registration and upload guards (closing the re-add races)

- `adminweb.js` webhook: immediately before `routetable.add(pending.taskId, …)` with no
  `await` in between, check `provider.findPendingTask(pending.taskId) === pending`. If not
  (the task was removed during the upload), best-effort `node.taskRemove(pending.taskId)`,
  `releasePendingTask`, log `webhook_rejected` with `error_class: "task_removed"`, and return
  `409 {"error": "Task was removed during registration"}` without adding a route or calling
  `markRegistered`.
- `libs/taskNew.js:630`: `if (status.aborted) return;` before `routetable.add`, so a task
  removed during a direct upload does not leave a ghost route. This also fixes the same gap
  for the proxy's own `/task/remove`.

#### UI (Part B)

- Row checkboxes, header checkbox for visible rows, **Select stale** (excludes routed rows
  whose worker is online), **Remove selected (n)**, per-row **Remove**.
- Confirm dialog (the existing `Dialog`, one instance at module level): on open it snapshots
  the selected uuids, calls the endpoint with `dryRun: true`, and lists each task (uuid, owner,
  name) with what would happen, including which workers would be stopped and which are busy.
  Checkbox **Also stop idle auto-spawned workers (cancels their Tapis job)**: pre-checked only
  when every selected routed task is on an auto-spawned worker; disabled when none is. The
  dialog warns that a worker that cannot be reached keeps running until the vacuum or the
  operator stops it.
- On confirm, `app.mjs` posts the real request through `postFetch`, applies the existing
  session/generation guard to the response, renders a one-line summary ("Removed 3. 1 already
  gone. 1 failed: <uuid> <message>"), prunes the selection, and reloads. Buttons are disabled
  while a request is in flight. Sub-components are defined at module level and rows keyed by
  uuid so the 5-second auto-refresh does not remount them.

## Files likely affected

Part A:
- `libs/tapisIdentity.js` (`ownerLabel`), `libs/tasktable.js` (`owner` in summaries),
  `libs/adminTasks.js` (owner, node flags, stale).
- `adminweb.js` (`taskStaleHours` option), `config.js`, `config-default.json`, `index.js`.
- `public/component/taskList.mjs`, `public/app.mjs`, `public/theme.css`.
- `test/test-admin-task-list.js`, `test/test-admin-task-ui.js`.
- `README.md`, `docs/tapis.md`, DSO `docs/services/clusterodm.md`,
  `docs/dev/environment-variables.md`.

Part B:
- `libs/adminTasks.js` (`removeTask`, `sanitizeError`), `libs/tasktable.js` (`take`),
  `libs/routetable.js` (`remove`), new `libs/nodeBusy.js` (predicate shared with the vacuum),
  `libs/asr-providers/tapis.js` (use the shared predicate), `libs/taskNew.js` (abort guard).
- `adminweb.js` (`res.locals.admin`, fail-closed check, Basic-mode same-origin check,
  `POST /r/task/remove`, webhook guard, startup warning).
- `public/component/taskList.mjs`, `public/app.mjs`.
- `test/test-admin-task-list.js`, `test/test-admin-task-ui.js`,
  `test/test-webhook-registration.js` (removal during claim), `test/test-tapis-vacuum.js`
  (predicate extraction unchanged behaviour).
- Docs as above.

## API/schema changes

- `GET /r/task/list` rows gain `owner`, `stale`, `staleReason`, `node.online`,
  `node.autoSpawned`.
- New `POST /r/task/remove` as specified; `403` in JWT mode without allowlists; `409` when a
  removal is already running; `410`-style semantics unchanged elsewhere.
- Registration webhook: new `409 task_removed` when the pending task vanished during upload.
- New config key `admin-task-stale-hours`.
- `routetable.remove` is new behaviour: the proxy's `/task/remove` never deleted routes.
- No new Tapis calls. `POST /v3/jobs/{uuid}/cancel` is reached only via `cancelPendingTask`
  and `destroyNode`.

## Data flow

1. Admin loads the page → `GET /r/task/list` → `listTasks` decodes owner in-process, reads
   the local online flag, computes `stale` → rows (no tokens).
2. Admin selects rows → dialog → `POST /r/task/remove {dryRun:true}` → preview →
   confirm → `POST /r/task/remove` → middleware (JWT + allowlist fail-closed, or Basic +
   same-origin) → single-flight lock → per uuid: pending cancel (Tapis, owner's in-memory
   token) → `tasktable.take` + abort + tmp cleanup → worker `taskRemove` → route removed →
   optional lock + busy check + `destroyNode` + node removal → one `routes.json` save →
   audit log → results → UI summary + refresh.
3. A worker registering for a removed task → webhook guard → `409` (or the lifecycle spec's
   `404`/`410` when nothing is pending).

## Risks and tradeoffs

- **Default-open admin.** With empty allowlists, any Tapis user who can authenticate is an
  admin today. The new endpoint fails closed; the existing node write endpoints do not. The
  production config must set `admin-web-allowed-users`; the startup warning and docs say so.
  Follow-up: apply the same fail-closed rule to node lock/unlock/add/delete.
- **Removal is irreversible.** Tasktable record, route, tmp dir and a cancelled Tapis job
  cannot be restored. Mitigations: dry-run preview in the dialog, explicit confirmation
  listing tasks, 25-task cap, audit line per task, `cancelFailed` records keep retrying.
- **A removed task on a live worker keeps processing if `taskRemove` fails.** The row is
  gone; the worker is cleaned up by `stopWorker` now or by the vacuum later. The response
  shows the failed step and the dialog warns about unreachable workers.
- **Tapis cancel needs a token in memory.** After a restart, `cancelPendingTask` /
  `destroyNode` emit the `unreachable` operator line; the UI shows
  `workerStopped: "unreachable"`. Same limitation as the lifecycle spec.
- **Routes persist user JWTs** in `data/routes.json` (pre-existing, contradicts the "tokens
  stay in memory" framing of the lifecycle docs). This spec does not add to that exposure but
  does rewrite the file; `saveToDisk` is called once per request. Follow-up: stop persisting
  tokens or store a hash, and write with mode 0600.
- **Stale is a heuristic.** Pending rows with long legitimate queue waits show as stale;
  routed rows are only stale when their worker is offline, so a healthy running job is never
  flagged. Nothing is removed automatically.
- **Worker stop safety.** The lock-then-busy-check uses the same predicate as the vacuum and
  covers routes, queue count and in-flight uploads/reservations (`transients`, shared
  submodel). A worker serving another user's task is skipped.
- **Basic Auth mode** has weaker attribution (one shared password, logged as `basic` plus
  remote address) and relies on the same-origin header check. Documented.
- **Blast radius of bulk remove** bounded by the 25-task and 10-worker caps, concurrency 5,
  and the single-flight lock.

## Alternatives considered

- **Reuse the proxy's `/task/remove` with the owner's token.** Rejected: the admin does not
  hold users' tokens and must not.
- **Delete rows only (no Tapis action).** Rejected as the only option: leaves the orphan the
  lifecycle spec exists to prevent. Offered as the default (`stopWorker: false`) with the
  explicit, previewed option.
- **Automatic removal of stale rows.** Rejected: queue waits make stale ambiguous.
- **A provider method `describeJob` for registry-derived owner** (revision 1). Dropped: the
  registry is Tapis-only and null before `initialize`; the node's stored owner covers the gap.
- **Resolve `uuid` through `findPendingTask` alone** (revision 1). Rejected after review: it
  matches job names and Tapis job UUIDs, so a job id passed as a task uuid would cancel a job
  with no task record.
- **Reject removal while a registration is claimed.** Rejected: the claimed window is the
  multi-minute upload, which is exactly the hung case; the webhook guard closes the race
  instead.
- **Port the ClusterODM change wholesale.** Rejected: it probes every node per refresh and
  predates the registry and cancel helper.

## Test plan

Part A (`test/test-admin-task-list.js`, `test/test-admin-task-ui.js`):
- owner from route token, tasktable token, pending record, node metadata; `null` otherwise;
  no JWT in the JSON; `ownerLabel` unit cases.
- stale: routed offline non-terminal → `worker_offline`; routed online with old `accessed` →
  not stale; pending inactive → `inactive`; terminal never stale; window from option.
- allowlist/key assertions updated; `node.online`, `node.autoSpawned` present.
- UI: imports stripped line-wise and `{html, useState, Dialog, …}` injected via a global as
  `nodeList` is tested; static render assertions on a trivial `useState` stub; `filterTasks`,
  `staleRows`, `formatAge` unit-tested without hooks; untrusted strings stay text.

Part B:
- `POST /r/task/remove`: 401 no auth, no side effects; 403 in JWT mode with empty allowlists;
  403 Basic mode without same-origin header; 400 invalid body / non-JSON / 26 uuids; 409 while
  another removal runs.
- routed task: `taskRemove` called, route removed, one `saveToDisk` per request (stubbed),
  `accessed` not bumped on failure; offline worker → `workerRemove: "failed: …"`, route still
  removed.
- pending task: `cancelPendingTask` awaited before `tasktable.take`; `abort()` invoked; tmp
  dir removed; a uuid equal to a known Tapis job id or job name → `not_found` and no cancel.
- `stopWorker`: not auto-spawned → skipped; busy via routes / `taskQueueCount` / `transients`
  → skipped and lock released; idle → locked, `destroyNode` called, node removed, result maps
  true/false to `cancelled`/`cancel_failed`/`unreachable`; two tasks on one worker → stopped
  once; worker cap.
- `dryRun`: no mutations, no Tapis or worker calls, `wouldStopWorker` populated.
- audit: captured log has admin label, owner, outcome; no JWT-shaped string; an injected
  worker error containing a JWT and `?token=` is redacted and truncated.
- webhook: removal during the claimed window → `409 task_removed`, no route added, no
  `markRegistered`; `taskNew` abort guard leaves no route.
- vacuum test unchanged after the predicate extraction.
- UI: selection, select-stale exclusion of online routed rows, dialog preview from dry-run,
  checkbox default/disabled rules, `onRemove(uuids, {stopWorker})`, summary rendering,
  buttons disabled in flight; App wires `postFetch` and reloads under the generation guard.

Full `npm test` (31 scripts) must pass for each part.

## Documentation plan

- `README.md` admin paragraph: owner column, stale badge and meaning, remove controls, what
  "stop worker" does, the allowlist requirement.
- `docs/tapis.md` "Admin task visibility": new fields, `POST /r/task/remove` contract and
  outcomes, `admin-task-stale-hours`, fail-closed rule, restart/no-token limitation,
  `409 task_removed`.
- DSO `docs/services/clusterodm.md` ClusterODX subsection and admin API table;
  `docs/dev/environment-variables.md` for the new key.

## Rollout/rollback plan

- Branch `feature/admin-task-owner-removal` from `feature/nodesplat-image-profile` (PR #6),
  because the registry and cancel helper only exist there. Two commits: Part A, Part B. No
  PR is opened without Will's approval (repo `AGENTS.md`).
- Before first production use of Part B: confirm `admin-web-allowed-users` is set in the
  deployed config, back up `data/routes.json` and `data/nodes.json`.
- Deploy with `restart.sh`; static files and server change together.
- Rollback: redeploy the previous commit. Old code ignores the new key. Removed data is not
  restored by rollback.

## Open questions

1. Is 6 hours the right default stale window for pending rows given `vm-small` queue waits of
   up to 4 hours and `normal` up to 12? Proposed: keep 6, show the reason, keep it configurable.
2. Should the fail-closed allowlist rule be extended to the existing node write endpoints in
   this change or as its own follow-up? Proposed: follow-up, to keep this reviewable.

## Decisions

- 2026-11-04 — Owner is decoded in-process from stored tokens or taken from pending/node
  metadata; tokens never leave the server. Same rule as the 2026-10-26 spec.
- 2026-11-04 — Removal goes through the lifecycle spec's cancel paths (`cancelPendingTask`,
  `destroyNode`), never a new Tapis call and never `scancel`.
- 2026-11-04 — Default removal does not stop the worker; the operator opts in per request
  after a dry-run preview.
- 2026-11-04 — The task list still makes no live requests; `stale` uses local state only, and
  routed rows are stale only when the worker is offline (architecture review).
- 2026-11-04 — `POST /r/task/remove` fails closed when JWT-mode allowlists are empty
  (security review blocker 1).
- 2026-11-04 — Task identity resolves only against tasktable/routetable keys; pending records
  act only on `taskId === uuid` (security review blocker 2).
- 2026-11-04 — Registration webhook re-checks the pending record immediately before
  `routetable.add` and answers 409 if it was removed (architecture review finding 1).
- 2026-11-04 — Worker stop locks the node and reuses the vacuum's busy predicate; result is
  tri-state from `destroyNode`, not from `removeAndCleanupNode` (both reviews).
- 2026-11-04 — Two-part delivery: read-only owners/stale first, removal second.

## User feedback / decisions

- 2026-11-04 — Will: "ClusterODM's UI is a bit of a mess. The only person who can use it is an
  Admin, but they need to see which users' tasks are there. We also need to be able to remove
  tasks that are hung, old etc." Then: "it was supposed to be fixing ClusterODX" after a
  first implementation landed in the ClusterODM checkout (commit 8dc18a8 there).
- Revision 2 awaiting Will's approval.
- 2026-11-11 — Will approved building the spec as written ("build it") and, in the same
  session, extended it with an admin "Open node" action. Removal of finished NodeSplat records
  was also approved, but `origin/master` already shipped it (PR #14, `DELETE /r/splat`,
  "finished or lease-expired" records plus a retention sweep), so this change does not add a second
  splat removal route.
- 2026-11-11 — Deviation: "Open node" is `POST /r/node/open` returning `{url}` (page opens it in a new
  tab) rather than a `GET` redirect, because admin auth is a Bearer header that a plain link
  navigation cannot send. The worker token appears only in that authenticated response; it is
  not in `/r/node/list` or logs. The node list link became a button, and `nodeUrl` still
  validates the address.
- 2026-11-11 — Deviation: with `stopWorker`, workers are evaluated in a second phase after every task in
  the request has been detached, so two tasks on one worker are not wrongly reported busy by each
  other. Dry run discounts the batch's own routes for the same reason.
- 2026-11-11 — Deviation: `tasktable.take` returns the stored object (`{taskInfo, abort, output}`), and
  `ownerLabel` accepts `{owner, tenant}` where `tenant` is optional.
- 2026-11-11 — The two open questions were resolved as proposed: 6 hour stale default
  (`admin-task-stale-hours`), and hardening the older node write endpoints is a follow-up.
- 2026-11-11 — Not done: a deterministic test for the `taskNew` abort guard (it covers a
  microtask-sized window); the one-line guard is in place and the webhook guard is tested.

