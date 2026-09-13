# Owner Panel Tenant Mapping Button Order Guide

Use this guide when operating the Owner panel so tenant mapping, key rotation, and setup exports are done in the safest order.

Owner panel URL:
- https://bingo-owner.custom-overlays.com/?api=https://public-control.custom-overlays.com

--------------------------------------------------
Quick Order: First-Time Tenant Setup
--------------------------------------------------

1. Sign in to Owner panel with the owner Twitch account.
2. In Management Tools -> Resolve Twitch Login, click Resolve User for the streamer login.
3. Copy the returned Twitch id.
4. In Management Tools -> Upsert Tenant Mapping, enter tenant slug + broadcaster id, then click Save Mapping.
5. In Tenant Overview, confirm the slug appears and Broadcaster/Eff. Broadcaster are correct.
6. In that tenant row, click Rotate Key.
7. In Latest Rotated Redeem Key, click Copy Key and store the key in secure notes immediately.
8. Paste this key into MixItUp Authorization header as:
   - Bearer <tenant redeem key>
9. In Setup Export -> Single-Tenant Download, select that slug.
10. Choose output format (PDF recommended for handoff) and click Download Tenant Setup.
11. Share the downloaded tenant file with the streamer.
12. Run one live redeem test for that slug.
13. Run the authenticated verification checklist below for production confidence.

Optional master artifact maintenance (only when needed):
1. In Setup Export -> Master List Maintenance, click Generate Preview Block.
2. Click Save To Streamer List.
3. Click Regenerate Master Exports.
4. Download Master PDF / Markdown / HTML if you distribute list-based reference sheets.

--------------------------------------------------
When To Use Each Button
--------------------------------------------------

Tenant Overview row actions:

- Generate Setup
  - Use when you want an immediate setup block preview for that specific tenant row.
  - This generates preview content but does not refresh all export files by itself.

- Rotate Key
  - Use when onboarding a tenant, replacing a compromised key, or rotating keys routinely.
  - Warning: old MixItUp key stops working as soon as rotation succeeds.
  - Always update MixItUp right away after rotation.

- Remove Tenant
  - Use only when decommissioning a tenant.
  - You must type the slug to confirm removal.
  - You will also be asked whether to remove the redeem key.
  - Env-managed mappings from TENANT_BROADCASTER_OVERRIDES are protected and may not be removable from UI.

Management Tools:

- Resolve User
  - Use before Save Mapping when you only know the Twitch login name.
  - Returns canonical user id for mapping.

- Save Mapping
  - Use to create or update tenantSlug -> broadcasterId mapping.
  - Safe to run again when adjusting a mapping.

Latest Rotated Redeem Key panel:

- Copy Key
  - Use immediately after Rotate Key.
  - Keys are shown once per rotation workflow; store securely.

Setup Export panel:

- Download Tenant Setup
  - Primary path for day-to-day operations.
  - Generates a single-tenant markdown/html/pdf file on demand.
  - Does not rewrite master export artifacts.

- Generate Preview Block
  - Use to preview tenant-specific MixItUp instructions for selected slug in the maintenance flow.

- Save To Streamer List
  - Use to append or update the selected tenant entry in the master export source list.

- Regenerate Master Exports
  - Use after list changes so master Markdown/HTML/PDF files are rebuilt from saved entries.

- Download Master PDF / Download Master Markdown / Download Master HTML
  - Use after regeneration when distributing list-based master instructions.

--------------------------------------------------
Authenticated Live Verification (Recommended)
--------------------------------------------------

Run this pass after signing in to the hosted owner panel.

1. Select tenant slug livebingo-01 in Single-Tenant Download.
2. Download Markdown, then verify:
   - File name includes MixItUp-Streamer-Setup-Reference-livebingo-01.md
   - Content contains BLOCK: livebingo-01 exactly once
   - Content contains /api/t/livebingo-01/internal/redeem/join
   - Content contains REPLACE_WITH_TENANT_REDEEM_KEY_LIVEBINGO_01
3. Download HTML and verify the same slug markers are present.
4. Download PDF and confirm non-empty output for the same slug.
5. Confirm no other tenant block appears in single-tenant downloads.

--------------------------------------------------
Recommended Workflows
--------------------------------------------------

Key rotation only (existing tenant):
1. Rotate Key
2. Copy Key
3. Update MixItUp Authorization Bearer value
4. Test one redeem

Single-tenant instruction refresh (most common):
1. Select tenant + format in Single-Tenant Download
2. Download Tenant Setup
3. Send file to streamer/operator

Mapping correction (wrong broadcaster):
1. Resolve User for correct login
2. Save Mapping with corrected broadcaster id
3. Verify Tenant Overview Broadcaster column
4. Download Tenant Setup for immediate handoff
5. If using master docs, run Generate Preview Block -> Save To Streamer List -> Regenerate Master Exports

Tenant removal:
1. Confirm tenant is no longer in use
2. Remove Tenant (type slug)
3. Choose whether to remove key
4. If using master docs, Regenerate Master Exports
5. Re-check distributed docs no longer include the removed slug

--------------------------------------------------
Operator Safety Notes
--------------------------------------------------

- Never share tenant redeem keys publicly.
- Give keys only to the streamer or trusted setup operator.
- If a key is exposed, rotate immediately and update MixItUp.
- If redeems fail after rotation, the old key is still in MixItUp.