# Shared-secret NodeODX registration

## Status
Implemented — local source changes and tests complete on 2026-10-28; deployment authorized on 2026-10-28; rollout in progress.

## Objective
Allow NodeODX registration and deregistration with a configured cluster registration secret when a Tapis access token expires.

## User need
Queued LS6 allocations must be able to join ClusterODX and receive their pending task without depending on the submission token remaining valid.

## Current code/system summary
ClusterODX accepts a secret for ordinary workers, but rejects secret-authenticated primary registrations. The NodeODX launcher sends only a Tapis bearer. A supplied bearer takes precedence over a secret. Pending primary tasks record their submitted Tapis job ID and tenant-qualified owner. Registration claims protect concurrent handoffs. The existing secret already grants cluster-level deregistration authority.

## Proposed design
Add worker.allowSharedSecretPrimaryRegistration, default false. Only forward the configured cluster secret to jobs when this trusted-cluster mode is enabled. Resolve secret precedence consistently as global registration_secret then ASR worker.registrationSecret. Reject ownerless pending primary records before mutation. Bind sibling workers claiming a Tapis job to canonical ownership from exact pending or active allocation state, supporting either arrival order. Preserve legacy ordinary-worker secret behavior when this mode is disabled. Use explicit secret authentication when the launcher receives NODEODX_REGISTRATION_SECRET, omitting the Tapis bearer in that mode. Forward the configured ASR worker.registrationSecret to launched jobs through that environment variable, replacing caller-provided values. Require the primary's tapisJobUuid to exactly match a pending record's tapisJobId for secret authentication; never use owner or task-ID fallback. Derive node ownership from the pending record. Preserve existing JWT checks, task claim locking, handoff rollback, and worker behavior. Send the secret during deregistration too. Never print the secret or include it in persisted retry payloads or manual command output. No anonymous authentication or automatic fallback from an invalid bearer.

## Files likely affected
ClusterODX/adminweb.js; ClusterODX/libs/asr-providers/tapis.js; ClusterODX/test/test-webhook-registration.js; ClusterODX/test/test-tapis-provider.js; ClusterODX/docs/tapis.md; nodeodx-ls6/nodeodx/tapisjob_app.sh; launcher tests under nodeodx-ls6/tools; nodeodx-ls6/nodeodx/README-ZIP.md; DSO-Architecture/docs/services/clusterodm.md and docs/dev/environment-variables.md.

## API/schema changes
Existing registrationSecret JSON field becomes valid for task-bound primary registration with exact job correlation. Existing worker.registrationSecret setting also supplies NODEODX_REGISTRATION_SECRET to jobs. No database schema change.

## Data flow
Operator configures a secret in the ASR configuration; ClusterODX injects it into the Tapis job environment; launcher sends it over HTTPS for registration and cleanup. Primary registration resolves exactly the submitted job ID and copies trusted ownership from pending state.

## Risks and tradeoffs
The shared secret is cluster-level authority: any holder can register a node for a known pending job. It is visible to job owners through their execution environment. Use only in trusted clusters; leaving the setting empty retains JWT-only primary registration. A per-job credential would provide stronger isolation but is outside this shared-secret change. Expired Tapis tokens may still prevent job cancellation or other Tapis operations. Existing failed-registration idle behavior is unchanged.

## Alternatives considered
Anonymous registration rejected. Removing JWT checks without exact job correlation rejected. Automatic fallback from invalid JWT rejected. Per-job credentials deferred as a stronger alternative requiring a different credential lifecycle.

## Test plan
Local webhook tests must accept a matching secret and exact pending Tapis job ID; reject wrong/missing secrets and task-ID-only matches; preserve JWT ownership rejection, concurrency protection, and rollback. Provider tests verify configured secret injection and replacement of supplied env values without logging values. Launcher checks verify bearer omission in secret mode, registration and cleanup secret use, and redacted persisted retry artifacts. Run ClusterODX tests, launcher checks, and git diff --check. No live writes.

## Documentation plan
Document opt-in shared-secret configuration, cluster-level trust, exact-job requirement, bearer precedence, launcher environment, and limits on expired-token Tapis operations. Updated the DSO service and environment-variable pages in /Users/wmobley/Documents/Github/DSO-Architecture; the configured volume path was unavailable. No documentation commit or push performed.

## Rollout/rollback plan
Local edits and tests only. Deployment, app publication, secret provisioning, and live submissions require separate authorization. Deploy compatible ClusterODX before the launcher. Disable the shared secret to restore JWT-only primary registration.

## Open questions
Production secret provisioning is not part of the local implementation. Production opt-in requires trusted job owners; local implementation leaves it disabled.

## Decisions
- 2026-10-28: User selected shared-secret registration and explicitly said to implement. Preserve authentication; do not add anonymous registration.
- 2026-10-28: Inspection found that primary registration explicitly rejects shared secrets; document this change in authorization rather than presenting it as launcher configuration alone.

- 2026-10-28: Security and design reviews required an additional default-off primary-registration opt-in, consistent secret precedence, ownerless-record rejection, and trusted sibling identity binding. Incorporated before implementation. Cluster-level authority remains an explicit trusted-cluster limitation.

- 2026-10-28: QA identified a completed-registration retry regression. Added exact-job/same-endpoint replay acceptance and regression tests proving no duplicate submission.
- 2026-10-28: Validation: full ClusterODX npm test passed; affected webhook/provider tests passed again after the retry fix; six launcher multi-node/auth tests and four capacity tests passed; Bash syntax and both repository diff checks passed. Tests use local HTTP/mocked curl only.
- 2026-10-28: Source changes complete. Existing modified nodeodx-ls6.zip was preserved; it has not been rebuilt or published for this change. Rollout still needs updated launcher packaging and production provisioning. No other implementation deviations.

## User feedback / decisions
User: “lets do that”, followed by “do it”, approving the shared-secret implementation described in chat. No production write or deployment authorized.

### 2026-10-28 - Deployment authorized

- User explicitly requested commit, push and TACC deployment after being told those steps remained outstanding.
- Plan: preserve local and remote ZIP backups, rebuild existing 1.0.18 launcher package, push the existing upgrade branches, fast-forward clean production ClusterODX, back up private config, provision a random effective secret and enable the trusted-cluster opt-in, restart through the existing helper, verify hashes and callback authentication. No Slurm submission or cancellation.
- Preflight: no Slurm jobs; ClusterODX queue count zero; saved worker endpoints offline; remote tracked tree clean and HEAD matches local base ae5f6d6. Deployment uses mutually trusted job owners as documented.
