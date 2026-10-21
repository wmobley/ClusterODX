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
    "baseUrl": "https://tacc.tapis.io",
    "tenantId": "tacc"
  },
  "app": {
    "appId": "nodeodx-ls6",
    "appVersion": "2.3.1"
  },
  "system": {
    "executionSystemId": "CHANGEME",
    "archiveSystemId": "CHANGEME",
    "logicalQueue": "vm-small",
    "queueFilter": ["vm-small"]
  },
  "scheduler": {
    "defaultAllocation": "CHANGEME"
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
        "arg": "https://REPLACE_WITH_CLUSTERODX_HOST"
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
      "logicalQueue": "vm-small"
    }
  ]
}
```

The provider accepts these task options:

- `tapis-queue`
- `tapis-allocation`
- `tapis-max-run-time`
- `tapis-node`

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
configuration. UUIDs and owner fields are metadata, not authentication. The
admin web interface also requires `admin-pass`; passwordless administrative
access is disabled, and state-changing cross-origin requests are rejected.

## Handoff observability

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
endpoint. `TAPIS_ACCESS_TOKEN=${_tapisAccessToken}` must be injected by the
Tapis app; the runtime sends it only as an Authorization bearer token. The
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
