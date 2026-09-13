# MixItUp Tenant Redeem Command Blocks

Use this file as your copy-and-paste source for Channel Points -> Bingo Card web request commands.

Important before you start:
- Each slug should appear in the Owner panel Tenant Overview and be mapped to the correct broadcaster.
- Generate a tenant redeem key first from the Owner panel (Rotate Key action) for each slug.
- A bingo round must be open or running on that tenant.

--------------------------------------------------
BLOCK 1: live-bingo
--------------------------------------------------

Overlay URL
https://public-overlay.custom-overlays.com/?tenant=live-bingo&api=https://public-control.custom-overlays.com

Bingo Controller URL
https://public-controller.custom-overlays.com/?tenant=live-bingo&api=https://public-control.custom-overlays.com

Reward Name
Bingo Card

Web Request
Method
POST

Web Request URL
https://public-control.custom-overlays.com/api/t/live-bingo/internal/redeem/join

Header Name
Authorization

Header Value
Bearer REPLACE_WITH_TENANT_REDEEM_KEY_LIVE_BINGO
Contact Bingo Owner For Secret Key
Paste only the private tenant redeem key after Bearer. Do not share this key publicly.

Header Name
Content-Type

Header Value
application/json

Request Body (JSON)
{
  "redemptionId": "$usertwitchid-$dateyear$datemonth$dateday-$timedigits-$randomnumber999999999",
  "twitchUserId": "$usertwitchid",
  "twitchUserName": "$userdisplayname"
}

Response Processing Type
JSON to Special Identifiers

JSON Value Name (Use \ for nested parameters)
viewerUrl

Special Identifier Name
bingoviewurl

JSON Value Name (Use \ for nested parameters)
error

Special Identifier Name
bingoerror

JSON Value Name (Use \ for nested parameters)
message

Special Identifier Name
bingomessage

Chat Message
Send as Streamer
On

Whisper
On

Whisper User (Optional)
Leave blank

Chat Message
@$userdisplayname Your Bingo card: $bingoviewurl

--------------------------------------------------
BLOCK 2: livebingo-01
--------------------------------------------------

Overlay URL
https://public-overlay.custom-overlays.com/?tenant=livebingo-01&api=https://public-control.custom-overlays.com

Bingo Controller URL
https://public-controller.custom-overlays.com/?tenant=livebingo-01&api=https://public-control.custom-overlays.com

Reward Name
Bingo Card

Web Request
Method
POST

Web Request URL
https://public-control.custom-overlays.com/api/t/livebingo-01/internal/redeem/join

Header Name
Authorization

Header Value
Bearer REPLACE_WITH_TENANT_REDEEM_KEY_LIVEBINGO_01
Contact Bingo Owner For Secret Key
Paste only the private tenant redeem key after Bearer. Do not share this key publicly.

Header Name
Content-Type

Header Value
application/json

Request Body (JSON)
{
  "redemptionId": "$usertwitchid-$dateyear$datemonth$dateday-$timedigits-$randomnumber999999999",
  "twitchUserId": "$usertwitchid",
  "twitchUserName": "$userdisplayname"
}

Response Processing Type
JSON to Special Identifiers

JSON Value Name (Use \ for nested parameters)
viewerUrl

Special Identifier Name
bingoviewurl

JSON Value Name (Use \ for nested parameters)
error

Special Identifier Name
bingoerror

JSON Value Name (Use \ for nested parameters)
message

Special Identifier Name
bingomessage

Chat Message
Send as Streamer
On

Whisper
On

Whisper User (Optional)
Leave blank

Chat Message
@$userdisplayname Your Bingo card: $bingoviewurl

--------------------------------------------------
BLOCK 3: livebingo-02
--------------------------------------------------

Overlay URL
https://public-overlay.custom-overlays.com/?tenant=livebingo-02&api=https://public-control.custom-overlays.com

Bingo Controller URL
https://public-controller.custom-overlays.com/?tenant=livebingo-02&api=https://public-control.custom-overlays.com

