# ClusterODX admin task visibility

## Status
Implemented

## Objective
Show WebODM tasks in the ClusterODX admin before worker registration and after handoff.

## User need
Tapis jobs start, but the admin currently shows only nodes, leaving submitted tasks invisible.
The user requested a fix. ClusterODM remains outside scope.

## Current code/system summary
`libs/taskNew.js` inserts a tasktable record before Tapis submission. The Tapis provider
stores pending handoffs indexed by task ID, job name, and Tapis UUID. Registration
adds a routetable entry and removes the tasktable record. `adminweb.js` exposes only
node listing; `public/app.mjs` renders only NodeList. ClusterODM has a task-list
implementation but includes credentials in summaries and links, which will not be copied.
No .wolf directory exists. DSO docs use claude-context rather than Codex-context;
the existing service page describes ClusterODM and has no ClusterODX entry.

## Proposed design
1. Add `tasktable.listSummaries()` returning only UUID, name, numeric status,
   image count, creation time, and last activity. Do not return tokens, options,
   paths, output, or raw objects. This is an internal read-only snapshot; normalize values to primitive strings/numbers.
2. Add GET `/r/task/list` behind the existing admin JWT/basic authentication middleware.
   Read pending summaries first, then route entries, and merge by UUID using a Map, preferring routed entries
   during handoff. Enrich pending entries with provider.findPendingTask(uuid) when
   available and routed entries with node.getTapisJobId(). Never serialize raw nodes.
3. Return allowlisted rows: uuid, name, source (pending/route), state, statusCode,
   imagesCount, dateCreated, accessed, tapisJobId, and node endpoint or null.
   State distinguishes submitting/launching, waiting for worker registration, assigned,
   failed, canceled, completed, and unknown. “Assigned” is a routing observation, not
   confirmation that the photogrammetry engine is running. No live node/Tapis requests.
4. Render a task table with task ID/name, handoff state, Tapis UUID, worker endpoint,
   image count, and creation time. Show explicit empty, loading, and fetch-error states.
   Fetch on login and manual refresh, and with existing five-second auto-refresh.
   Clear task data on logout or expired authentication. Guard fetch responses by request generation
   so results started before logout or a newer refresh cannot repopulate the table.
   Render all values through escaped Preact text interpolation. Replace the existing
   interval-in-state pattern with an effect-owned timer: run only while authenticated,
   clear on logout/expiry/unmount and when auto-refresh is disabled.
5. Document the endpoint, interpretation, and existing in-memory limitations.

## Files likely affected
- `libs/tasktable.js`, `adminweb.js`: snapshots and protected endpoint.
- `libs/adminTasks.js`: dedicated allowlisted aggregation following libs conventions.
- `public/app.mjs`, `public/component/taskList.mjs`: fetch and presentation.
- `public/authToken.mjs`, `public/common.fetch.js`: ignore 401 responses from older sessions.
- `test/test-admin-task-list.js`, `package.json`: API, aggregation and UI coverage.
- `README.md`, `docs/tapis.md`: admin behavior and endpoint.
- This spec and `/Users/wmobley/Documents/Github/DSO-Architecture/docs/services/clusterodm.md`
  (a clearly labeled ClusterODX compatibility subsection).

## API/schema changes
New read-only admin GET `/r/task/list` returns an array of allowlisted summary rows.
No new persisted schema or write API. Existing admin authorization scope is retained:
authorized administrators see all cluster tasks, as they already see all nodes.
Response uses Cache-Control: no-store on success and errors. Failures return a generic
500 JSON error; never log raw entries or exception text containing credentials.
Row contract: uuid/name/source/state are strings; statusCode and imagesCount are
finite numbers or null; dateCreated/accessed are epoch milliseconds or null;
tapisJobId is a string or null; node is null or {hostname: string, port: number}.
Absent names fall back to the UUID. Source is pending or route. States:
- Local terminal code 30/40/50: failed/completed/canceled, taking precedence over route.
- Route present without local terminal code: assigned (never labeled running).
- Pending with matched Tapis job UUID: waiting_registration.
- Pending local RUNNING (20) without job UUID: submitting.
- Pending local QUEUED (10) without job UUID: queued.
- Anything else: unknown.
Route wins duplicate identity, but preserves any terminal tasktable status and safe metadata.
Example pending row: {"uuid":"task-1","name":"Flight","source":"pending",
"state":"waiting_registration","statusCode":20,"imagesCount":0,
"dateCreated":1793030400000,"accessed":1793030400000,
"tapisJobId":"job-1","node":null}.

