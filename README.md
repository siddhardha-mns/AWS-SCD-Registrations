# AWS Community Day event portal

For a one-command practice version, run `npm run demo`. Open the admin link printed in the terminal and use the printed email/password. This uses two fake participants, fresh isolated state, and leaves your real `config.json` and registrations untouched. Keep the terminal open; press Ctrl+C to stop. `npm start` is for your configured real deployment.

Participants select their registered name, enter their registered email or Indian phone number, and receive check-in, food, and goodie passes. Their profile shows their assigned track; a sub-admin assigns the track at the event. Authentication uses an exact normalized name and contact match on a single unique row. It deliberately does not use OTPs or prove ownership of an email/phone. Search suggestions cannot authenticate a different, similarly named participant.

Each pass has an independent random token and can be redeemed once. Check-in is required before collecting food or goodies. Participants can download individual QR PNGs or one complete ticket PNG with their details and all three passes. The dashboard refreshes while visible. Sessions last one hour, survive refresh, and are revoked on sign-out.

## Google Sheets deployment (recommended for shared event desks)

Node and the Apps Script portal must use the **same portal deployment and spreadsheet**. Node forwards participant sessions and all redemptions to that backend over signed server-to-server requests; it does not maintain a second redemption database.

1. In the portal's spreadsheet Apps Script project, replace `Code.gs` and the HTML file named `Index` with the files in this repository. Do **not** include `ParticipantsApi.gs` in this project; it belongs only in the old export project.
2. Under **Project Settings → Script Properties**, set `PORTAL_OWNER_EMAIL` to the owner's Google email and `BRIDGE_SECRET` to a new random secret of at least 32 characters. Generate the secret locally with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. As the owner, run `setupSheets` in the editor and authorize it. Existing redemption flags and timestamps are preserved. Pass codes are now shorter (`v4-` plus 32 hex characters). This replaces prior `v3` codes, so old downloaded tickets stop working; ask participants to download fresh tickets. If any new random tokens are later exposed, run `rotatePassTokens` once.
4. Use the `Participants` schema below and add authorized organizer Google emails to `Admins`, with `Active` set to `TRUE`. Set the `Role` column to `admin` for lead organizers or `subadmin` for check-in volunteers. Existing accounts with a blank role remain lead admins for compatibility. Duplicate participant IDs or tokens stop access until corrected. Newly added rows with missing IDs/tokens are initialized under the shared lock.
5. Deploy/update the portal as a web app, executing as the owner. The participant portal can allow anyone. Direct Apps Script admin access requires Google to supply the caller's actual signed-in identity; it never trusts a typed email. When that identity is unavailable, use the password-authenticated Node admin portal. [Google documents the identity limitation for deployments executing as the developer.](https://developers.google.com/apps-script/reference/base/session)
6. In the **old public export project**, deploy the retirement version of `ParticipantsApi.gs` or disable that deployment. Merely changing the local file does not disable an already published endpoint.
7. Configure Node using the portal's `/exec` URL (not the old export URL), the same `BRIDGE_SECRET`, and admin password hashes as described below. Keep the old local `participant_tokens.json` until migration completes: Node imports its recorded redemptions into the sheet before serving requests. Unmatched or ambiguous legacy IDs stop startup so historical redemption flags are never silently discarded. Track capacities are imported only when a sheet capacity does not already exist.

Participant URL: `.../exec`. Direct Google admin URL: `.../exec?page=admin`.

`Participants` columns, in this order:

```text
Participant ID | Name | Phone | Email | Checkin Token | Food Token | Goodie Token | Checkin Redeemed | Food Redeemed | Goodie Redeemed | Track | Checked In At | Food Redeemed At | Goodie Redeemed At | College / Institution | Ticket Type | Registration Type | Registration On Hold
```

The final metadata columns are optional. `Admins` uses `Email | Name | Active | Role`; `AuditLog` records successful redemptions, manual check-ins, and staff track assignments. Track assignments, capacity changes, and redemptions share the Apps Script lock.

## Track assignments

Participants cannot choose or change tracks in their profile. Their pass shows the assigned track, or says the event team will assign it. Only sub-admins can assign or update tracks from the Participant CRM or during check-in. Each assignment requires a reason and confirmation, respects the shared seat limit, and is logged. Lead admins manage holds/restores and capacity; they cannot assign tracks. A lead admin scanning someone who needs a track is prompted to ask a sub-admin to assign one.

Configure the real track names and capacities in the portal's `TRACK_CATALOG` Script Property (a JSON array). Node configuration alone does not configure the shared Sheets backend. Example local configuration:

```json
{
  "TRACK_CATALOG": [
    {
      "id": "YOUR_TRACK_ID",
      "title": "Actual track title",
      "capacity": 50,
      "description": "Actual track description"
    }
  ]
}
```

This is a configuration example, not the real event schedule. Add one entry per real track, with unique, stable IDs. In Google Sheets, set `TRACK_CATALOG` as a JSON array. Existing saved/admin-set limits take precedence over catalog capacities; verify limits in the admin dashboard. Track choices are not shown to participants.

The practice demo has only **Dummy Event 1** and **Dummy Event 2**, with one seat each. Stop the old demo with Ctrl+C, then restart `npm run demo`. The restart creates fresh fake attendees and permanently clears old inactive practice directories, including demo passes, sessions, assignments, and audit records. Active demos and real registration data are not cleared. No invitation emails are sent by this change.

## Node configuration

Requires Node.js 22 or later; no npm packages are required. Run `npm run admin-password` to generate a salted scrypt password hash. Use a unique password of at least 16 characters. The helper accepts stdin so the password does not need to appear in shell command arguments. Treat your terminal as private when entering it.

Create a private local `config.json` (do not commit passwords or secrets):

```json
{
  "PARTICIPANTS_URL": "https://script.google.com/macros/s/YOUR_PORTAL_DEPLOYMENT/exec",
  "BRIDGE_SECRET": "YOUR_NEW_RANDOM_SECRET",
  "STATE_DIR": "./.runtime",
  "ADMIN_CREDENTIALS": {
    "organizer@example.com": "scrypt:YOUR_SALT:YOUR_PASSWORD_HASH",
    "volunteer@example.com": "scrypt:VOLUNTEER_SALT:VOLUNTEER_PASSWORD_HASH"
  },
  "ADMIN_ROLES": {
    "organizer@example.com": "admin",
    "volunteer@example.com": "subadmin"
  }
}
```

`PARTICIPANTS_URL`, `PARTICIPANTS_FILE`, `BRIDGE_SECRET`, `STATE_DIR`, and JSON-encoded `ADMIN_CREDENTIALS`/`ADMIN_ROLES` can also be supplied as environment variables, overriding local config. `PORT` defaults to 3000. There are no default admin credentials. In Sheets mode the email must also be active in the sheet and its sheet role is authoritative; `ADMIN_ROLES` controls local-file mode.

## Vercel deployment

Vercel uses the exported request handler in `server.js`, not a persistent listening process. Hosted mode requires Google Sheets and uses its shared participant/admin sessions; it does not write runtime files or read the repository's `config.json`.

1. Copy the updated `Code.gs` into your existing Apps Script project. Select **Deploy > Manage deployments > Edit > New version > Deploy**. Keep the same `/exec` URL.
2. In Vercel, open **Project > Settings > Environment Variables** and add these for Production (and Preview if you test preview deployments):
   - `PARTICIPANTS_URL`: your portal's Apps Script `/exec` URL.
   - `BRIDGE_SECRET`: exactly the same secret as the Apps Script Script Property; at least 32 characters.
   - `ADMIN_CREDENTIALS`: a JSON object mapping each staff email to its generated scrypt hash, for example `{"organizer@example.com":"scrypt:YOUR_SALT:YOUR_PASSWORD_HASH"}`. Generate each hash with `npm run admin-password`. The email must also be active in the `Admins` sheet.
3. Deploy the updated Git commit, or open **Deployments > latest deployment > Redeploy** after changing environment variables.
4. Open your Vercel domain for participants, or append `/?page=admin` for staff. Test participant sign-in, staff sign-in, and a test participant's single-use check-in.

Missing configuration leaves the public page available but returns a clear setup error for API requests. Admin sessions are checked against current sheet permissions on every action; logout works across server instances. Changing the configured password hashes invalidates existing hosted admin sessions.

If you still have local legacy redemption state to migrate, run the configured local server once before the cloud rollout and verify the sheet. Vercel intentionally does not replay checked-in runtime files during cold starts.

## Admin and sub-admin desks

Lead admins can use participant search results to **Put On Hold** and **Restore Registration**. Each action requires a reason and confirmation, and the action is recorded. A hold preserves the registration, seat, and check-in history, while blocking sign-in and pass redemption. Restoration requires a fresh participant login. Sub-admins can assign or update tracks from search results; assignments require a reason and confirmation, respect capacity, and are recorded. These permissions are also enforced by the backend.