Reward Name
Bingo Card

Web Request
Method
POST

Web Request URL
https://public-control.custom-overlays.com/api/t/livebingo-02/internal/redeem/join

Header Name
Authorization

Header Value
Bearer REPLACE_WITH_TENANT_REDEEM_KEY_LIVEBINGO_02
Contact Bingo Owner For Secret Key
Paste only the private tenant redeem key after Bearer. Do not share this key publicly.

Header Name
Content-Type

Header Value
application/json

Request Body (JSON)
{
  "redemptionId": "$usertwitchid-$dateyear$datemonth$dateday-$timedigits-$randomnumber999999999",
  "twitchUserId": "$usertwitchid",
  "twitchUserName": "$userdisplayname"
}

Response Processing Type
JSON to Special Identifiers

JSON Value Name (Use \ for nested parameters)
viewerUrl

Special Identifier Name
bingoviewurl

JSON Value Name (Use \ for nested parameters)
error

Special Identifier Name
bingoerror

JSON Value Name (Use \ for nested parameters)
message

Special Identifier Name
bingomessage

Chat Message
Send as Streamer
On

Whisper
On

Whisper User (Optional)
Leave blank

Chat Message
@$userdisplayname Your Bingo card: $bingoviewurl

--------------------------------------------------
Beginner Setup Steps (First Time MixItUp User)
--------------------------------------------------

1. Get the tenant redeem key (secret) for the slug first. See "Get the Secret (Tenant Redeem Key) from Owner Panel" below.
2. Open MixItUp Desktop.
3. Create or open your command for the Channel Points reward named Bingo Card.
4. In the command editor, add a Web Request action.
5. Paste all fields from one block above (pick the slug this streamer uses).
6. Replace only one value: the tenant redeem key placeholder for that slug. Contact Bingo Owner For Secret Key if you do not have it.
7. Save the command.
8. Add a Chat Message action under the Web Request action using the same block values.
9. Start a bingo round from Bingo Control for that same slug.
10. Redeem Bingo Card once from chat.
11. Confirm the user receives a whisper/message with a viewer URL.

--------------------------------------------------
How to Choose the Right Block
--------------------------------------------------

- Use live-bingo for your default tenant stream.
- Use livebingo-01 for streamer account mapped to slug livebingo-01.
- Use livebingo-02 for streamer account mapped to slug livebingo-02.

Tip:
- In Owner panel -> Tenant Overview, use the Broadcaster column to confirm which Twitch account each slug is mapped to.

If you use the wrong slug, the user may get join_not_available or the wrong session context.

--------------------------------------------------
Get the Secret (Tenant Redeem Key) from Owner Panel
--------------------------------------------------

Use owner auth once, then rotate one key per tenant slug and store each key in secure notes/password manager.

1. Open Owner panel:
  - https://bingo-owner.custom-overlays.com/?api=https://public-control.custom-overlays.com
2. Sign in with your owner Twitch account.
3. In Tenant Overview, find the slug you are setting up.
4. Click Rotate Key for that slug.
5. In Latest Rotated Redeem Key, copy the new key immediately.
6. Paste that key into the matching MixItUp block Authorization header:
  - Bearer REPLACE_WITH_TENANT_REDEEM_KEY_...
  - Contact Bingo Owner For Secret Key.
7. Repeat for each slug (live-bingo, livebingo-01, livebingo-02).

Important:
- Rotating a key invalidates the previous key for that slug.
- If you rotate again, update MixItUp right away or redeems will fail for that slug.

Optional hardening after setup:
- After all slug commands are updated and verified, disable legacy fallback:
  - LEGACY_INTERNAL_REDEEM_SECRET_ENABLED=false

--------------------------------------------------
Canonical Operator Links (Tenant-Aware)
--------------------------------------------------

Control
- live-bingo:
  https://public-controller.custom-overlays.com/?tenant=live-bingo&api=https://public-control.custom-overlays.com
