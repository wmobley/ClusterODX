# ClusterODX JWT-only admin web authentication

Status: Implemented

## Objective

Make the ClusterODX admin web interface authenticate with a user-supplied Tapis JWT instead of HTTP Basic Auth when `admin-web-use-tapis-jwt` is enabled.

## User need

- **Primary user:** ClusterODX operator using the TACC/Tapis deployment.
- **Secondary users:** Authorized Tapis users who administer nodes through the web interface.
- **Job-to-be-done:** Open the admin web interface, paste a valid Tapis JWT, and manage ClusterODX nodes.
- **Current pain:** The web interface prompts for a Basic Auth password, while the deployment's intended credential is a Tapis JWT; the configured JWT flag has no effect.
- **Definition of success:** The web UI presents a JWT entry form, accepts a valid Tapis token, rejects invalid or disallowed tokens, and allows authenticated admin actions without a Basic Auth prompt.

## Current code/system summary

`adminweb.js` currently protects the entire web interface with `express-basic-auth` when `options.password` is present and returns `503 Admin authentication is not configured` otherwise. `config.js` parses `admin-web-use-tapis-jwt`, `admin-web-allowed-tenants`, and `admin-web-allowed-users`, but `adminweb.js` does not use them. Tapis token validation already exists on the Tapis provider through `validateToken(token)`. The browser UI calls `/r/*` endpoints directly and has no login state or token-entry screen.

## Proposed design

When `admin-web-use-tapis-jwt` is true:

1. Serve the static admin shell without Basic Auth so it can display the login form.
2. Add `POST /r/auth/validate`. The browser sends the pasted JWT only in an `Authorization: Bearer` header. The server validates it through the configured Tapis provider and applies the optional tenant/user allowlists after successful provider validation.
3. Keep the JWT only in the browser's in-memory application state. Do not put it in a cookie, localStorage, sessionStorage, URL, response body, or log message.
4. Require a valid bearer token on every other `/r/*` admin API request. The token is revalidated through the provider on each request, so Tapis token expiration is honored without a separate server-side session lifetime.
5. Add a client-side logout action that clears the in-memory token and returns to the token form. No server-side logout endpoint is needed.
6. Update the browser client to show the JWT form until validation succeeds, add the bearer header to all admin API requests, and return to the form after a `401`.
7. If the page URL contains `#token=<JWT>`, consume the fragment in the browser, remove it from the address bar with `history.replaceState`, and run the same bearer-token validation flow automatically. A failed validation still returns to the visible JWT form.
7. Preserve the existing Basic Auth behavior when `admin-web-use-tapis-jwt` is false. The admin CLI remains independently password-protected and is not changed by this design.

The Tapis provider must be initialized before a JWT request can succeed; missing provider configuration or provider unavailability fails closed with a generic `503`. Invalid or expired tokens return `401`; valid tokens that fail a configured tenant/user allowlist return `403`. Existing same-origin checks remain in force for state-changing requests, and bearer headers are not logged.

## Files likely affected

- `adminweb.js` — JWT validation middleware, bearer auth mode, allowlist checks, and auth-mode selection.
- `index.js` — pass JWT mode and allowlists into the admin-web factory.
- `restart.sh` — do not require `admin-pass` when JWT web mode is enabled.
- `public/app.mjs` — login form and in-memory authenticated application state.
- `public/authToken.mjs` — safe extraction and immediate removal of hash-provided JWTs.
- `public/common.fetch.js` — bearer-header handling and auth failure handling.
- `public/component/header.mjs` — client-side logout action.
- `test/test-adminweb-auth.js` — JWT login/session/logout and Basic Auth compatibility coverage.
- `docs/tapis.md` and `README.md` — operator configuration and usage.

## API/schema changes

- `POST /r/auth/validate`: accepts no body; requires `Authorization: Bearer <Tapis JWT>`; returns `200` on success or `401/403/503` on invalid, disallowed, or unavailable credentials. The JWT is never returned.
- Existing `/r/*` admin endpoints require the bearer token in JWT mode.
- No persistent schema or database changes.

## Data flow

Browser JWT form → `Authorization: Bearer` validation request → Tapis provider token validation → optional tenant/user allowlist check → in-memory browser token → bearer-authenticated `/r/*` requests.

