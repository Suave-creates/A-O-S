# One Pager Report → Google Sheet Setup

Written via the **Google Sheets API + a service account** - not an Apps
Script Web App. (An Apps Script version was tried first, but the Lenskart
Workspace only offers "Only myself" / "Anyone within lenskart.com" for a
Web App's access - never true "Anyone" - so an unauthenticated server-side
call always redirects to a Google sign-in page instead of executing, no
matter how the script is deployed. A service account sidesteps this
entirely: it's a genuine server-to-server credential, no "who has access"
setting involved at all.)

## What it does

Clicking **Save to Sheet** on the One Pager Report tab sends that report's
numbers to one row in your Sheet, keyed by date. Saving the same date again
**overwrites** that row - you'll never get duplicate rows for one day.
Columns are created automatically the first time you save.

## Step 1 — Create the Sheet

1. Create a new, blank Google Sheet (sheets.new). Name it whatever you like
   (e.g. "ASRS One Pager Report History").
2. Leave it empty - the app creates its own "One Pager Report" tab and
   header row on the first save.
3. Copy the **Spreadsheet ID** out of the URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

## Step 2 — Create a service account + key

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and
   select or create a project (any Unaproject you have access to - it doesn't
   need to be a Lenskart-managed one, since the service account just needs
   to be *shared onto* the Sheet like any other collaborator).
2. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
3. **IAM & Admin → Service Accounts → Create Service Account**. Give it any
   name (e.g. "asrs-one-pager-report"). No roles/permissions needed at the
   project level - skip those steps.
4. Open the new service account → **Keys** tab → **Add Key → Create new
   key → JSON**. This downloads a `.json` file - **treat it as a password**,
   it's a real credential.
5. Note the service account's **email address** (looks like
   `asrs-one-pager-report@your-project.iam.gserviceaccount.com`).

## Step 3 — Share the Sheet with the service account

1. Open the Sheet from Step 1 → **Share**.
2. Add the service account's email address (from Step 2.5) as **Editor**.
3. Uncheck "Notify people" (it has no inbox) → **Share**.

## Step 4 — Point the webapp at it

1. Move the downloaded JSON key file somewhere on the server (NOT inside
   the project folder) - e.g.
   `C:\Users\<you>\.credentials\one-pager-report-sa.json`.
2. In the webapp's `.env` (see `.env.example`):
   ```
   ONE_PAGER_REPORT_SHEET_SPREADSHEET_ID=<the ID from Step 1.3>
   ONE_PAGER_REPORT_SHEET_SERVICE_ACCOUNT_KEY_PATH=<the JSON key's local path>
   ```
3. Restart the backend. **Save to Sheet** on the One Pager Report tab
   should now work.

## Troubleshooting

| Issue | Fix |
|---|---|
| "ONE_PAGER_REPORT_SHEET_SPREADSHEET_ID is not configured" | Set it in `.env` and restart the backend |
| "...SERVICE_ACCOUNT_KEY_PATH is not configured" | Same - set the path and restart |
| "HTTP 403" / "The caller does not have permission" | The Sheet isn't shared with the service account's email (Step 3), or you shared it as Viewer instead of Editor |
| "HTTP 404" / "Requested entity was not found" | Wrong Spreadsheet ID - re-check the URL |
| Wrong/missing columns | Check the "One Pager Report" tab's header row - a typo'd field name just becomes a new column, it won't overwrite an existing one |
| Corporate network / self-signed certificate errors | Your machine may be behind a TLS-inspecting proxy (e.g. Netskope) that Node doesn't trust by default - see `NODE_EXTRA_CA_CERTS` in Node's own docs; ask whoever set this webapp up if it's already been handled |