Google Sheets deployments must rerun owner-only `setupSheets` before redeployment to add the final `Registration On Hold` column (blank means active). Existing flags and history are preserved. Waitlisting/seat offers are not implemented yet; full tracks reject new assignments.

Both roles see total registered participants, checked-in participants, participants still awaiting check-in, and current track occupancy. The dashboard refreshes every 15 seconds while visible and immediately after a successful check-in. Search results and counts are restricted to authenticated staff.

Lead admins set each track's seat capacity and can redeem check-in, food, and goodie passes. A capacity of `0` means unlimited. A positive limit cannot be reduced below the number of seats already assigned. Full tracks reject new assignments, including manual ones.

Sub-admins scan check-in QR codes or use **Manual Participant Check-in** to search by registration ID or registered name. Selecting a record opens its details and track assignment; confirmation saves the check-in exactly once and updates the counts. This manual operation is an authenticated staff workflow and does not make registration IDs valid QR pass codes. Volunteers must verify the participant's identity before confirming. Sub-admins cannot change capacities or redeem food/goodie passes, even by calling the backend directly.

To provision a Node sub-admin, generate a separate hash with `npm run admin-password`, add their email/hash to local `ADMIN_CREDENTIALS`, and set their role to `subadmin` in `ADMIN_ROLES` for local mode or the `Admins` sheet for Sheets mode. Restart Node after changing its configuration. For direct Apps Script access, add the person's Google email to the `Admins` sheet with `Active=TRUE` and `Role=subadmin`; no Node password is used. Account provisioning is through these private configuration sources, not public self-registration.

If the camera is unavailable, staff can upload a QR photo, paste the full `v4-…` pass code, or use manual participant check-in. Camera requests are cancelled on sign-out/stop; a late permission grant cannot restart the camera after logout.

```powershell
npm start
npm test
```

Participant UI: `http://localhost:3000`. Admin UI: `http://localhost:3000/?page=admin`. Use HTTPS through your hosting platform/reverse proxy for any network deployment, so passwords and session tokens travel encrypted. Camera and clipboard access also depend on the browser's secure-context rules.

## Local file mode

Use the example config with `PARTICIPANTS_FILE` pointing at a private CSV/JSON export and supply admin password hashes. This is an independent local event database; do not simultaneously operate another backend against that event's passes. The file reloads within 30 seconds. Unique registration IDs are recommended; otherwise a stable ID uses the normalized name, email, and phone together. Duplicate IDs or ambiguous logins are rejected.

Accepted headers include `Registration ID`/`Participant ID`/`ID`, `Participant Name`/`Name`, `Email`/`Email Address`, and `Mobile Number (WhatsApp)`/`Mobile Number`/`Phone Number`/`Phone`/`Mobile`. College and ticket metadata are optional. Redeemed booleans/timestamps imported from the source or legacy state are preserved. Existing source tokens are replaced with locally generated random tokens; predictable ID alternatives are not accepted.

The `.runtime` directory contains private redemption state, sessions, capacities, and audit records. Writes use a flushed temporary file and atomic rename; failure is returned to the caller without updating in-memory redemption state. An exclusive writer lock refuses a second process for the same state directory. Local mode is intentionally a single-server deployment. Do not create separate state directories to scale local mode: use the shared Sheets backend instead.

Back up the complete runtime directory and never restore a stale snapshot during a live event. Missing/corrupt initialized state stops startup. After a crash, check that the PID in `.runtime/writer.lock` is no longer running before removing **only that lock file**. Restore missing state from its backup; do not delete the initialization marker to bypass the check. In Sheets mode separate Node frontends may have separate runtime directories; their participant sessions and redemptions still share the sheet. Node admin sessions are local to each frontend, so use sticky routing or sign in on each frontend.

## Sensitive files and rollout

`config.json`, attendee exports, legacy pass state, capacities, and `.runtime` must stay outside Git tracking. Their local copies remain available for migration. Previous commits still contain the old values: stopping tracking does not erase history. Token rotation and retirement of the public endpoint must happen before the update is considered live. If repository history must also be purged, coordinate a separate history rewrite with everyone sharing the repository.

Automated tests use synthetic data, isolated temporary state, mocked Google services, and simulated browser DOM/canvas behavior. They cover identity mixing, ambiguous IDs, admin impersonation, exact tokens, concurrency, persistence failures, restart/expiry/logout, source refresh, bridge signature/replay rejection, cross-backend redemption, safe name rendering, and ticket downloads. Actual mobile downloads and the redeployed Google web app still require a deployment smoke test.
