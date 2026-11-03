# Tapis job lifecycle: reconciliation, cancellation, and orphan cleanup

## Status

Implemented (revision 2 approved by Will on 2026-11-03; implemented and QA-reviewed the same day, not yet deployed)

## Objective

Stop ClusterODX from leaving Tapis/Slurm jobs running on Lonestar6 with no task to
process, and make every Tapis-side action it takes attributable to a user and a time in
the log.

## User need

- **Primary user:** the ClusterODX operator (Will), who pays for idle allocation hours and
  has to find and cancel orphans by hand.
- **Secondary users:** WebODM users whose tasks fail with a generic "No nodes available"
  message while their job is in fact queued.
- **Job to be done:** submit, cancel and finish Tapis-backed tasks without leaving jobs
  behind, and see in one log who did what and when.
- **Current pain:** on 2026-11-03 one afternoon of use left five orphaned `clusterodx-*`
  jobs (one running idle, four pending) across two users. Each idle worker holds its
  allocation for the full job time limit (2 h on `vm-small`, up to 17 h on `normal`).
  Failures could only be attributed by matching task UUIDs against the WebODM worker log.
- **Definition of success:** after deployment, no `clusterodx-*` Slurm job outlives its
  ClusterODX task by more than `maxUploadTime` (default 60 min) while ClusterODX is running
  and the owner's token is valid; every orphan ClusterODX cannot cancel is named in an
  `error` log line with job uuid and owner; every `[TAPIS]` log line carries a timestamp
  and `user`.

## Non-goals

- Changing the NodeODX launcher or publishing a new Tapis app (companion work, see
  Rollout). ClusterODX cannot be the only backstop and this spec says so.
- A service account that can cancel any user's job.
- Fixing WebODM's choice of token by project owner, or the corral group permissions.
- Non-Tapis ASR providers.

## Current code/system summary

Observed on 2026-11-03 against the deployed ClusterODX at
`/home/wmobley/ODM-SUITE/ClusterODX` (same commit as this checkout) and that day's logs.

1. **Submit timeout is treated as failure.** `submitJobWithoutData`
   (`libs/asr-providers/tapis.js:539`) uses a 60 s HTTP timeout. On `ECONNABORTED` it
   throws, `createNode` (`tapis.js:611`) never records a pending task, and `taskNew.js`
   reports "No nodes available (attempted to autoscale but failed)". Tapis had created the
   job (Slurm 3549774 for `clusterodx-0-evgDuwr33oc6EmW8ax2XxP`, plus three under another
   user). When such a worker starts, `adminweb.js:358` answers its registration with 404
   and the NodeODX launcher (`nodeodx-ls6/register-node.sh:337`) retries forever.
