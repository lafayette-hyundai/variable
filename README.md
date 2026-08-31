# Lafayette Hyundai Recon Line Dashboard

A kanban-style dashboard for tracking used-vehicle reconditioning status,
from acquisition through front-line-ready, plus a sold-history log with
rolling performance metrics.

- **`index.html`** — the dashboard. A single self-contained page, hosted on
  GitHub Pages. All business logic (stage derivation, location defaults,
  metrics, reconciliation rules) lives here, in JavaScript.
- **`apps-script/Code.gs`** — the backend. A Google Apps Script Web App
  bound to the dealership's inventory Google Sheet. It's a thin data-access
  layer only: it reads the Inventory tab and reads/writes a
  dashboard-only "Dashboard Data" tab it creates automatically. It does not
  contain any of the stage/metrics logic — that all lives in `index.html`.

The Google Sheet's Inventory tab is the single source of truth for vehicle
identity and recon status. This dashboard never creates or edits inventory
data on that tab — it only reads it and layers dashboard-only fields
(on-site/off-site, assigned-to, notes) on top, stored in the second tab.

## One-time setup

### 1. Google Sheet + Apps Script

1. Open the dealership's inventory Google Sheet. Confirm the tab holding
   the real data has a header row with exactly these columns (any order):
   `Stock #`, `VIN`, `YMM`, `To Service`, `From Service`, `To Detail`,
   `From Detail`, `Photos Uploaded`, `Include/Exclude`, `Sold Date`,
   `Disposition`.
2. Note that tab's name. If it isn't `Inventory`, open `apps-script/Code.gs`
   and change the `INVENTORY_SHEET_NAME` constant at the top to match.
3. In the Sheet, go to **Extensions → Apps Script**. Delete the default
   `Code.gs` contents and paste in the contents of `apps-script/Code.gs`
   from this repo.
4. Click **Deploy → New deployment**. Choose type **Web app**. Set:
   - **Execute as:** Me
   - **Who has access:** Anyone
5. Click **Deploy**, then authorize the requested permissions (it needs to
   read/write the spreadsheet it's bound to).
6. Copy the resulting Web App URL — it ends in `/exec`.

A second tab named **"Dashboard Data"** will be created automatically the
first time the script runs (on the dashboard's first Sync or load). Don't
create it manually — the script owns its columns.

### 2. Set a password (do this right away)

Reload the Google Sheet tab in your browser so the script picks up its menu.
You should see a new **Recon Dashboard** menu next to Extensions/Tools.
Click **Recon Dashboard → Set/Change Access Password** and enter a password.

Until you do this, the dashboard is **not** password-protected — anyone with
the Pages URL can view it. Once set, nobody sees any vehicle data (the page
itself still loads, but stays empty) until they enter that password. You can
change it any time from the same menu; existing browser tabs will be asked
to re-enter it on their next action. Share the password only with staff who
should have access — it's a single shared password, not individual logins.

### 3. Point the dashboard at your deployment

Open `index.html` in this repo and find this line near the top of the
`<script>` block:

```js
const APPS_SCRIPT_URL = 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';
```

Replace the placeholder with the `/exec` URL from step 6 above. Commit and
push.

### 4. GitHub Pages

In the repo's **Settings → Pages**, set the source to deploy from this
branch's root. GitHub will serve `index.html` at the resulting Pages URL.

### 5. First sync

Open the published Pages URL, enter the password from step 2, then click
**⇪ Sync Now**. This pulls every row
from the Inventory tab, applies the same stage-derivation and reconciliation
rules the dashboard has always used, and saves the result to the Dashboard
Data tab. From then on, "Sync Now" is the on-demand replacement for the old
manual CSV export/import step — no export step is needed anymore, since
Apps Script reads the live sheet directly.

## Redeploying Code.gs after edits

Google Apps Script Web Apps don't auto-update from a saved script — after
changing `Code.gs`, go to **Deploy → Manage deployments**, edit the active
deployment, and choose **New version** to publish the change. The `/exec`
URL stays the same, so nothing needs to change in `index.html`.

## Notes on the data model

- Matching between the Inventory sheet and the dashboard is always by
  `Stock #`.
- Dashboard-only fields (on-site/off-site, assigned-to, notes, the red
  attention flag) are never touched by a sync except at initial vehicle
  creation, or when a stage change resets the location to that stage's
  default.
- The red flag (🚩 button on every card) is a plain attention marker — click
  to raise or clear it, no PIN required. It survives syncs the same way
  notes and assigned-to do, and carries over if the vehicle moves to Sold
  History before someone clears it.
- A Stock # that drops out of the Inventory sheet is never silently
  deleted — it's flagged in a notice banner on the next sync.
- Full behavioral spec (stage derivation order, metrics thresholds, on-site
  defaults by stage, etc.) is documented inline as comments in `index.html`
  next to the code that implements each rule.

## Two different locks — don't confuse them

- **Dashboard access password** (set via the Sheet's Recon Dashboard menu,
  checked in `Code.gs`): gates *viewing the data at all*. Enforced
  server-side — Apps Script refuses to return inventory or dashboard data
  without the right password, regardless of what the browser sends. This is
  real access control, and it's the one this section is about.
- **Location-edit PIN** (default `4817`, set as `EDIT_PIN` in `index.html`):
  a separate, much lower-stakes lock that only gates the On-Site/Off-Site
  toggle for people who *already* passed the access password above. It's a
  convenience speed bump only, checked in the browser and visible to anyone
  who views page source — it's meant to slow down accidental taps from the
  sales floor, not to stop a deliberate bypass.

**Limitations of the access password worth knowing:** it's one shared
password for everyone (not individual logins), there's no lockout after
repeated wrong guesses, and it's sent as a URL query parameter on read
requests (so it can appear in Apps Script's own execution logs). That's an
appropriate tradeoff for an internal dealership tool — it stops a stranger
who finds the Pages URL from seeing inventory — but it isn't the same
security bar as a real per-user login system.
