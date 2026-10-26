# Admin JWT persistence across refresh

## Status
Implemented

## Objective
Keep the ClusterODX admin login when the user refreshes the current browser tab.

## User need
The user selected ClusterODX only and current-browser-tab persistence.

## Current code/system summary
`public/common.fetch.js` holds the JWT only in a module variable. `public/app.mjs`
validates manually entered or URL-fragment tokens through `/r/auth/validate`.
Refreshing discards the token. Logout and HTTP 401 responses clear it.

## Proposed design
Store a successfully validated JWT in `sessionStorage` under a ClusterODX-specific
key. On page load, prefer a supplied URL-fragment token; otherwise restore the
saved JWT and validate it through the existing endpoint before showing the admin
dashboard. Keep the existing bearer-header transport. Clear both memory and
storage on logout and HTTP 401; clear a restored token on validation rejection.
Transient network/server errors retain the saved token for a later refresh.
Catch storage-access errors and retain the existing in-memory login behavior.
Guard asynchronous validation attempts so stale responses cannot overwrite a newer
login or restore authentication after logout. Remove consumed fragment tokens from
the URL using the existing helper. Validation HTTP 401/403 clears saved credentials.
Do not store passwords or add token refresh, cookies, or server changes.

## Files likely affected
- `public/common.fetch.js`: store/clear the validated JWT and expose guarded retrieval.
- `public/app.mjs`: restore and revalidate login on startup.
- `test/test-admin-session-token.js`: browser-storage and restoration regression coverage.
- `package.json`: include the focused test.
- `docs/tapis.md` and `README.md`: describe persistence and logout behavior.

## API/schema changes
No server API or persisted server schema changes. One browser session-storage key.

## Data flow
Login token → server validation → memory and tab storage → refresh → retrieve
token → server validation → authenticated dashboard. Logout/401 clears both stores.

## Risks and tradeoffs
Same-origin scripts can read sessionStorage, so XSS could expose the JWT. Storage
is limited to the browser tab session rather than durable localStorage. Browsers
may copy sessionStorage when duplicating tabs or preserve it during session restore.
JWT expiry remains enforced by the server. No credentials enter logs or URLs.

## Alternatives considered
- localStorage: unnecessary persistence beyond the requested tab session.
- Server cookie sessions: broader authentication redesign than this request requires.
- Memory only: loses login on refresh.

## Test plan
Test saving/restoring, logout removal, 401 removal, unavailable storage fallback,
fragment-token precedence, restoration validation, and rejected-token cleanup.
Include a stale-validation-response regression test.
Run the full existing npm test suite and git diff --check. No live credentials needed.

## Documentation plan
Replace the existing memory-only statement with tab-session persistence and its
logout/expiry behavior in ClusterODX documentation.

## Rollout/rollback plan
Deploy static UI changes and refresh the page. Rollback restores memory-only
login; clear the browser key when rolling back. No server migration is required.

## Open questions
None.

## Decisions
### 2026-10-26 — Scope and lifetime
- Decision: ClusterODX only, using sessionStorage.
- Reason: Preserve login across refresh within the requested tab lifetime.
- Alternatives rejected: ClusterODM changes and durable localStorage.
- User feedback: Selected “ClusterODX only — current browser tab”.
- Impact on implementation: ClusterODX static UI, tests, and documentation only.

## User feedback / decisions
User approved implementation on 2026-10-26: “do it”.
Focused security review recommends approval with stale-validation protection,
which is included above.

### 2026-10-26 — Implementation approval
- User approved the reviewed design and implementation plan.
- Token lifecycle helpers will live in existing `public/authToken.mjs` for direct test coverage.

### 2026-10-26 — Completion
- Implemented approved behavior; lifecycle helpers reside in existing authToken.mjs.
- Full npm test suite, JavaScript syntax check, and git diff --check passed.
- Reviewed logout, rejected validation, storage failures, and stale responses.
- Documentation updated. No deployment or live-token browser test performed.