## Risks and tradeoffs

- The browser holds the JWT in memory and sends it on each admin request; this is the direct bearer-token model requested by the user and avoids server-side session state.
- The server revalidates each request, which adds Tapis network latency and load but naturally honors JWT expiration and avoids a second session lifetime.
- Static assets become publicly readable, while administrative data and mutations remain protected by the API middleware.
- Tapis validation introduces a network dependency at login; failed validation must fail closed.

## Alternatives considered

- **Basic Auth password:** rejected because it does not match the deployment's Tapis authentication model.
- **Server-side session after login:** rejected for this request because it adds cookie/session-secret/CSRF lifecycle complexity; direct bearer requests keep the requested JWT behavior explicit and avoid token/session expiry mismatch.
- **Persist sessions in a database or shared cache:** rejected as unnecessary for the current single-process deployment and broader in operational scope.

## Test plan

- Verify JWT mode serves the login shell without a Basic Auth challenge.
- Verify valid Tapis tokens validate and authorize `/r/info` and a state-changing endpoint.
- Verify invalid or expired tokens receive `401`.
- Verify configured tenant/user allowlists reject unauthorized claims.
- Verify client logout clears the in-memory token and returns to the login form.
- Verify `#token=<JWT>` is consumed client-side, removed from browser history, and sent only as a bearer header to `/r/auth/validate`.
- Verify JWTs do not appear in response bodies or captured logs.
- Preserve existing Basic Auth and unconfigured-auth tests when JWT mode is disabled or unavailable.
- Run all ClusterODX contract tests.

## Documentation plan

Document `admin-web-use-tapis-jwt`, the login flow, allowlist settings, and the separate admin CLI password behavior in the Tapis deployment documentation and README.

## Rollout/rollback plan

Deploy the code and restart ClusterODX with `admin-web-use-tapis-jwt=true` and a working Tapis ASR configuration. Confirm `/r/auth/validate` and the admin UI through the public endpoint. Roll back by restoring the previous ClusterODX revision and restarting with `admin-pass` configured; no persistent data migration is involved.

## Open questions

The deployment must decide whether empty allowlists mean “any valid Tapis token” or whether an explicit allowlist is required. The implementation preserves the existing configuration semantics: empty lists do not restrict a valid token; populated lists are enforced against validated Tapis claims.

## Decisions

### 2026-10-21 - Use direct bearer-token admin requests

- **Decision:** Use a pasted Tapis JWT for validation and send it as a bearer token on each admin API request, keeping it only in browser memory.
- **Reason:** This is the behavior the user explicitly requested and avoids introducing server-side sessions, cookie secrets, and session expiry semantics.
- **Alternatives rejected:** Basic Auth and a server-side session after login.
- **User feedback:** User explicitly requested that the login ask for the JWT token and said to fix it.
- **Impact on implementation:** The web auth middleware and browser client both need changes; the admin CLI remains separate.

### 2026-10-21 - Restore hash-token auto-login

- **Decision:** Support `#token=<JWT>` links by consuming the fragment in the browser and reusing the existing bearer validation flow, then removing the fragment from the visible URL.
- **Reason:** The approved JWT admin flow documented hash-token auto-login, but the current ClusterODX shell only rendered the paste form and ignored the fragment.
- **Alternatives rejected:** Sending the token as a query parameter or serving it to the backend from the initial page request, because URL queries and server requests are more likely to be logged or retained.
- **User feedback:** User explicitly requested fixing the URL token behavior.
- **Impact on implementation:** Add `public/authToken.mjs`, invoke it from `public/app.mjs`, and cover extraction/removal behavior with `test/test-admin-url-token.js`.

## User feedback / decisions

The user approved implementation by requesting “fix it” after the JWT-only flow was proposed. Focused reviewers agreed that the direct bearer model is the smallest implementation matching that requirement, while requiring explicit `401/403/503` behavior, no token logging/storage, and preserved Basic Auth compatibility.

Implementation completed with the JWT login form, bearer propagation, provider validation, allowlist checks, restart-helper support, Basic Auth compatibility, and updated operator documentation. The full ClusterODX test suite passes.