## Data flow
WebODM request → tasktable → submitted Tapis pending handoff → worker registration →
routetable. Admin authentication → local snapshots → sanitized rows → task table.

## Risks and tradeoffs
Pending state is process-local and is lost on restart; this change does not recover
historical Tapis jobs. Existing routes persist but store little task metadata, so routed
names/counts can be unavailable. Local handoff state does not report scheduler state or
actual engine status. Admin scope is cluster-wide. Snapshot races must not duplicate rows.
No live network fan-out is used, preventing slow workers from stalling the dashboard.
Missing deployment callback arguments can still prevent registration; no real deployment
config or confirmed ClusterODX public hostname is available here, so do not guess it.

## Alternatives considered
- Copy ClusterODM task UI/API: exposes credentials and unrelated delete controls.
- Reuse proxy `/task/list`: scoped by exact request token and cannot show all admin tasks.
- Poll Tapis for all jobs: broader integration with performance and ownership implications.
- Only render registered nodes: preserves the reported visibility bug.

## Test plan
Exercise pending before submit, waiting registration with Tapis UUID, routed rows,
failed/canceled status, simultaneous route/pending deduplication, non-Tapis tasks,
empty/uninitialized stores, and summaries containing seeded secrets. Verify missing and
invalid admin authentication are rejected and authorized JWT/basic requests work.
Verify cache headers and generic error responses. Test UI state labels and safe rendering;
verify dashboard fetch/refresh/logout wiring and late-response suppression after logout. Run full npm test and whitespace checks.

## Documentation plan
Describe GET `/r/task/list` and handoff states in README and docs/tapis.md.
Update DSO architecture service documentation if an applicable ClusterODX page exists;
otherwise document the new endpoint in the existing ClusterODM service page under an
explicit ClusterODX compatibility note, without claiming ClusterODM behavior changed.

## Rollout/rollback plan
Deploy ClusterODX code/static files and restart through the existing deployment process.
Rollback the code change; no migration. Deployment and new GitHub writes require approval.

## Open questions
Real ClusterODX callback hostname and remote ASR configuration are unavailable; worker
registration configuration cannot be repaired from these logs alone. Task display can be fixed.

## Decisions
### 2026-10-26 — Show local task lifecycle without credentials
- Decision: Use local pending/routing snapshots, protected by existing admin auth.
- Reason: Make tasks visible immediately without introducing remote polling or secret exposure.
- Alternatives rejected: Copying credential-bearing ClusterODM rows and assuming running status.
- User feedback: Requested “so fix it”; concrete endpoint/table plan sent for approval.
- Impact on implementation: ClusterODX read-only API, UI, tests, docs only.

### 2026-10-26 — Review findings
- Design review requested concrete state/field definitions and refresh race behavior; added above.
- Security review recommends proceed with primitive allowlisting, escaped rendering,
  existing authentication, Map deduplication, no-store errors, and secret-exclusion tests.
- Architecture review identified existing refresh timer cleanup gaps; scope includes
  an effect-owned timer and generation guards to prevent post-logout repopulation.

### 2026-10-26 — Protect newer login sessions
- **Decision:** Track an in-memory auth-session version in authenticated fetches.
- **Reason:** A delayed 401 from a prior session must not clear credentials after relogin.
- **Alternatives rejected:** Dashboard-only request guards cannot prevent the shared fetch helper from expiring a newer session.
- **User feedback:** Covered by approved logout/refresh race protections.
- **Impact on implementation:** Small changes to authToken.mjs/common.fetch.js and a regression test; no server authentication change.

### 2026-10-26 — Implementation and verification
- **Decision:** Mark implemented after the full suite and direct final QA review.
- **Reason:** All 13 npm test scripts passed, along with syntax and CRLF-aware diff whitespace checks.
- **Alternatives rejected:** Live job submission/deployment was unnecessary to validate local task visibility and was not performed.
- **User feedback:** User requested continuation of the approved implementation.
- **Impact on implementation:** Added protected task summaries/table, safe metadata, snapshot ordering, terminal precedence, refresh/error/empty states and timer cleanup. Separate QA agent was unavailable; primary agent completed the diff review. DSO docs/services/clusterodm.md has a labeled ClusterODX subsection, preserving pre-existing edits. No additional deviations beyond the session-version guard above. No new commit, push, deployment, or live browser test performed. Existing remote callback configuration remains unresolved; restart cannot recover earlier process-local pending tasks.

## User feedback / decisions
User approved requirements, design and implementation plan on 2026-10-26: “Approve and implement”.

### 2026-10-26 — Approval
- User approved the presented task endpoint, table, waiting-registration state, and credential exclusion.
- Implementation follows the reviewed design.
