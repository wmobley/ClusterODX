# Tapis autoscaling boundary

ClusterODX now contains a configuration-driven Tapis ASR provider boundary for the
NodeODX application used on TACC systems. The boundary validates the deployment
contract, exposes Tapis queue/allocation/runtime/node options, and builds a
Tapis v3 job-submission payload without embedding credentials in configuration.

## Configuration

Pass an ASR JSON file with `--asr`. Keep the file private because it contains
deployment details, even though the Tapis token itself must be supplied at
runtime by the request/authentication path rather than stored in this file.

```json
{
  "provider": "tapis",
  "tapis": {
    "baseUrl": "https://portals.tapis.io",
    "tenantId": "portals"
  },
  "app": {
    "appId": "nodeodx-ls6",
    "appVersion": "1.0.17"
  },
  "system": {
    "executionSystemId": "ls6",
    "archiveSystemId": "ls6",
    "logicalQueue": "vm-small",
    "queueFilter": ["vm-small"]
  },
  "scheduler": {
    "defaultAllocation": "PT2050-DataX"
  },
  "job": {
    "maxJobTime": "01:00:00",
    "nodeCount": 1,
    "coresPerNode": 1,
    "memoryMB": 4096,
    "maxNodesPerJob": 1,
    "archiveOnAppError": true,
    "appArgs": [
      {
        "name": "cluster_control_url",
        "arg": "https://REPLACE_WITH_CLUSTERODX_HOST/webhook/register-node"
      },
      {
        "name": "cluster_control_host",
        "arg": "REPLACE_WITH_CLUSTERODX_HOST"
      },
      {
        "name": "cluster_control_port",
        "arg": "443"
      }
    ],
    "envVariables": []
  },
  "worker": {
    "registrationSecret": ""
  },
  "imageSizeMapping": [
    {
      "maxImages": 200,
      "nodeCount": 1,
      "logicalQueue": "vm-small",
      "coresPerNode": 16,
      "memoryMB": 30720,
      "maxJobTime": "04:00:00"
    },
    {
      "maxImages": 1000,
      "nodeCount": 2,
      "logicalQueue": "normal",
      "coresPerNode": 64,
      "memoryMB": 30720,
      "maxJobTime": "06:00:00"
    }
  ]
}
```

The provider accepts these task options:

- `tapis-queue`
- `tapis-allocation`
- `tapis-max-run-time`
- `tapis-node`

When task options are omitted, the provider publishes `defaultByImages` values
from `imageSizeMapping`. For example, a 468-image task receives the 1000-image
defaults: `normal`, two nodes, and 360 minutes. Explicit task options remain
overrides, so a caller that intentionally sends `tapis-node=1` or
`tapis-max-run-time=480` will still get those values.

For the current LS6 deployment, update the private runtime `tapis-config.json`
before restarting ClusterODX:

```json
{
  "app": {
    "appId": "nodeodx-ls6",
    "appVersion": "1.0.17"
  },
  "job": {
    "appArgs": [
      { "name": "cluster_control_url", "arg": "https://REPLACE_WITH_CLUSTERODX_HOST/webhook/register-node" },
      { "name": "cluster_control_host", "arg": "REPLACE_WITH_CLUSTERODX_HOST" },
      { "name": "cluster_control_port", "arg": "443" }
    ],
    "envVariables": []
  }
}
```

Merge these keys into the existing private file; do not replace its Tapis token
handling or commit the file. The callback host must be the real public
ClusterODX hostname. ClusterODX injects the request-scoped Tapis JWT into each
submitted job as `TAPIS_ACCESS_TOKEN`; do not add the historical
`${_tapisAccessToken}` macro to the app definition because current Tapis leaves
that value literal.

If Tapis returns `No more authentication methods available` while submitting a
job, the ClusterODX payload has already reached Tapis; repair the configured
`ls6` execution/archive-system credential or authentication method in Tapis.
That error is not fixed by changing the NodeODX app ID or resource mapping.

## Current status

The worker-registration slice is now wired. A Tapis-backed task is submitted
without input data, and the resulting worker can call
`POST /webhook/register-node` with `hostname`, `port`, `token`, and
`tapisJobUuid` (or the pending ClusterODX task UUID in `registrationUuid`).
ClusterODX validates the request-scoped Tapis token, forwards the staged task to
NodeODX, then adds the route and removes the pending task entry only after a
successful handoff.
The token is never written to the ASR configuration or log messages.

Worker registration requires either the request-scoped Tapis bearer token or a
configured shared secret. Set the latter with `registration-secret` in the
ClusterODX configuration, or with `worker.registrationSecret` in the Tapis ASR
configuration. UUIDs and owner fields are metadata, not authentication.

NodeODX shutdown uses `POST /webhook/deregister-node` with the same request-scoped
Tapis bearer token. The preferred payload is the `nodeId` returned by registration;
`registrationUuid`, or `hostname` plus `port`, are accepted as compatibility
identifiers. A valid JWT may deregister only a node whose recorded
`tapisJobOwner` matches the token username (and tenant when recorded). A configured
registration secret is a cluster-level fallback for workers that cannot receive a
Tapis token. Missing or invalid credentials return `401`, an ownership mismatch
returns `403`, an invalid payload returns `400`, and an unknown node returns `404`.
Successful deregistration returns JSON with `success: true` and removes the node
from the persisted registry; auto-spawned Tapis jobs are also asked to terminate.