- livebingo-01:
  https://public-controller.custom-overlays.com/?tenant=livebingo-01&api=https://public-control.custom-overlays.com
- livebingo-02:
  https://public-controller.custom-overlays.com/?tenant=livebingo-02&api=https://public-control.custom-overlays.com

Overlay
- live-bingo:
  https://public-overlay.custom-overlays.com/?tenant=live-bingo&api=https://public-control.custom-overlays.com
- livebingo-01:
  https://public-overlay.custom-overlays.com/?tenant=livebingo-01&api=https://public-control.custom-overlays.com
- livebingo-02:
  https://public-overlay.custom-overlays.com/?tenant=livebingo-02&api=https://public-control.custom-overlays.com

Viewer root (expected to require invite token)
- https://public-card.custom-overlays.com

Use web.app links as fallback diagnostics while validating custom-domain cutover.

--------------------------------------------------
Invite Token Test Commands (PowerShell)
--------------------------------------------------

Use these blocks when you want a direct self-test viewer URL outside MixItUp.
Replace only the tenant key value in each block.

BLOCK A: live-bingo

$api = "https://public-control.custom-overlays.com"
$tenant = "live-bingo"
$tenantRedeemKey = "REPLACE_WITH_TENANT_REDEEM_KEY_LIVE_BINGO"
$body = @{ redemptionId = "selftest-" + (Get-Date -Format "yyyyMMddHHmmss"); twitchUserId = "139949841"; twitchUserName = "killingmist" } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Method Post -Uri "$api/api/t/$tenant/internal/redeem/join" -Headers @{ Authorization = "Bearer $tenantRedeemKey" } -ContentType "application/json" -Body $body
Write-Output "Viewer URL:"
Write-Output $r.viewerUrl
Start-Process $r.viewerUrl

BLOCK B: livebingo-01

$api = "https://public-control.custom-overlays.com"
$tenant = "livebingo-01"
$tenantRedeemKey = "REPLACE_WITH_TENANT_REDEEM_KEY_LIVEBINGO_01"
$body = @{ redemptionId = "selftest-" + (Get-Date -Format "yyyyMMddHHmmss"); twitchUserId = "139949841"; twitchUserName = "killingmist" } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Method Post -Uri "$api/api/t/$tenant/internal/redeem/join" -Headers @{ Authorization = "Bearer $tenantRedeemKey" } -ContentType "application/json" -Body $body
Write-Output "Viewer URL:"
Write-Output $r.viewerUrl
Start-Process $r.viewerUrl

BLOCK C: livebingo-02

$api = "https://public-control.custom-overlays.com"
$tenant = "livebingo-02"
$tenantRedeemKey = "REPLACE_WITH_TENANT_REDEEM_KEY_LIVEBINGO_02"
$body = @{ redemptionId = "selftest-" + (Get-Date -Format "yyyyMMddHHmmss"); twitchUserId = "139949841"; twitchUserName = "killingmist" } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Method Post -Uri "$api/api/t/$tenant/internal/redeem/join" -Headers @{ Authorization = "Bearer $tenantRedeemKey" } -ContentType "application/json" -Body $body
Write-Output "Viewer URL:"
Write-Output $r.viewerUrl
Start-Process $r.viewerUrl

If the viewer page says invite token is missing, open the full viewerUrl returned by the command.

--------------------------------------------------
Quick Troubleshooting
--------------------------------------------------

- Error join_not_available:
  No active round is open/running for that tenant.

- Error invalid_tenant_redeem_auth (or invalid_internal_secret on older flows):
  Tenant redeem key is missing, wrong, or belongs to a different tenant.

- Redeems suddenly fail after Rotate Key:
  MixItUp is still using the previous key. Paste the latest rotated key for that slug.

- Error redeem_id_conflict:
  The redemption id was reused with a different twitchUserId.

- URL opens but viewer cannot join:
  Check slug mapping and that VIEWER_BASE_URL points to your active viewer host.
