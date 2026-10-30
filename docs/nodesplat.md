# NodeSplat workflow (`/splat/*`)

Disabled by default (`splat.enabled=false`). When enabled, ClusterODX exposes a dedicated
namespace for NodeSplat OpenSplat training. It never registers NodeSplat in the generic node
registry, so photogrammetry scheduling, retries, shared-submodel selection and `/options` are
unaffected (`test/test-splat-partition.js`). Design:
`docs/design/2026-10-30-nodesplat-worker.md` in the suite root.

## Configuration (`config.json` → `splat`)

| Key | Default |
|---|---|
| `enabled` | `false` |
| `instanceId` | `""` — the grant audience; required when enabled |
| `profileId` | `nodesplat-v1` |
| `storeDir` | `data/splat-tasks` (0700; records 0600; one process lock, single replica only) |
| `maxConcurrentRuns` | `1` |
| `maxLogBytes` / `maxPageLines` / `maxPageBytes` | 50 MiB / 500 / 256 KiB |
| `grantMaxAgeSeconds` / `workerLeaseSeconds` | 300 / 86400 |
| `grantKeys` | `{}` — `{ "<issuer>": { "<key_id>": "<secret>" } }` |
| `callbackPolicy` | `{schemes:[],hosts:[],cidrs:[],ports:[]}` — empty fails closed |
| `profile` | required: `baseUrl` (https), `tenantId`, `appId`, `appVersion`, `executionSystemId`, `archiveSystemId`, `queue`, `allocation`, `coresPerNode`, `memoryMB`, `maxMinutes`, `inputRoot`, `outputRoot`, `callbackUrl`, `workerBindHost`, `workerPort` |

Startup fails if `maxMinutes * 60 + 600 > workerLeaseSeconds`. There are no production
defaults for any profile value. Secrets belong in deployment configuration only.

## Endpoints

User routes need `Authorization: Bearer <Tapis JWT>`, validated against the configured tenant
(`GET /v3/systems`). 401 means sign in again, 403 means not permitted/not the owner, 503 means
Tapis could not be reached.

- `POST /splat/task/new` — `{run_id, source_task_id, manifest_sha256, profile_id, settings, grant}`.
  202 with durable intent; identical replay is 200 with the same UUID; changed inputs 409;
  capacity 429. Starts require a backend-only HMAC-SHA256 grant (five-minute window).
- `GET /splat/task/:uuid/info`, `POST /splat/task/:uuid/sync` (owner-authenticated Tapis
  reconciliation), `GET /splat/task/:uuid/output?line=N`,
  `GET /splat/task/:uuid/download/{model.ply,manifest.json,console.txt}`,
  `POST /splat/task/cancel` — 202 `cancel_pending` until the allocation is confirmed stopped.
- `POST /splat/worker/register` and `/splat/worker/heartbeat` — worker only, bound to one
  task/job/profile by a hashed per-job callback capability. Callback capabilities expire at the
  lease deadline and are revoked on terminal handoff.

## Recovery and logs

Records persist owner (username + tenant, never the token), job name/UUID and lifecycle. After
a restart nothing is resubmitted; an owner `sync` reconciles by unique job name. A submission
timeout/5xx is `submission_unknown`, never an automatic retry. Console output is read from the
run's shared output directory, so it remains available after the worker exits.

## Troubleshooting

- `signin_required` / 401: the Tapis session is invalid or expired for this tenant.
- `tapis_forbidden` / 403: Tapis denied the app, system or allocation.
- `capacity` / 429: another NodeSplat run is active.
- `invalid_callback` / 403: wrong job, expired lease, revoked or replayed capability.
