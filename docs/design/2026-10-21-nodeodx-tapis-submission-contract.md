# Align ClusterODX Tapis submissions with the NodeODX application contract

Status: Implemented

## Objective

Make ClusterODX submit Tapis jobs for the registered NodeODX application using the
same resource-selection and worker-registration contract documented and tested by
ClusterODX: `nodeodx-ls6` version `1.0.17`, the selected image-size mapping, and the
NodeODX registration arguments/environment.

## User need

**Primary user:** ClusterODX operator managing Tapis-backed processing jobs.

**Secondary users:** WebODM users submitting photogrammetry tasks; maintainers
debugging failed autoscaling submissions.

**Job-to-be-done:** Submit a task that creates the correctly sized NodeODX Tapis
worker and allows it to register back with ClusterODX.

**Current pain:** The runtime configuration still names the old NodeODM app, and
the generated job can ignore the image-size mapping. A 468-image task was planned
for two 64-core nodes but submitted with one 16-core node. The payload also lacks
the NodeODX registration arguments and worker environment.

**Definition of success:** A 468-image submission uses the 1000-image mapping
(two nodes, 64 cores per node, 30,720 MB, normal queue, six-hour limit), identifies
  `nodeodx-ls6:1.0.17`, includes the documented ClusterODX registration arguments,
and has regression tests covering the final payload.

## Current code/system summary

- `ClusterODX/libs/asr-providers/tapis.js` defaults to the portals tenant and
  `nodeodx-ls6:1.0.17` when no deployment-local override is supplied.
- The deployed `tapis-config.json` currently identifies `nodeodm-ls62:1.0.14`.
- `calculateNodeSubmissionPlan` allows `tapis-node` to override the image mapping.
- `submitJobWithoutData` allows request `tapis-max-run-time` to override the
  mapping and submits configured app arguments/environment only.
- The repository’s `ClusterODX/docs/tapis.md` and provider test identify the
  NodeODX application as `nodeodx-ls6:1.0.17`.
- The same documentation defines `cluster_control_url`, `cluster_control_host`,
  and `cluster_control_port` as the registration arguments.
- The live `tapis-config.json` is deployment-local and is not part of this repo;
  it must be updated separately during rollout.

## Proposed design

1. Change the provider fallback application identity to `nodeodx-ls6:1.0.17`.
2. Publish image-size mapping defaults through the Tapis task-option metadata so
   the caller receives the correct defaults for the image count. Preserve explicit
   task options as overrides, matching the existing ClusterODM behavior; an
   explicitly supplied `tapis-node` or `tapis-max-run-time` remains authoritative.
3. Use the configured NodeODX app arguments and environment variables verbatim.
   For this deployment, the runtime config must provide the documented
   `cluster_control_url`, `cluster_control_host`, and `cluster_control_port`
   arguments. ClusterODX will not invent production callback URLs or legacy
   NodeODM environment variables.
4. Extend sanitized submission diagnostics to log the final app identity, mapping,
   option resolution, and resource plan without logging tokens or credential values.
5. Update the deployment configuration documentation and tests. Do not
   commit production tokens or the private runtime configuration.

The exact 468-image default is the 1000-image mapping:

```text
appId/version: nodeodx-ls6 / 1.0.17
queue:         normal
nodeCount:     2
coresPerNode:  64
memoryMB:      30720
maxMinutes:    360
```

The current request options `tapis-node=1` and `tapis-max-run-time=480`, if
explicitly supplied by the caller, remain valid overrides. The fix ensures the
UI/task-option defaults come from the image mapping instead of falling back to
the base one-node/two-hour configuration.

## Files likely affected

- `libs/asr-providers/tapis.js`
- `test/test-tapis-provider.js`
- `docs/tapis.md`
- `docs/design/2026-10-21-nodeodx-tapis-submission-contract.md`

The deployment-local `/home/wmobley/ODM-SUITE/ClusterODX/tapis-config.json` will
require an operational update after the code change; it is not a tracked source
file in this checkout.

## API/schema changes

The Tapis job submission remains `POST /v3/jobs/submit`. Its app identity,
resource fields, and configured `parameterSet.appArgs`/`parameterSet.envVariables`
will be corrected. No new ClusterODX HTTP endpoint is planned.

## Data flow