The administrative web interface uses Tapis JWT authentication by default
(`admin-web-use-tapis-jwt: true`). It presents a token field, validates the
submitted bearer token through the Tapis provider, and keeps the token only in
tab-scoped sessionStorage after successful validation. Refresh restores and
revalidates it; logout, HTTP 401, or validation HTTP 401/403 clears it. Storage
failures fall back to memory-only login. Same-origin scripts can access this
storage; browsers may also copy it when duplicating tabs or restoring sessions. Optional `admin-web-allowed-tenants` and
`admin-web-allowed-users` configuration values restrict the accepted Tapis
identities. The administrative CLI remains protected by `admin-pass`. Set
`admin-web-use-tapis-jwt: false` to use that password for the web interface as
well. State-changing cross-origin requests are rejected.

## Admin task visibility

Authenticated administrators can use `GET /r/task/list` on the admin web service
to list all locally tracked tasks. It uses the same JWT/basic authentication as
`/r/node/list`; this is a cluster-wide administrative view. Responses are arrays
of summaries with `uuid`, `name`, `source`, `state`, `statusCode`, `imagesCount`,
`dateCreated`, `accessed`, `tapisJobId`, and `node` (`{hostname, port}` or null).
Dates are epoch milliseconds; unavailable metadata is null and missing names use
the UUID. Credentials, processing options, filesystem paths, and console output
are excluded. Responses use `Cache-Control: no-store`.

The task table updates at login, on Refresh, and with the optional five-second
auto-refresh. `submitting` means a local running task has no accepted Tapis UUID
yet; `waiting_registration` means the submitted job has a pending handoff;
`assigned` means a route exists. Neither waiting nor assigned confirms the
scheduler state or actual processing progress. Queued and locally recorded
terminal states are shown as such. A terminal local record takes precedence
over waiting/assigned observations. The endpoint makes no live Tapis or worker
requests, so routed task metadata and processing status can be unavailable.

Task rows exist only for local tasktable/routetable records: pending submissions
are process-local and lost on restart, and routes follow existing retention and
node-removal rules. This does not discover historical Tapis jobs. A pending
job can remain waiting if its callback URL/token or worker startup is incorrect.
Check the worker output for registration failures; configure the real ClusterODX
callback arguments rather than assuming the default hostname targets this instance.

## Handoff observability

Tapis job submission has a 60-second HTTP request timeout. A successful response
with a job UUID emits `[TAPIS] Job submission accepted` with the ClusterODX job
name, Tapis job UUID, HTTP status, and elapsed milliseconds. Failed requests and
responses missing a job UUID emit `[TAPIS] submit job failed`, including the
timeout and elapsed time. Acceptance means Tapis returned a UUID; worker
registration happens later. A timeout leaves acceptance uncertain: check Tapis
for the job name before resubmitting, since Tapis may still have created it.
ClusterODX does not automatically retry this submission.

ClusterODX and NodeODX emit allowlisted JSON log messages for the worker handoff.
They use the event name `odx_node_handoff` and phases including
`webhook_received`, `task_submit_started`, `task_submit_finished`, and
`task_received`. ClusterODX submission completion records the safe task/job/node
identifiers, `path_mode`, the configured timeout, elapsed time, HTTP status when
available, outcome, and a bounded error class. NodeODX records a `task_id` only
when the existing `set-uuid` header is a UUID.

These events do not record request headers, request bodies, URLs or query
strings, bearer/node tokens, or exception messages. Existing task, Tapis-job,
and node identifiers are the intended correlation keys; no new correlation
header or body field is added.

The Tapis application must be configured to start NodeODX and supply the
registration endpoint/job identifiers. The LS6 ZIP app preserves its first five
positional arguments; arguments 3–5 are named `cluster_control_url`,
`cluster_control_host`, and `cluster_control_port`. The runtime keeps the
legacy `CLUSTERODM_*` environment-variable aliases for compatibility, but the
callback target is the ClusterODX-compatible `POST /webhook/register-node`
endpoint. ClusterODX injects the request-scoped JWT as `TAPIS_ACCESS_TOKEN`;
the runtime sends it only as an Authorization bearer token. The
NodeODX token in the JSON `token` field is a separate node credential and is
not a substitute for the Tapis bearer.

Use `job.appArgs` and `job.envVariables` for that application-specific
contract; ClusterODX does not guess CLI argument names. `worker.registrationSecret`
is an optional fallback for deployments that cannot deliver the Tapis token to
the worker. It should be kept private.

The admin registration payload includes `hostname`, `port`, `token`, `uuid`,
`tapisJobUuid`, `nodeReady`, and worker metadata. ClusterODX authenticates the
bearer against the pending task, forwards the task to NodeODX, and only then
consumes the pending registration. Worker-role callbacks are treated as
ordinary node registrations and do not claim a pending Tapis task.

This adapter has local contract coverage, but no live Tapis submission or
multi-node registration has been run from this checkout. Keep it disabled for
production until the configured Tapis app, shared filesystem mapping, and
worker callback have passed an end-to-end LS6 test.

Run the local contract tests with:

```bash
for test_file in test/*.js; do node "$test_file" || exit 1; done
```

The repository's existing `npm test` script is still a placeholder and is not used by this
contract-test command.
