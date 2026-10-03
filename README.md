# Event QR Portal — Google Apps Script + Google Sheets

This version uses **email OTP authentication** for participants.

## Participant flow

1. Participant selects/searches their registered name.
2. Apps Script looks up that participant in the `Participants` sheet.
3. Apps Script sends a random 6-digit OTP to the participant's registered email using `MailApp`.
4. Participant enters the OTP.
5. The OTP expires after 10 minutes and is deleted after successful verification.
6. After verification, the participant receives a 10-minute session and sees three unique QR codes:
   - Check-in
   - Food
   - Goodie Kit

Each QR is independently redeemable once.

## Setup

1. Create a Google Sheet.
2. Open **Extensions → Apps Script**.
3. Add `Code.gs` and `Index.html` from this project.
4. Save the project.
5. Run `setupSheets()` once from the Apps Script editor and authorize it.
6. In `Participants`, enter these columns:

   `Participant ID | Name | Phone | Email | Checkin Token | Food Token | Goodie Token | Checkin Redeemed | Food Redeemed | Goodie Redeemed | Track | Checked In At | Food Redeemed At | Goodie Redeemed At`

   You only need to fill **Name, Phone, and Email**. The script generates IDs and QR tokens automatically.

7. In `Admins`, add authorized admin emails:

   `Email | Name | Active`

8. Deploy → **New deployment** → **Web app**.
   - Execute as: **Me**
   - Who has access: choose the audience you need (for a public participant portal, normally anyone with the link).
9. Open the deployed `/exec` URL for participants.
10. Use the same URL with `?page=admin` for the admin scanner.

## OTP behavior

- OTP is 6 digits.
- OTP is valid for 10 minutes.
- Maximum 5 incorrect attempts.
- Resend is rate-limited to once per 60 seconds per participant.
- The OTP is sent only to the email stored in the sheet.
- The UI only displays a masked email such as `ni***@gmail.com`.
- OTP is not stored in the Google Sheet.

## Important Apps Script quota note

`MailApp` is subject to Google Apps Script email quotas. For a normal student event this can be suitable, but you should check your account's current Apps Script quota before sending a large number of OTP emails.

## Admin check-in

When the admin scans a Check-in QR, the portal opens a track-selection dialog. The selected track and check-in timestamp are written to the participant row. Food and Goodie Kit QRs are redeemed independently.

`LockService` is used around redemption so two admins scanning the same QR at nearly the same time cannot both redeem it.
