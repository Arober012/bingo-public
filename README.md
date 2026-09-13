# Twitch Bingo Overlay Monorepo

This workspace contains a hybrid Twitch Bingo implementation:

- apps/controller: authoritative game server, mod/player command API, Twitch integration surface.
- apps/overlay: OBS browser source overlay for on-stream visuals.
- apps/viewer: viewer-facing card UI.
- apps/control: mod/broadcaster control UI for round lifecycle and option management.
- packages/game-core: shared bingo rules, card generation, and validation logic.

## Prerequisites

- Node.js 22+
- npm 10+

## Setup

1. Install dependencies:

   npm install

2. Copy environment values:

   copy .env.example .env

3. Start all apps in development mode:

   npm run dev

## Multi-tenant rollout (Phase 0)

Controller now supports tenant-scoped runtime state and persistence behind feature flags.

- MULTI_TENANT_ENABLED (default false): enables tenant-prefixed API routing mode.
- LEGACY_SINGLE_TENANT_FALLBACK (default true): when multi-tenant mode is on, keeps existing /api/* routes active for compatibility.
- DEFAULT_TENANT_SLUG (optional): explicit default tenant; otherwise derived from TWITCH_BROADCASTER_ID.

Tenant-prefixed routes use this shape:

- /api/t/<tenant-slug>/*

Current behavior:

- Any valid tenant slug in a tenant-prefixed route resolves to an isolated in-memory/runtime state and its own persisted state file.
- Legacy /api/* routes still bind to the default tenant slug.
- When MULTI_TENANT_ENABLED=true and LEGACY_SINGLE_TENANT_FALLBACK=false, legacy /api/* routes return legacy_api_route_disabled (HTTP 410) so clients must use tenant-prefixed routes.
- Frontend apps (overlay/viewer/control) now support tenant-aware API routing when tenant is present in URL query (`?tenant=<slug>`) or path (`/t/<slug>/...`).
- If no tenant is present, frontend apps continue using legacy `/api/*` routes for backward compatibility.

## Public clone isolation (Railway + Firebase)

This clone is intentionally isolated from the existing Bingo production infrastructure.

- Railway for this clone is linked to a separate project created with railway up --new:
   - Project: BINGO - Public (id 86250963-8b81-427e-b4d1-00632a6b36c2)
   - Service: BINGO - Public (id eac8542e-ffde-4de3-8c4a-36b462901c6a)
- Firebase in this clone now uses a separate local .firebaserc mapping with public placeholder IDs:
   - Project id: stream-bingo-public-dev
   - Hosting sites: stream-bingo-public-overlay, stream-bingo-public-viewer, stream-bingo-public-control
- .firebaserc.PROD-LOCK remains a reference snapshot of the existing production mapping and should not be used for deploys from this clone.

When you are ready to use real public Firebase infrastructure, replace the placeholder project and site IDs in .firebaserc with your new Firebase project/sites before deploying.

## Dependency security maintenance

- Runtime-focused audit check (recommended for deploy gates):

   npm audit --omit=dev --json

- Full workspace audit check (includes dev tooling):

   npm audit --json

- ws is pinned to a patched version for controller/tmi.js compatibility:
    - root overrides enforce ws=8.21.1
    - controller explicitly depends on ws ^8.21.1

- If a dev-only brace-expansion advisory reappears in full audit output, refresh transitive lockfile entries with:

   npm update brace-expansion

## Controller command bridge

The controller can ingest Twitch chat commands directly via TMI when these environment variables are set:

- TWITCH_BOT_USERNAME
- TWITCH_BOT_OAUTH (token value or oauth:token)
- TWITCH_CHANNEL or TWITCH_CHANNELS (comma separated)
- CONTROLLER_STATE_FILE (optional, defaults to ./data/controller-state.json)
   - Railway recommendation: set to /data/controller-state.json so state is written to the mounted persistent volume.
- STAMP_IDEMPOTENCY_TTL_MS (optional, default 21600000)
- STAMP_IDEMPOTENCY_MAX_RECORDS (optional, default 2000)
- WINNER_GRACE_PERIOD_SECONDS (optional, default 30)
- VIEWER_INVITE_TOKEN_TTL_MS (optional, default 28800000 / 8h)
- VIEWER_AUTH_TOKEN_TTL_MS (optional, default 86400000 / 24h)
- TWITCH_OAUTH_STATE_TTL_MS (optional, default 600000 / 10m)
- MOD_CONTROL_TOKEN (optional legacy bearer fallback for mod routes)

If credentials are not configured, controller still runs and command handling remains available through HTTP.

## Chat commands (currently active)

Moderator-only commands:

- !start bingo [mode] [maxWinners] [winnerGraceSeconds]
- !reset board
- !stop bingo
- !call option text
- !uncall option text
- !options list
- !options set value one|value two|value three
- !options add value text
- !options remove value text

Player commands:

- !join
- !stamp option text (stamps only; does not auto-claim a win)
- !bingo (explicitly claims bingo after your stamped pattern is valid)
- !card

Chat-command ideas that are not active yet (intentionally commented out):

<!-- - !continue blackout -->
<!-- - !continue blackout reset-winners -->

HTTP command bridge endpoint:

- POST /api/chat/command with payload:
   - command: chat command text
   - userId: viewer id
   - userName: viewer display name
   - isMod: optional moderator flag

## Phase 3 persistence

- Controller now persists session state, player cards/stamps, option pool, and audit history to disk.
- State is restored on startup so active rounds survive process restarts.
- Moderator audit trail endpoint: GET /api/mod/audit (mod auth required).
- Stamp endpoint idempotency is enabled via request body idempotencyKey or Idempotency-Key header.
- Repeat submissions with the same key, user, and session replay the original response with idempotentReplay: true.
- Internal redeem joins are replay-safe per session + redemptionId and will return idempotentReplay when retried.

## Mod control API additions

- GET /api/mod/state (mod auth required): control dashboard summary (session + pool stats + winner config).
- GET /api/mod/options (mod auth required): option pool entries with enabled states.
- POST /api/mod/options (mod auth required): add a pool item ({ label, enabled? }).
- PATCH /api/mod/options/:optionId (mod auth required): edit label and/or enabled flag.
- DELETE /api/mod/options/:optionId (mod auth required): remove option item.
- POST /api/mod/start (mod auth required): starts round with optional { mode, options, maxWinners, winnerGraceSeconds }.
- POST /api/mod/session/new (mod auth required): force fresh session id/cards using enabled pool, optional { mode, maxWinners, winnerGraceSeconds }.
- POST /api/mod/session/reset-board (mod auth required): keep current cards/session and clear called options, winner flags, and non-free stamps.
- POST /api/mod/session/continue-blackout (mod auth required): continue an open/running session into blackout while preserving session id/cards/stamps/called options; optional { resetWinnerLedger }.
- POST /api/mod/uncall (mod auth required): remove a mistakenly called option and revoke matching stamps when no winners are recorded.
- POST /api/mod/testing/viewer-link (mod auth + backend testing allowlist required): generates an owner testing viewer URL with viewer auth for the signed-in moderator identity.
- GET /api/overlay/winner-card (public): returns the leading winner card for overlay rendering.
- POST /api/player/claim (viewer auth required): explicit bingo claim endpoint; server validates stamps against active mode and awards winners.

Viewer auth recovery note:

- Viewer callback redirects preserve invite context so refresh-based auth recovery can re-enter Twitch sign-in without requiring immediate new redeems when the invite is still valid.

## Moderator auth model (Twitch-native)

Use Twitch session auth as the primary control-plane auth model:

1. Configure required env vars on the controller:
   - TWITCH_CLIENT_ID
   - TWITCH_CLIENT_SECRET
   - TWITCH_BROADCASTER_ID
   - Optional: TENANT_BROADCASTER_OVERRIDES (JSON map of tenant slug -> broadcaster user id)
   - Optional: TENANT_BROADCASTER_AUTO_REGISTER=true to allow first successful mod sign-in on an unmapped tenant to claim tenant -> broadcaster mapping
   - Optional: MOD_TESTING_ALLOWLIST (comma-separated Twitch user IDs or userLogins allowed to use /api/mod/testing/viewer-link)
   - MOD_AUTH_SESSION_SECRET
   - PUBLIC_API_BASE_URL or TWITCH_MOD_REDIRECT_URI
   - Optional: MOD_AUTH_COOKIE_DOMAIN for shared auth cookies across subdomains
   - Broadcaster resolution order is tenant override first, then TWITCH_BROADCASTER_ID fallback.
2. Moderator routes now use a dedicated auth flow:
   - GET /api/mod/auth/twitch/start
   - GET /api/mod/auth/twitch/callback
   - GET /api/mod/auth/me
   - POST /api/mod/auth/logout
3. /api/mod/* returns 401 for unauthenticated requests and 403 for authenticated users without broadcaster/moderator privileges.
4. Legacy fallback is still available during migration:
   - Keep MOD_CONTROL_TOKEN set.
   - Keep MOD_AUTH_ALLOW_LEGACY_TOKEN=true.
   - Send Authorization: Bearer <token> from control when using fallback mode.
5. Migration from single-broadcaster auth:
   - Keep TWITCH_BROADCASTER_ID set to preserve existing behavior.
   - Add TENANT_BROADCASTER_OVERRIDES incrementally for tenant-specific broadcaster mappings.
   - Runtime updates are also supported via internal endpoints (below) and persisted under the controller state directory.

### Tenant broadcaster registry management

- List persisted mappings (internal auth required): GET /api/internal/tenant-broadcasters
- Upsert mapping at runtime (internal auth required): POST /api/internal/tenant-broadcasters/upsert
  - Body: { "tenantSlug": "livebingo-001", "broadcasterId": "12345678" }
- Auth model matches redeem integration: Authorization: Bearer <INTERNAL_REDEEM_SECRET>
- Resolver order is: persisted runtime registry -> TENANT_BROADCASTER_OVERRIDES -> TWITCH_BROADCASTER_ID fallback.

## Owner auth and tenant redeem keys

Owner routes are now available for broadcaster mapping and tenant redeem-key lifecycle management without sharing a global secret with mods.

Required owner env vars:

- OWNER_AUTH_ENABLED=true
- OWNER_AUTH_SESSION_SECRET
- OWNER_TWITCH_USER_IDS (comma-separated Twitch user IDs allowed to manage tenants)
- OWNER_AUTH_REDIRECT_URI (or PUBLIC_API_BASE_URL)
- TWITCH_CLIENT_ID
- TWITCH_CLIENT_SECRET

Optional owner env vars:

- OWNER_AUTH_OAUTH_SCOPE
- OWNER_AUTH_COOKIE_DOMAIN
- OWNER_AUTH_SESSION_TTL_MS

Owner auth/session endpoints:

- GET /api/owner/auth/twitch/start
- GET /api/owner/auth/twitch/callback
- GET /api/owner/auth/me
- POST /api/owner/auth/logout

Owner tenant-management endpoints:

- GET /api/owner/tenants
- POST /api/owner/tenants/upsert
- POST /api/owner/tenants/resolve-user
- POST /api/owner/tenants/redeem-key/rotate
- POST /api/owner/tenants/remove (safe remove persisted mapping; optional key removal)

Owner streamer setup export endpoints:

- POST /api/owner/setup/generate
   - Body: { "tenantSlug": "livebingo-01" }
- POST /api/owner/setup/entries/upsert
   - Body: { "tenantSlug": "livebingo-01" }
- POST /api/owner/setup/export/single
   - Body: { "tenantSlug": "livebingo-01", "format": "pdf" }
- POST /api/owner/setup/export/regenerate
   - Body: { "includeAllKnownTenants": false }
- GET /api/owner/setup/export/markdown
- GET /api/owner/setup/export/html
- GET /api/owner/setup/export/pdf

Notes for setup export workflow:

- Primary flow: select a tenant + format and call single export to download only that tenant block.
- Master maintenance flow: save or update entries, then regenerate master exports after list changes.
- Master regenerate produces list-based markdown, HTML, and PDF artifacts from saved entries.
- Export artifacts persist under the controller state directory (`owner-setup-export`).
- Env-managed tenant mappings from TENANT_BROADCASTER_OVERRIDES cannot be removed from owner routes; update env and redeploy instead.

Notes:

- Owner routes stay reachable even when MULTI_TENANT_ENABLED=true and LEGACY_SINGLE_TENANT_FALLBACK=false.
- Authentication supports signed bearer session tokens and owner_auth cookie sessions.

### Owner panel (local-only)

- A separate owner app now exists at apps/owner and is intentionally isolated from moderator controls.
- Local run command:
   - npm --workspace @bingo/owner run dev
- Local URL:
   - http://localhost:5176/?api=https://public-control.custom-overlays.com
- The owner panel is intentionally not linked from moderator control UI to keep tenant mapping and key management separated.

### Owner panel (dedicated hosted site)

- Firebase hosting target: owner (public path apps/owner/dist)
- Stream Bingo hosted URL:
   - https://stream-bingo-owner.web.app/?api=https://public-control.custom-overlays.com
- Public Bingo hosted URL:
   - https://bingo-owner.custom-overlays.com/?api=https://public-control.custom-overlays.com
- Public Bingo web.app fallback URL:
   - https://public-bingo-owner.web.app/?api=https://public-control.custom-overlays.com
- Deploy commands:
   - firebase deploy --only hosting:owner --project stream-bingo-4b72e
   - firebase deploy --only hosting:owner --project public-bingo
- Button order guide for tenant mapping/setup workflow:
   - apps/controller/docs/owner-panel-tenant-mapping-button-order.md

## Tenant redeem auth model (replaces shared internal secret)

Redeem integration now supports tenant-scoped keys for /api/t/<tenant-slug>/internal/redeem/join.

Authentication priority for redeem join:

1. Tenant key via Authorization: Bearer <tenantRedeemKey> (or x-tenant-redeem-key)
2. Optional legacy fallback via INTERNAL_REDEEM_SECRET when LEGACY_INTERNAL_REDEEM_SECRET_ENABLED=true

New env vars:

- LEGACY_INTERNAL_REDEEM_SECRET_ENABLED=true (set to false after migration)
- TENANT_REDEEM_KEY_HASH_ITERATIONS=120000

Key properties:

- Tenant keys are generated and returned only during rotate calls.
- Only a hash+salt is stored on disk (tenant-redeem-keys.json under the controller state directory).
- A key from one tenant cannot authorize redeem calls for another tenant.

## Recommended migration sequence (no secret sharing)

1. Keep current production behavior:
   - LEGACY_INTERNAL_REDEEM_SECRET_ENABLED=true
   - INTERNAL_REDEEM_SECRET remains set
2. Configure owner auth env vars and deploy controller.
3. For each tenant, call POST /api/owner/tenants/redeem-key/rotate and capture redeemKey.
4. Update each streamer's MixItUp command to use that tenant key in Authorization Bearer.
5. Verify joins succeed per tenant and fail for wrong-tenant keys.
6. After all tenants are migrated, set LEGACY_INTERNAL_REDEEM_SECRET_ENABLED=false.
7. Rotate or remove INTERNAL_REDEEM_SECRET to complete cutover.

## Control panel access restriction (post-Cloudflare)

Use the app-level model in production:

1. Keep control host allowlist enabled at build time:
   - apps/control/.env.production -> VITE_CONTROL_ALLOWED_HOSTS=public-controller.custom-overlays.com,control.custom-overlays.com
   - apps/control/.env.production -> VITE_MOD_TESTING_ALLOWLIST=<comma-separated Twitch user IDs or userLogins for Testing tab visibility>
2. Use Twitch-native mod auth inside the app as the authoritative mod or broadcaster check.
3. Optionally keep MOD_CONTROL_TOKEN + VITE_MOD_CONTROL_TOKEN only as temporary migration fallback.
4. If you still run an external gate (for example Cloudflare Access), treat it as optional defense in depth, not the primary auth model.

The control app blocks itself on hostnames not listed in VITE_CONTROL_ALLOWED_HOSTS (localhost and 127.0.0.1 remain available for local development).

Security caveat:

- web.app and firebaseapp.com URLs are public domains.
- Operational recommendation: use only your approved custom control domain in production.
- Testing tab visibility in control is client-side only; real enforcement for testing link access is MOD_TESTING_ALLOWLIST on the controller.

### Optional Cloudflare Access outer gate

If your team wants an additional perimeter check, Cloudflare Access can still be layered on top of the app auth flow:

1. Keep public-controller.custom-overlays.com mapped to the control Firebase Hosting target.
2. Add or keep a Self-hosted Cloudflare Access app for public-controller.custom-overlays.com.
3. Restrict policy membership to approved operators.
4. Keep Twitch-native moderator auth enabled in the app regardless of Access policy.

### Firebase custom domain mapping for control target

1. Open Firebase Console -> Hosting -> site public-bingo-control.
2. Add custom domain public-controller.custom-overlays.com to that control site.
3. Apply required DNS records shown by Firebase in Cloudflare.
4. Wait for certificate provisioning and status "Connected".
5. Validate the control custom domain serves the control app.

### MOD_CONTROL_TOKEN rotation on Railway (fallback mode only)

1. Generate a new token (PowerShell example):

   $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Fill($b); [Convert]::ToHexString($b).ToLower()

2. Update Railway variable:

   railway variable set "MOD_CONTROL_TOKEN=<new token>"

3. Update control frontend build token source used for production builds (for example apps/control/.env.production or your CI secret that populates VITE_MOD_CONTROL_TOKEN).
4. Rebuild and deploy controller and control hosting.
5. Verify /api/mod/auth/me reports authMode=legacy-token only when fallback is intended.

### Verification checklist (personas)

Anonymous user (not allowlisted):

1. Opening public-controller.custom-overlays.com shows Sign In Required until Twitch auth succeeds.
2. Opening a non-allowlisted hostname shows the in-app blocked host message.
3. /api/mod/state without mod auth returns 401.

Viewer redeemer (non-mod):

1. Redeem flow returns a viewerUrl.
2. Viewer can authenticate and access only their own card.
3. Viewer cannot access mod endpoints: signed-out is 401 and authenticated non-mod is 403.

Mod operator:

1. Can open gated control custom domain.
2. Control diagnostics show host allowed plus resolved auth mode twitch-session and role moderator or broadcaster.
3. Can sign in via Twitch and run lifecycle actions and theme changes successfully.

## Deployment notes

Frontend production builds should set API bases explicitly:

- apps/overlay/.env.production -> VITE_API_BASE_URL=https://public-control.custom-overlays.com
- apps/viewer/.env.production -> VITE_API_BASE_URL=https://public-control.custom-overlays.com
- apps/control/.env.production -> VITE_API_BASE_URL=https://public-control.custom-overlays.com

Custom domain reliability checklist for public custom domains:

1. In Firebase Hosting domain settings, ensure "Serve traffic from this domain" is selected.
2. In Cloudflare, keep exactly one CNAME per custom host pointing to the Firebase-provided target.
3. Remove duplicate A/AAAA/CNAME records for public-controller, public-overlay, bingo-owner, and public-card.
4. Keep Cloudflare proxy mode set to DNS only while validating cutover.
5. Validate both root and cache-busted URL, for example https://public-overlay.custom-overlays.com/?v=timestamp.

Control custom domain checklist:

1. Create public-controller.custom-overlays.com as a separate Firebase custom domain bound to public-bingo-control.
2. Set VITE_CONTROL_ALLOWED_HOSTS to include only approved control hosts.
3. Optionally layer Cloudflare Access if you want an external perimeter check.
4. Prefer operating only from the approved custom control domain.

## MixItUp redeem integration contract

Use channel-redeem automation to call the controller internal endpoint:

- Endpoint: POST /api/internal/redeem/join
- Tenant-aware endpoint form (recommended for multi-streamer isolation): POST /api/t/<tenant-slug>/internal/redeem/join
- Auth header (recommended): Authorization: Bearer <TENANT_REDEEM_KEY_FOR_THAT_TENANT>
- Legacy fallback auth header: Authorization: Bearer <INTERNAL_REDEEM_SECRET> (only when LEGACY_INTERNAL_REDEEM_SECRET_ENABLED=true)
- Body JSON:
   {
      "redemptionId": "<platform redemption id>",
      "twitchUserId": "<viewer twitch id>",
      "twitchUserName": "<viewer display/login name>"
   }
- Success response fields: ok, sessionId, userId, userName, viewerUrl, expiresInSeconds.
- Replay behavior: same session + redemptionId returns idempotentReplay=true and the same viewerUrl.
- Conflict behavior: same session + redemptionId with a different twitchUserId returns redeem_id_conflict.

## Useful scripts

- npm run dev: run controller, overlay, and viewer concurrently.
- npm run dev:control: run control UI only.
- npm run build: build all workspaces.
- npm run lint: lint all workspaces.
- npm run typecheck: run TypeScript checks in all workspaces.
- npm run test: run placeholder workspace tests.

## Operator checklist: deploy Twitch-native mod auth

1. Configure controller env vars: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_BROADCASTER_ID, MOD_AUTH_SESSION_SECRET, PUBLIC_API_BASE_URL (or TWITCH_MOD_REDIRECT_URI).
2. Optionally set MOD_AUTH_COOKIE_DOMAIN when control and API run on sibling subdomains.
3. Confirm VITE_CONTROL_ALLOWED_HOSTS includes your approved control custom domain.
4. Optionally keep migration fallback by setting MOD_CONTROL_TOKEN and VITE_MOD_CONTROL_TOKEN while MOD_AUTH_ALLOW_LEGACY_TOKEN=true.
5. Run npm run build.
6. Deploy API: railway up --service "Stream Bingo".
7. Deploy control hosting with an explicit public project id: firebase deploy --only hosting:control --project <your-public-firebase-project-id>.
8. Validate:
   - /api/mod/auth/me is 401 when signed out.
   - /api/mod/state is 403 for signed-in non-mod users.
   - /api/mod/state is 200 for broadcaster/moderator users.
   - blocked hostnames still show in-app host restriction screen.