Task image count and options → image-size mapping/precedence resolution → final
NodeODX Tapis job payload → Tapis job submission → NodeODX worker starts → worker
calls ClusterODX registration endpoint → ClusterODX records the worker route.

## Risks and tradeoffs

- Publishing mapping defaults must not break callers relying on explicit
  `tapis-node` or `tapis-max-run-time` overrides; precedence is explicit and
  covered by tests.
- The Tapis system credential failure (`No more authentication methods available`)
  is external to payload construction and may remain after this change.
- Changing the app ID/version requires the corresponding app to exist and be
  enabled in the `portals` tenant.
- Callback metadata must not contain bearer tokens.

## Alternatives considered

- Only changing `tapis-config.json`: rejected because the provider fallback and
  payload construction would still be wrong.
- Keeping `nodeodm-ls62`: rejected because ClusterODX workers use NodeODX and the
  repository’s integration contract names `nodeodx-ls6:1.0.17`.
- Fixing Tapis system credentials in code: rejected because credentials are owned
  by the Tapis system/Security Kernel and must not be embedded in ClusterODX.

## Test plan

- Add/update provider tests for the NodeODX app identity.
- Assert a 468-image option response publishes the 1000-image mapping defaults.
- Assert an explicit node/runtime override remains honored.
- Assert configured NodeODX registration arguments are preserved and correctly
  named, and sensitive values remain absent from diagnostics.
- Preserve tests for explicit supported queue/allocation behavior.
- Run the focused provider test, then the full ClusterODX test command.

## Documentation plan

Update the Tapis integration documentation and sample configuration to show the
NodeODX app identity, callback arguments, resource-mapping behavior, and the fact
that the live Tapis config is deployment-local and must not contain tokens.

## Rollout/rollback plan

Before restart, back up the deployment-local `tapis-config.json` and validate its
JSON. Update only the app identity and approved NodeODX settings, restart
ClusterODX, and inspect the sanitized submission log. Roll back by restoring the
previous runtime config and reverting the code commit if the NodeODX app or
registration contract is unavailable. Do not submit a live Tapis job as part of
local tests.

## Open questions

- Does the production NodeODX app require any additional positional arguments or
  environment variables beyond the documented registration contract? The code
  will preserve any values supplied in the deployment-local config.

## Decisions

- Use the repository-documented NodeODX identity `nodeodx-ls6:1.0.17` as the target
  application contract.
- Preserve explicit Tapis task-option overrides while publishing mapping-based
  defaults for image-count-aware UI/task creation.
- Keep production credentials and the deployment-local Tapis config out of git.
- Treat the Tapis system authentication failure as a separate operational issue.

### 2026-10-21 — Implementation completed

- **Result:** The provider fallback now targets `https://portals.tapis.io`,
  publishes image-count defaults, submits `nodeodx-ls6:1.0.17`, preserves the
  configured NodeODX callback arguments/environment, and emits sanitized
  submission-plan diagnostics.
- **Deviation:** The private deployment-local `tapis-config.json` was not
  changed because it is outside this checkout. The operator must merge the
  documented app identity and NodeODX callback settings before restart.
- **Verification:** Focused provider, option, config-contract, and observability
  tests pass. The full `npm test` command remains blocked in this sandbox by its
  first localhost listener failing with `listen EPERM`.

### 2026-10-21 — NodeODX configuration is authoritative for app arguments

- **Decision:** Preserve `job.appArgs` and `job.envVariables` from the runtime
  configuration rather than hard-coding legacy ClusterODM arguments or environment
  variables.
- **Reason:** ClusterODX documentation defines the NodeODX callback contract and
  explicitly says the provider does not guess application-specific argument names.
- **Alternatives rejected:** Copying the old NodeODM payload verbatim was rejected
  because it would hard-code a ClusterODM callback and legacy worker variables.
- **User feedback:** User requested that the Tapis config use the NodeODX app and
  that the complete submission be updated.
- **Impact on implementation:** The deployment-local config must contain the three
  documented callback arguments; source code will preserve configured arguments and
  will not add credentials or production URLs.

## User feedback / decisions

- User requested that ClusterODX be updated to submit the correct NodeODX Tapis
  information and use the NodeODX app instead of the old NodeODM app.
- User said “ok up date it all,” authorizing implementation of the approved scope.
