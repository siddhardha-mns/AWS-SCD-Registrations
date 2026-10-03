# Event QR Portal — Google Apps Script + Google Sheets

A fast, mobile-friendly participant portal and admin QR redemption desk with **Zero OTP / No Email dependencies**.

## 1. Participant Authentication Flow

1. Participant searches and selects their registered name.
2. Participant enters their registered **Email Address** OR **Phone Number**.
3. The backend validates that both the selected name and the entered email or phone belong to the **exact same participant row** in the Google Sheet.
4. If verified, the participant is authenticated and sees their **3 unique, non-guessable QR codes**:
   - **01 · Check-in QR**
   - **02 · Food QR**
   - **03 · Goodie Kit QR**
5. No emails, no OTPs, and no passwords are used.

---

## 2. Google Sheets Structure

### `Participants` Sheet
Columns:
```
Participant ID | Name | Phone | Email | Checkin Token | Food Token | Goodie Token | Checkin Redeemed | Food Redeemed | Goodie Redeemed | Track | Checked In At | Food Redeemed At | Goodie Redeemed At
```
- Only **Name**, **Phone**, and **Email** need to be filled manually or from your registration form.
- The script automatically generates unique `Participant ID` and random `CHK-...`, `FOD-...`, `GDK-...` tokens.

### `Admins` Sheet
Columns:
```
Email | Name | Active
```
- Enter authorized admin Google account emails and set `Active` to `TRUE`.

### `AuditLog` Sheet
Columns:
```
Timestamp | Admin Email | Action | QR Type | Participant ID | Participant Name | Track | Result | Details
```
- Logs all check-ins, redemptions, duplicate scan attempts, and invalid QR scans.

---

## 3. Deployment Instructions for Google Apps Script

1. Open your Google Sheet (or create a new one).
2. Click **Extensions → Apps Script**.
3. In the Apps Script code editor:
   - Paste the contents of `Code.gs` into the script file (replace any default code).
   - Click **+ (Add a file) → HTML**, name it `Index` (producing `Index.html`), and paste the contents of `Index.html`.
4. Click **Save Project** (disk icon).
5. In the toolbar, select the function `setupSheets` and click **Run**.
   - Review and grant the required permissions when prompted.
   - This automatically creates the `Participants`, `Admins`, and `AuditLog` tabs with formatted header columns.
6. Populate the `Participants` sheet with your attendees (Name, Phone, Email) and `Admins` with authorized admins.
7. Click **Deploy → New deployment**:
   - Click the gear icon next to "Select type" and choose **Web app**.
   - **Description:** `Event QR Portal v2`
   - **Execute as:** `Me (your email)`
   - **Who has access:** `Anyone` (or `Anyone with Google account` if internal)
8. Click **Deploy** and copy the generated **Web App URL** (`.../exec`).

### Portal URLs:
- **Participant Access:** `https://script.google.com/macros/s/.../exec`
- **Admin Scanner:** `https://script.google.com/macros/s/.../exec?page=admin`

---

## 4. Local Testing Server

A zero-dependency local Node.js preview server is included:

```bash
# Start local server
node server.js
# Or
npm start
```

- Participant view: `http://localhost:8080` (or `http://localhost:3000`)
- Admin scanner: `http://localhost:8080/?page=admin`
