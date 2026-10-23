# Align NodeODX Tapis Registration with NodeODM

Status: Implemented

## Objective

Restore the Tapis application contract used by the previous NodeODM deployment and complete the matching ClusterODX worker lifecycle API. NodeODX jobs must receive the request-scoped Tapis JWT, register successfully with ClusterODX, and deregister without a cleanup `404`.

## User need

- **Primary user:** ClusterODX/NodeODX operator running Tapis jobs on LS6.
- **Secondary users:** WebODM users submitting photogrammetry tasks through the ClusterODX autoscaler.
- **Job-to-be-done:** Start and stop Tapis worker jobs without manually injecting credentials or cleaning stale nodes.
- **Current pain:** The packaged NodeODX app relied on the historical `TAPIS_ACCESS_TOKEN=${_tapisAccessToken}` mapping, but current Tapis leaves that macro literal, so registration receives `401 Tapis token or registration secret required`; cleanup then calls an endpoint ClusterODX does not expose and receives `404`.
- **Definition of success:** A newly deployed NodeODX job sends the Tapis bearer token to `/webhook/register-node`, ClusterODX accepts it, and the exit cleanup call to `/webhook/deregister-node` returns a successful response or an authenticated not-found response.

## Current code/system summary

- `nodeodx-ls6/nodeodx/app.json` defines the cleanup policy, while ClusterODX injects the request JWT into each submitted job because the historical Tapis token macro is not resolved.
- `nodeodx-ls6/nodeodx/tapisjob_app.sh` sends `TAPIS_ACCESS_TOKEN` or `_tapisAccessToken` as an `Authorization: Bearer` header when available and calls both registration and deregistration webhook paths.
- `ClusterODX/adminweb.js` has an authenticated `POST /webhook/register-node` route accepting a validated Tapis token or configured registration secret.
- ClusterODX exposes `POST /webhook/deregister-node` with the same authentication model as registration.
- `tapisJobOwner` and registration UUIDs are metadata and must not become standalone authentication factors.

## Proposed design

1. Preserve the existing cleanup environment variable and bump the app version. ClusterODX injects the request-scoped JWT into each job submission as `TAPIS_ACCESS_TOKEN`; the packaged app must not rely on the historical `${_tapisAccessToken}` macro because the current Tapis service leaves it literal.
2. Add `POST /webhook/deregister-node` to ClusterODX before admin middleware. It will:
   - accept node identification by `nodeId` or `hostname` plus `port`;
   - authenticate with a validated bearer Tapis token or the configured registration secret;
   - require a Tapis-authenticated caller to own the target node, using the existing node metadata/identity matching rules;
   - remove the node and persist node state;
   - return JSON success, `400` for missing identification, `401` for missing/invalid credentials, `403` for ownership failure, and `404` for an unknown node.
3. Add focused tests for the new route and update Tapis deployment documentation with the packaged app contract and lifecycle endpoints.

## Files likely affected

- `ClusterODX/adminweb.js`
- `ClusterODX/test/test-adminweb-auth.js` or a focused webhook test file
- `ClusterODX/docs/tapis.md`
- `nodeodx-ls6/nodeodx/app.json`
- `nodeodx-ls6/nodeodx/README-ZIP.md` if the app version/contract is documented there
- `nodeodx-ls6/nodeodx/nodeodx-ls6.zip` after rebuilding the package

## API/schema changes

Add `POST /webhook/deregister-node` with the existing registration authentication model. Request fields:

```json
{
  "hostname": "ls6.tacc.utexas.edu",
  "port": 60701,
  "nodeId": 1,
  "registrationUuid": "optional-correlation-id"
}
```

Authentication is supplied by `Authorization: Bearer <Tapis JWT>` or the configured registration secret in the request body. No persistent schema migration is required.

## Data flow

ClusterODX request JWT → Tapis job `parameterSet.envVariables.TAPIS_ACCESS_TOKEN` → NodeODX launcher → bearer-authenticated registration → ClusterODX validates token and matches pending job → node is added and task routed. On process exit, NodeODX sends the same bearer token and node identity to deregistration → ClusterODX validates ownership, removes the node, and persists `data/nodes.json`.

## Risks and tradeoffs