2. **Cancellation calls an undocumented endpoint.** `cancelJob` (`tapis.js:519-520`)
   sends `PUT /v3/jobs/{id}` with `{operation: "stop"}`; `libs/splatTasks.js:283` does the
   same. The Tapis Jobs documentation
   (https://tapis.readthedocs.io/en/latest/technical/jobs.html, endpoint table) lists
   `POST /v3/jobs/{JobUUID}/cancel` and no such PUT. The previous ClusterODM used the POST.
   Observed response today: HTTP 500. Call sites: `tapis.js:619` (abort during submit),
   `tapis.js:700` (`cancelPendingTask`), `tapis.js:717` (`destroyNode`).
3. **Cancel failure is unhandled and leaves state behind.** `abortTask`
   (`libs/taskNew.js:519-530`) calls `asr.destroyMachine(dmHostname)` without awaiting it
   inside a `try/catch`, so the rejection became
   `Uncaught Exception: Request failed with status code 500` (caught by the process-level
   handler in `index.js:85`, so the process survived). `cancelPendingTask` awaits the cancel
   before `consumePendingTask`, so the pending record survived; when that job's worker
   registers it will be handed the cancelled task.
4. **Worker teardown uses the same broken call.** `/commit` → `asrProvider.onCommit` →
   `cleanup` → `netutils.removeAndCleanupNode` → `destroyNode` → `cancelJob`. On failure the
   node stays in `data/nodes.json` and the Slurm job idles to its limit. `destroyNode` also
   returns `false` silently when `activeJobs` has no entry, which is every job after a
   restart.
5. **The vacuum never touches Tapis nodes.** `asrProvider.vacuum` (`libs/asrProvider.js:123`)
   only acts on nodes with `nodeData.dockerMachine` (set by `Node.setDockerMachine`, called
   only from `AbstractASRProvider.js:170`, which the Tapis provider bypasses). `maxUploadTime:
   3600` in the Tapis config (`tapis.js:152`) is therefore dead.
6. **All job state is in memory.** `pendingTasks` and `activeJobs` are `Map`s
   (`tapis.js:157-158`). `pendingTasks` is multi-keyed (hostname, Tapis uuid, task id →
   same object) and `claimPendingTask`/`consumePendingTask` rely on object identity. A
   restart (two on 2026-11-03) forgets every submitted job.
7. **Logs carry no identity or time.** `[TAPIS]` events log job name, queue and sizes but
   not the token's username; `libs/logger.js` writes no timestamps. Existing persistence
   (`libs/nodes.js:191-206`, `libs/routetable.js:138-153`) uses fire-and-forget
   `fs.writeFile` with no file mode and no atomic rename; `routes.json` already stores user
   JWTs that way.
8. **Launcher behaviour** (`logs/tapisjob_app.sh:470-478`, app 1.0.14 copy; 1.0.18 assumed
   equivalent `[ASSUMPTION — confirm against the deployed ZIP]`): if registration returns
   non-zero (401 on an expired bearer) the script "continues without registration" and
   NodeODX runs to the Slurm limit.

## Proposed design

Delivered in three phases. Phase 1 is a ship-alone fix for the verified defects. Phases 2
and 3 depend on Phase 1 and on the Tapis behaviour checks listed under Open questions.

### Phase 1: correct cancellation and observability

- One helper `tapisCancelJob(client, uuid)` used by `tapis.js` and `splatTasks.js`:
  `POST /v3/jobs/{uuid}/cancel`. Outcomes: 2xx → `cancelled`; 404 → `not_found` (treated
  as terminal only after a `GET /v3/jobs/{uuid}` with the same token also returns 404,
  otherwise `failed`); 401/403 → `unauthorized` (logged, never treated as success); 5xx or
  network error → `failed` (retryable). The exact Tapis responses for cancelling a job in
  PENDING, QUEUED, RUNNING and terminal states are `[ASSUMPTION — confirm]` and must be
  checked with a real `vm-small` job before this helper is finalised.
- `cancelPendingTask`: `consumePendingTask` first, then cancel; on `failed`/`unauthorized`
  keep the job in the in-memory `activeJobs` with state `cancelFailed` so the Phase 3 vacuum
  can retry. The task is never handed to a worker after cancel was requested.
- `taskNew.js abortTask`: `Promise.resolve(asr.destroyMachine(...)).catch(log)`; the
  `destroyNode` false-return path logs at `warn` with job uuid and reason.
- `libs/logger.js`: timestamp on every line.
- Every `[TAPIS]` event and the `Cannot forward task …` warning include
  `user: <username>@<tenant>` from `extractUserFromToken`. Axios errors are logged as
  `status` + `message` only (never `config`, headers or URL with the token).
- Log output must never contain a JWT-shaped string; a test asserts this on the captured
  logger output for submit, cancel and failure paths.

### Phase 2: durable job registry (metadata only) and submission reconciliation

- `libs/tapisJobRegistry.js`, a plain persistence helper mirroring `nodes.js`/`routetable.js`
  with three upgrades: atomic write (temp file in `data/`, mode `0600`, then rename),
  serialised writes, and a load-time schema check that treats a corrupt file as empty and
  logs it. File: `data/tapis-jobs.json`, git-ignored.
- Record: `{jobName, tapisJobId, owner, ownerTenant, taskId, imagesCount, queue, nodeCount,
  maxMinutes, state, submittedAt, acceptedAt, registeredAt, lastSeenAt, cancelRequestedAt,
  bearerExpiresAt}`. **No token is stored.** Tokens stay in the in-memory Maps only.
  Consequence, stated plainly: after a restart ClusterODX can still *know about* every job
  but can only cancel the ones for which a fresh bearer arrives (Phase 3 registration path)
  or which the operator cancels by hand from the `error` log line.
- States: `submitting` (write-ahead, before the POST) → `submitted` → `registered` → `done`;
  side states `cancelRequested`, `cancelFailed`, `unreachable` (token expired, operator
  action needed).
- The in-memory `pendingTasks`/`activeJobs` Maps and the provider's public methods
  (`findPendingTask`, `findRegistrationJob`, `findPendingTaskByUser`, `claimPendingTask`,
  `consumePendingTask`) are unchanged. The registry is write-through: `upsert` on every
  state change, `load()` on startup rehydrates `pendingTasks` (three keys per record) and
  `activeJobs` without tokens; `registrationClaimed`, `tmpPath` and `pathImport` are
  transient and not persisted. Registration writes `registered` from the existing
  claim/handoff path in `adminweb.js` (after the successful `task_submit_finished` event,
  next to `node.setTapisJob`). On startup, records whose node is absent from `nodes.json`
  are marked `unreachable` if they were `registered`, and `submitting`/`submitted` records
  are reconciled as below.
- **Write order in `createNode`:** write `submitting` → POST → on acceptance or
  reconciliation write `submitted` with the uuid → only then check `status.aborted`; an
  aborted job is cancelled through the helper and a failed cancel parks as `cancelFailed`
  instead of being lost.
- **Reconciliation:** on timeout or network error after the request was sent, poll
  `GET /v3/jobs/list?orderBy=lastUpdated(desc)&limit=50` every 10 s with 1.5× backoff for
  `tapis.submitReconcileSeconds` (default 120), checking `status.aborted` each poll. Match
  requires `name === jobName` **and** owner equals the token user **and** `created` after
  `submittedAt`. `[ASSUMPTION — confirm]` that `orderBy=lastUpdated(desc)` and `limit` work
  on `portals.tapis.io` and whether `GET /v3/jobs/search?name.eq=` exists; if search works
  it replaces the list. If nothing is found the submission fails as today, but the
  `submitting` record is kept for the Phase 3 vacuum (which rechecks by name on later ticks
  for up to `registrationGraceMinutes`) rather than dropped. Concurrent reconcile loops are
  capped (default 5) and the Tapis base URL is pinned from config with redirects disabled.
- `tapis.submitTimeoutMs` default raised from 60000 to 120000.

### Phase 3: Tapis-aware vacuum and verified unknown-job cancellation

- `TapisAsrProvider.vacuum()` on its own timer (`tapis.vacuumIntervalSeconds`, default 120),
  also invoked from `asrProvider.vacuum` behind `typeof provider.vacuum === 'function'`;
  `AbstractASRProvider.vacuum` is a no-op. Every record is handled in its own try/catch.
  Rules, each only while a usable token is in memory:
  - `submitted` job: query `GET /v3/jobs/{uuid}`. While Tapis reports a pre-run status
    (PENDING … QUEUED, BLOCKED) wait up to `tapis.maxQueueWaitMinutes[queue]` (defaults:
    `vm-small` 240, `normal` 720, `[ASSUMPTION — confirm]` against real queue waits). Once
    RUNNING, a job that has not registered within `tapis.registrationGraceMinutes`
    (default 20) is an orphan → cancel. A `submitted` job whose ClusterODX task is already
    cancelled/removed → cancel immediately.
  - `registered` node online, `taskQueueCount === 0`, no active route, and no task
    assigned or reserved for longer than `maxUploadTime` across at least three consecutive
    ticks → `removeAndCleanupNode`.
  - `registered` node offline for longer than `maxUploadTime` across at least three
    consecutive failed probes → remove node, cancel job.
  - `cancelRequested`/`cancelFailed` → retry via the helper with backoff.
  - Any of the above when the in-memory token is missing or past `bearerExpiresAt` →
    state `unreachable`, one `error` line `[TAPIS] orphan requires operator action` with
    job uuid, Slurm-visible job name, owner and queue. No token or claims beyond
    username/tenant are logged.
  - Records Tapis reports terminal → `done`. `done`/`unreachable` records older than
    7 days are pruned.
- **Unknown-job registration** (`adminweb.js`, task-bound registrations only, never
  `role: worker`), behind `worker.cancelUnknownJobs` (**default `false`** for the first
  deployment; see Rollout). When a JWT validates, a `tapisJobUuid` is present, and there is
  no pending task, node, route, or registry record in `submitting`/`submitted` state for it:
  1. `GET /v3/jobs/{uuid}` with the request bearer.
  2. Cancel only if **all** hold: job owner and tenant equal the token's; `name` starts with
     `clusterodx-`; `appId` and `appVersion` equal this instance's configured app; status is
     non-terminal; and, when `tapis.instanceId` is configured, the name carries it
     (`generateHostname` gains an optional instance segment).
  3. Cancel through the helper; record the outcome in the registry as `cancelRequested`
     or `cancelFailed` under the uuid; per-owner limit of 10 cancels per minute and
     per-uuid dedupe so a retry loop cannot fan out Tapis calls.
  4. Respond 410 with a fixed body `{"error":"No task for this job","terminate":true}`
     regardless of cancel outcome. Callers whose JWT is invalid keep the existing 401;
     callers whose token does not own the job get the existing 404, so 410 does not reveal
     ownership of other users' jobs.
  Tapis enforces ownership on cancel; ClusterODX's checks are defence in depth and the
  second-instance guard, not the authorisation boundary.
- **Companion change (required, separate repo):** `nodeodx-ls6/register-node.sh` exits
  non-zero after a bounded number of 404/410 responses (and immediately on 410 with
  `terminate: true`), and `tapisjob_app.sh` stops NodeODX and exits when registration fails
  instead of "continuing without registration". Without this, a worker whose bearer expired
  in the queue is unreachable by every path in this spec. Tracked in its own spec in
  `nodeodx-ls6/`.

## Files likely affected

- `libs/asr-providers/tapis.js` — cancel helper use, write-ahead/registry wiring,
  reconciliation, vacuum, `user` in log events, `destroyNode` logging.
- `libs/tapisCancel.js` — new shared cancel helper (used by `tapis.js`, `splatTasks.js`).
- `libs/tapisJobRegistry.js` — new.
- `libs/asrProvider.js` — optional provider vacuum hook.
- `libs/classes/AbstractASRProvider.js` — no-op `vacuum`, optional instance segment in
  `generateHostname`.
- `libs/taskNew.js` — awaited abort, username in warnings.
- `libs/splatTasks.js:283` — cancel helper.
- `adminweb.js` — `registered` write, unknown-job verify-and-cancel, 410.
- `libs/logger.js` — timestamps.
- `libs/adminTasks.js` — ensure registry records are not serialised wholesale.
- `config-default.json`, `docs/tapis.md`, `.gitignore`.
- Tests: `test/test-tapis-provider.js`, `test/test-webhook-registration.js`, new
  `test/test-tapis-cancel.js`, `test/test-tapis-registry.js`,
  `test/test-tapis-reconciliation.js`, `test/test-tapis-vacuum.js`.

## API/schema changes

- Registration webhook: new 410 response for verified-unknown task-bound jobs when
  `worker.cancelUnknownJobs` is on (previously 404). `test-webhook-registration.js` asserts
  404 today and will be extended for both flag states.
- New local state file `data/tapis-jobs.json` (metadata only, `0600`, git-ignored).
- New Tapis ASR config keys: `tapis.submitTimeoutMs`, `tapis.submitReconcileSeconds`,
  `tapis.maxQueueWaitMinutes`, `tapis.registrationGraceMinutes`,
  `tapis.vacuumIntervalSeconds`, `tapis.instanceId`, `worker.cancelUnknownJobs`.
  `maxUploadTime` becomes live for Tapis nodes.
- Tapis calls added: `POST /v3/jobs/{uuid}/cancel`, `GET /v3/jobs/{uuid}`,
  `GET /v3/jobs/list`.
- No WebODM-facing API change.

## Data flow

1. WebODM `POST /task/new` with the owner's JWT → `taskNew.process` → `createNode`.
2. Registry `submitting` → POST → 200 or reconciled by name → registry `submitted`.
3. Worker registers → claim/handoff → `node.setTapisJob` → registry `registered`.
   Unknown job → verify with Tapis → cancel with the request bearer → 410.
4. Task `/commit` or failure → `onCommit` → `cleanup` → `removeAndCleanupNode` → cancel
   helper → registry `done`.
5. `/task/cancel` → consume pending → cancel helper → `done` or `cancelFailed`.
6. Vacuum tick → sweep registry and nodes per Phase 3 rules.

## Risks and tradeoffs

- **No token persistence means no cancel after restart or token expiry.** Accepted
  deliberately after security review: user JWTs on disk for up to 17 h were judged a worse
  exposure than the residual orphans. Residual orphans are surfaced as `error` lines and
  are bounded by the companion launcher change plus Slurm wall limits.
- **Cancelling a legitimately queued job.** Mitigated by status-aware grace periods
  (pre-run statuses wait up to the per-queue maximum; only RUNNING-but-unregistered jobs
  are orphans after 20 min).
- **Killing a worker between WebODM stages.** Idle detection requires no route, no reserved
  task, and three consecutive idle ticks past `maxUploadTime` (60 min default).
- **Second ClusterODX instance on the same app.** The flag defaults off; the `appId`,
  `appVersion` and optional `tapis.instanceId` checks make accidental cross-cancel require
  identical configuration.
- **WebODM retry while the old job is queued** can hold two queue slots until the vacuum
  cancels the first (RUNNING without registration, or task gone). Accepted; noted in docs.
- **Reconciliation misses** (list paginated past 50, slow consistency) cause a visible
  failure plus a later vacuum cancel of the untracked job, not a silent orphan.
- **Multi-node jobs.** The registry is keyed per Tapis job; cancelling kills all siblings,
  which is correct when the task is cancelled or the job never registered. Sibling-only
  loss is out of scope.

## Alternatives considered

- **Persist owner JWTs so cancels survive restarts** (revision 1). Rejected: longer-lived
  plaintext credentials on disk; expiry still defeats it within hours.
- **Service account with cancel rights.** Cleaner expiry story, but one identity able to
  cancel every user's job and Tapis-side setup. Rejected this iteration; revisit if
  `unreachable` orphans dominate after Phase 3.
- **Fix the cancel endpoint only.** Removes most orphans but none from timeouts, restarts or
  idle workers. Shipped as Phase 1, not as the whole fix.
- **Fake `nodeData.dockerMachine` so the existing vacuum works.** Rejected: wrong semantics
  for `isAutoSpawned`, cannot see pre-registration jobs, no token/expiry logic.
- **Launcher exits on 404 instead of ClusterODX cancelling.** Required anyway (companion
  change) but leaves the Slurm job to run until the worker notices; both are needed.

## Test plan

Unit tests in the existing harness (`node test/<file>.js`, all registered in `npm test`),
using a fake Tapis HTTP server:

- Cancel helper: POST path; 2xx, 404-then-GET-404, 404-then-GET-200, 401/403, 500 each map
  to the specified outcome; no outcome logs a token.
- `cancelPendingTask` consumes before cancelling; failure parks `cancelFailed`;
  `abortTask` never rejects.
- Registry: write-ahead record exists before the POST is sent; atomic write leaves no
  partial file; corrupt file loads as empty with a log line; rehydration restores three
  keys per pending record without tokens.
- Reconciliation: timeout-then-list-contains-name → `submitted`; wrong owner or earlier
  `created` → no match; abort during polling → cancel; concurrency cap honoured.
- Vacuum: RUNNING-unregistered past grace → cancel; QUEUED past per-queue max → cancel;
  QUEUED within max → untouched; idle node three ticks → removed; one idle tick → kept;
  expired token → single `error` line, `unreachable`; terminal in Tapis → `done`.
- Webhook: flag off → 404 as today; flag on, verified unknown → GET then POST cancel with
  the request bearer, 410 fixed body; foreign owner → 404; invalid JWT → 401; `role: worker`
  unaffected; rate limit and dedupe.
- Log test: captured logger output across all paths contains no JWT-shaped string and every
  `[TAPIS]` line has a timestamp and `user`.

Manual on LS6, pass criteria in log lines:

- Submit a small task, cancel in WebODM: `[TAPIS] job cancel … outcome=cancelled` within
  10 s and `squeue` no longer lists the job within 60 s.
- Submit, then `kill -9` ClusterODX during the queue wait, restart: registry shows the job
  `submitted`; when it runs and registers, handoff succeeds (token still valid) or the
  `orphan requires operator action` line names it (token expired).
- Pre-implementation verification run (Open questions 1–3) recorded in this spec.

## Documentation plan

- `docs/tapis.md`: cancel semantics, write-ahead registry file, reconciliation, vacuum
  rules, new config keys, 410 response, operator procedure for `unreachable` orphans.
- DSO-Architecture `docs/services/clusterodm.md` (the existing page for this service):
  integrations section gains the Tapis jobs cancel/get/list calls; `docs/dev/environment-
  variables.md` gains the new ASR config keys.

## Rollout/rollback plan

- **One-time manual cleanup first** (external write, needs the owners' approval): Slurm
  3549648, 3549775, 3549780, 3549784 belong to cscheng and must be cancelled by cscheng
  (`scancel`) or via Tapis with their token. 3549774 (wmobley) was cancelled by Will on
  2026-11-03.
- **Phase 1** deploy with `restart.sh`; verify a WebODM cancel removes the Slurm job.
- **Phase 2** deploy; registry starts empty; existing in-flight jobs are not tracked.
- **Phase 3** deploy with `worker.cancelUnknownJobs=false` and vacuum in log-only mode
  (`tapis.vacuumDryRun=true`) for one week; review `[TAPIS] vacuum would …` lines; then
  enable. Companion launcher change ships as a new app version before the flag is enabled.
- **Rollback:** redeploy the previous commit. Old code ignores `data/tapis-jobs.json`, so
  jobs submitted under the new code become untracked again and need manual cleanup if they
  orphan.

## Open questions

1. Tapis cancel semantics by state (PENDING, QUEUED, RUNNING, terminal): status codes and
   whether cancel is asynchronous. Verify with a throwaway `vm-small` job and `squeue`.
2. Does `GET /v3/jobs/list` honour `orderBy=lastUpdated(desc)` and `limit` on
   `portals.tapis.io`, and does `GET /v3/jobs/search?name.eq=` exist?
3. Does `GET /v3/jobs/{uuid}` with a non-owner token return 403 or 404?
4. Realistic queue waits for `normal` to set `tapis.maxQueueWaitMinutes` defaults.
5. Who owns the companion `nodeodx-ls6` launcher change and the 1.0.19 app publish?

## Decisions

- 2026-11-03 — Fix cancellation and the full lifecycle, not the endpoint alone; today's
  orphans came from three independent paths (timeout, cancel, teardown) plus no backstop.
- 2026-11-03 — Do **not** persist user JWTs (rejected revision-1 design) after security and
  skeptic review; registry stores metadata only, tokens stay in memory.
- 2026-11-03 — Unknown-job cancellation requires a Tapis `GET` verification of owner, name,
  app and status before cancelling, and ships default-off.
- 2026-11-03 — Three-phase delivery; Phase 1 is a ship-alone fix.
- 2026-11-03 — Vacuum lives in the Tapis provider, not in generic `asrProvider`, and does not
  reuse `nodeData.dockerMachine`.
- 2026-11-03 — Per-user tokens retained for cancellation; no service account this iteration.
- 2026-11-03 — QA review (ready with fixes) applied: token adoption refreshes `bearerExpiresAt`
  and revives `unreachable` records; the vacuum skips records whose handoff is claimed and
  re-reads state after the Tapis lookup; an empty Tapis status makes no decision; every
  no-token path emits the single operator `error` line via `markUnreachable`; Tapis calls
  default to a 30 s timeout; repeated 401/403 cancel outcomes (`tapis.maxUnauthorizedCancelRetries`,
  default 3) mark the job `unreachable`; registry values that look like a JWT or carry
  `token=` are redacted, not just keys.
- 2026-11-03 — Not done, deliberately: live verification of Tapis cancel semantics by job state
  (Open question 1) requires submitting a throwaway job; do this on first deployment with
  `tapis.vacuumDryRun=true` before enabling `worker.cancelUnknownJobs`.

### Implementation deviations (2026-11-03)

- The persisted token-expiry field is `bearerExpiresAt`, not `tokenExpiresAt`: the
  registry strips every key matching token/secret/credential, which is the right
  default and would otherwise drop the expiry.
- Reconciliation uses `GET /v3/jobs/search?search=name.eq.<name>` (already used in
  production by `libs/splatTasks.js`) instead of `GET /v3/jobs/list`, filtered on
  name, owner, app and a `created` time no earlier than the submit. Open question 2 is
  therefore resolved by existing usage.
- The vacuum does not re-search never-confirmed `submitting` records by name: no token
  survives a restart, and in-process the reconcile window already covers them. Such
  records are closed after `maxQueueWaitMinutes` + `registrationGraceMinutes`.
- Repeat unknown-job registrations for the same uuid within five minutes answer 410
  without a second cancel request (per-uuid dedupe), and per-owner cancels are capped
  at 10 per minute.
- Extra config keys beyond the spec: `tapis.reconcilePollMs`,
  `tapis.maxReconcileConcurrency`, `tapis.consecutiveIdleTicks`,
  `tapis.registryRetentionDays`, `tapis.vacuumDryRun`, `tapis.registryPath`.
- `tapis.instanceId` is inserted as the third segment of the job name
  (`clusterodx-<n>-<id>-<short>`) so the existing prefix and image-count parsing hold.
- All three phases are delivered in one change set; staged rollout is achieved with
  `worker.cancelUnknownJobs=false` (default) and `tapis.vacuumDryRun=true` rather than
  separate deployments.
- A restored pending record adopts the registering worker's validated bearer so the
  route and later cancellation have a token; the spec only implied this.

## User feedback / decisions

- 2026-11-03 — Will reported ClusterODX "not differentiating users"; investigation showed
  per-user identity is correct and the symptom was timeouts plus orphaned jobs. Will
  cancelled Slurm 3549774 and asked for a fix for the orphan problem on ClusterODX.
- 2026-11-03 — Will approved revision 2 ("do it"): phased delivery, no service account,
  proposed queue-wait defaults accepted pending real data; launcher change owner still open.