- Reusing a bearer token in the worker is required for the current hardened registration model; it must never be logged or placed in the node token field.
- Allowing `tapisJobOwner` alone would match the old insecure behavior but would permit forged registrations, so it remains metadata only.
- Deregistration by hostname/port can be ambiguous if duplicate nodes exist; `nodeId` is preferred when available.
- App version and ZIP publication must be updated together or Tapis may continue running the old contract.

## Alternatives considered

- **Restore owner-only authentication:** rejected because user IDs are forgeable and the current ClusterODX design intentionally requires proof of possession.
- **Configure a shared registration secret:** retained as a supported fallback, but not the primary Tapis app path because the ClusterODX submission already has the request-scoped JWT.
- **Remove NodeODX deregistration:** rejected because it leaves stale worker nodes and diverges from the previous lifecycle behavior.

## Test plan

- Validate the packaged app JSON has no unresolved token macro, preserves `NODEODX_CLEANUP_TASKS_AFTER=0`, includes the shared Corral import root, disables launch-file archiving, and has the bumped version. Validate the ClusterODX submission payload contains the exact request JWT under `TAPIS_ACCESS_TOKEN`.
- Run ClusterODX admin-web tests for missing credentials, invalid bearer token, valid registration secret, valid JWT ownership, owner mismatch, unknown node, and successful deregistration.
- Run existing ClusterODX test suite and `git diff --check`.
- Rebuild the NodeODX ZIP and run `unzip -tq`.
- Use a dry-run/local HTTP test for the deregistration endpoint; do not call live Tapis write APIs during tests.

## Documentation plan

Update `docs/tapis.md` to state that ClusterODX injects the request-scoped `TAPIS_ACCESS_TOKEN` and that both registration and deregistration require a bearer token or configured secret.

## Rollout/rollback plan

Deploy the new ClusterODX code first, publish the new NodeODX ZIP/app version second, and submit a small test job. Roll back by selecting the previous Tapis app version and reverting the ClusterODX commit if registration or node ownership checks fail. No data migration is required.

## Open questions

- The live Tapis app version must be confirmed after publication; local files alone do not change the registered Tapis app.
- The production nginx configuration must continue routing `/webhook` to the ClusterODX admin web port.

## Decisions

- Use the existing request-scoped Tapis JWT contract rather than reintroducing owner-only authentication.
- Implement deregistration in ClusterODX with the same credential and ownership model as registration.
- Keep the NodeODX node token separate from the Tapis bearer token.
- Preserve `tapisJobOwner`, `tapisJobOwnerTenant`, and registration UUID metadata on registered nodes so JWT deregistration can enforce ownership and support stable identifier lookup.
- Keep the deregistration response as JSON `200` for compatibility with the NodeODX cleanup client; malformed, unauthorized, forbidden, and unknown-node cases use `400`, `401`, `403`, and `404` respectively.

## Implementation result

- Packaged NodeODX app version `1.0.17` keeps task cleanup disabled with `NODEODX_CLEANUP_TASKS_AFTER=0` and adds the shared Corral import root; ClusterODX injects the actual request JWT into each Tapis job as `TAPIS_ACCESS_TOKEN`.
- ClusterODX now exposes authenticated `POST /webhook/deregister-node`, removes the node from persisted state, and asks the Tapis provider to terminate auto-spawned jobs when applicable.
- Added focused webhook coverage and included it in `npm test`.
- Rebuilt `nodeodx-ls6.zip` locally with `SKIP_UPLOAD=1`; live Tapis app registration and upload remain deployment steps.

### 2026-10-23 — Inject the request JWT at job submission

- **Decision:** Put the exact ClusterODX request JWT in the submitted job's `TAPIS_ACCESS_TOKEN` environment variable and remove the unresolved app-definition macro.
- **Reason:** The live job payload showed `${_tapisAccessToken}` unchanged, so NodeODX sent no usable bearer credential and ClusterODX correctly returned `401`.
- **Alternatives rejected:** Restoring owner-only registration would weaken the existing ClusterODM-compatible authentication contract; relying on the historical macro is incompatible with the current Tapis service.
- **User feedback:** User asked to align ClusterODX with the old ClusterODM behavior and confirm it works.
- **Impact on implementation:** ClusterODX provider job construction, NodeODX app JSON, tests, deployment docs, and local ZIP packaging are updated. Launch-file archiving is disabled to reduce token retention.

## User feedback / decisions

- User explicitly requested both fixes after reviewing the `401` registration and cleanup `404` errors.
