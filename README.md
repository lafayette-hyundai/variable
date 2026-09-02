# Rohrman Automotive Dashboards

A small portal of internal dashboards for Lafayette Hyundai, hosted on
GitHub Pages. Each dashboard is its own self-contained page in its own
folder; a landing page at the root links between them.

| Tab (what we call it) | Lives at | Status |
|---|---|---|
| **Used Car Recon** | `recon/index.html` | Live |
| **Salesperson 30 Day Report** | `salesperson-30-day/index.html` | Live |

When referring to a specific dashboard in conversation, use the name from
the **Tab** column above (e.g. "Used Car Recon") — it maps directly to a
folder, so there's no ambiguity about which page/code is meant. When a new
dashboard gets built, add a row here with its folder so the mapping stays
current.

- **`index.html`** — the landing page. Lists available dashboards as cards,
  and carries the same cross-dashboard nav strip (`.portal-tabs`) that
  appears at the top of every dashboard page.
- **`recon/index.html`** — the Used Car Recon dashboard. A single
  self-contained page; all its business logic (stage derivation, location
  defaults, metrics, reconciliation rules) lives here, in JavaScript.
- **`apps-script/Code.gs`** — the Used Car Recon backend. A Google Apps
  Script Web App bound to the dealership's inventory Google Sheet. It's a
  thin data-access layer only: it reads the Inventory tab and reads/writes
  a dashboard-only "Dashboard Data" tab it creates automatically. It does
  not contain any of the stage/metrics logic — that all lives in
  `recon/index.html`.
- **`salesperson-30-day/index.html`** — the Salesperson 30 Day Report
  dashboard. Self-contained like Recon; all its date-range math and rate
  calculations (close rate, appointment funnel) live here in JavaScript.
- **`salesperson-30-day/apps-script/Code.gs`** — its backend, a separate
  Apps Script Web App bound to its own dedicated Google Sheet (not the
  Recon spreadsheet). It watches the same Google account's inbox for the
  daily "Digital Retail Report" CSV email from VinSolutions and ingests it
  automatically, plus serves the stored data to the dashboard and accepts
  manual backfills. No metrics logic here either — thin data layer only,
  same philosophy as Recon's backend.

Each dashboard's backend is its own separate Apps Script project — they
don't share code or a spreadsheet, even though this one happens to read
from the same Google account's inbox as Recon's spreadsheet lives in.

## Adding a new dashboard tab

1. Create a new folder at the repo root (e.g. `salesperson-30-day/`) with
   its own self-contained `index.html` — same pattern as `recon/`: inline
   CSS/JS, no build step, talks to its own backend (if any) via an absolute
   URL so the file can be moved around freely.
2. Copy the `.portal-tabs` nav block from `recon/index.html` (or this
   file's own copy in `index.html`) into the new page, marking its own tab
   `active` instead of Used Car Recon's.
3. Update the nav block in **every** existing page (`index.html` and every
   dashboard's `index.html`) to add the new tab — there's no shared
   template, so each copy has to be edited individually.
4. Add a row to the table at the top of this README.

No changes to GitHub Pages settings are needed for any of this — Pages
already serves the whole repo from this branch's root, so a new folder is
live the moment it's pushed.

## Used Car Recon: one-time setup

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

Open `recon/index.html` in this repo and find this line near the top of the
`<script>` block:

```js
const APPS_SCRIPT_URL = 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';
```

Replace the placeholder with the `/exec` URL from step 6 above. Commit and
push.

### 4. GitHub Pages

In the repo's **Settings → Pages**, set the source to deploy from this
branch's root. GitHub serves the whole repo — the landing page at `/`, and
Used Car Recon at `/recon/`.

### 5. First sync

Open the published Recon dashboard, enter the password from step 2, then
click **⇪ Sync Now**. This pulls every row from the Inventory tab, applies
the same stage-derivation and reconciliation rules the dashboard has always
used, and saves the result to the Dashboard Data tab. From then on, "Sync
Now" is the on-demand replacement for the old manual CSV export/import step
— no export step is needed anymore, since Apps Script reads the live sheet
directly.

## Salesperson 30 Day Report: one-time setup

### 1. Configure the VinSolutions report

In VinSolutions, the "Digital Retail Report" needs to be:
- Scheduled to **email itself daily** to the same Google account the Recon
  spreadsheet lives in (the account this dashboard's Apps Script will be
  authorized under).
- Date range set to **"Yesterday"** — not a rolling window. The report has
  no date field of its own, so a multi-day window can't be decomposed back
  into individual days; "Yesterday" gives one unambiguous day per email.
- Columns configured to show **integer counts, not percentages** — Good
  Leads, Sold in Time Frame, Appts Set, Appts Shown, Appts Shown Sold.
  Percentages can't be correctly averaged across days (a weighted ratio
  needs the underlying counts), so every rollup here is computed by the
  dashboard from raw counts. If this ever gets switched back to
  percentages, ingestion will keep running but every number it stores will
  be wrong.

Known limitation, accepted for now (see prior discussion if this changes):
a lead marked "bad" a few days after the fact won't retroactively correct
that day's already-stored numbers, since each day is only pulled once. If
this drifts enough to matter in practice, revisit — either lag the daily
pull by a few days, or fall back to a simpler view and rely on
VinSolutions' own reporting for drill-down.

### 2. Create the Google Sheet + Apps Script

1. Create a new, **blank** Google Sheet (e.g. "Salesperson 30 Day Report
   Data") in the same Google account that receives the report email. It
   doesn't need any columns set up — the script creates its own tab.
2. **Extensions → Apps Script**. Delete the default `Code.gs` contents and
   paste in the contents of `salesperson-30-day/apps-script/Code.gs` from
   this repo.
3. In the function dropdown at the top of the editor, select
   `installDailyTrigger` and click **Run** once. Authorize the requested
   permissions (Gmail read, Sheets read/write, and running on a schedule).
   This creates a daily 6am trigger that checks for the report email — a
   one-time step, not something to repeat.
4. **Deploy → New deployment** → type **Web app**. Set:
   - **Execute as:** Me
   - **Who has access:** Anyone
5. Deploy, authorize again if prompted, and copy the resulting `/exec` URL.

A tab named **"Daily Data"** will be created automatically the first time
the script ingests or is asked for data. Don't create it manually.

### 3. Set a password (do this right away)

Reload the Sheet so the **Salesperson Report** menu appears, then click
**Salesperson Report → Set/Change Access Password**. Same tradeoffs as
Recon's password — see "Two different locks" below (this dashboard only
has the one lock; there's no second PIN layer here since there's no
editable field like Recon's on-site/off-site toggle).

### 4. Point the dashboard at your deployment

Open `salesperson-30-day/index.html` and set `APPS_SCRIPT_URL` near the top
of the `<script>` block to the `/exec` URL from step 2.5 above. Commit and
push.

### 5. Backfill history (optional) or just wait

The dashboard starts empty until the first daily email arrives and gets
processed. To get data immediately instead of waiting:
- Reload the Sheet and click **Salesperson Report → Run Import Now** — this
  checks for any already-arrived report emails right away, rather than
  waiting for the 6am trigger.
- For older history predating this setup, use the dashboard's own
  **＋ Backfill a Day** button: re-run the "Digital Retail Report" in
  VinSolutions for a specific past date, paste its CSV in, and pick the
  date it covers (see "Notes on the Salesperson data model" below for why
  the date has to be entered manually).

## Redeploying Code.gs after edits

Google Apps Script Web Apps don't auto-update from a saved script — after
changing a `Code.gs` file (Recon's or the Salesperson Report's), go to
**Deploy → Manage deployments** *in that same Apps Script project*, edit
the active deployment, and choose **New version** to publish the change.
The `/exec` URL stays the same, so nothing needs to change in the
corresponding `index.html`. The two dashboards' backends are separate
projects with separate deployments — redeploying one never affects the
other.

## Notes on the Recon data model

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
  defaults by stage, etc.) is documented inline as comments in
  `recon/index.html` next to the code that implements each rule.

## Notes on the Salesperson 30 Day Report data model

- One stored row per (date, salesperson, inventory type, lead type) — the
  same breakdown VinSolutions exports. "Daily," "weekly," "monthly," and
  custom-range views are all the same operation: sum the raw counts across
  whatever rows fall in the selected date range, then compute rates from
  those sums. Nothing is ever pre-aggregated or averaged as a percentage —
  see the "why counts, not percentages" note at the top of
  `salesperson-30-day/apps-script/Code.gs` for why that distinction matters.
- Ingestion is idempotent by date: reprocessing the same day's email (or a
  manual backfill for a date that already has data) replaces that date's
  rows rather than duplicating them. A day's data is always whatever was
  ingested *last* for that date.
- The report has no date field of its own — the automated path infers the
  date from the email's own send time (yesterday relative to when
  VinSolutions sent it), which is why a manual backfill has to ask you
  which date the pasted CSV covers rather than figuring it out itself.
- The dashboard flags (but never auto-corrects) calendar dates with no data
  on file, skipping the most recent 2 days since those may simply not have
  arrived yet rather than being a real gap.
- Good Leads and "Sold in Time Frame" aren't a strict subset of each other
  — e.g. a walk-in sale can close without ever being logged as a formal
  lead. Treat the derived close rate as a trend indicator, not a precise
  "sold ÷ leads" audit figure.

## Two different locks — don't confuse them (Used Car Recon only)

The Salesperson 30 Day Report only has the one access password — there's
no second, lower-stakes lock the way Recon has, since this dashboard has
no editable field like Recon's on-site/off-site toggle to gate.

- **Dashboard access password** (set via the Sheet's Recon Dashboard menu,
  checked in `Code.gs`): gates *viewing the data at all*. Enforced
  server-side — Apps Script refuses to return inventory or dashboard data
  without the right password, regardless of what the browser sends. This is
  real access control, and it's the one this section is about.
- **Location-edit PIN** (default `4817`, set as `EDIT_PIN` in
  `recon/index.html`): a separate, much lower-stakes lock that only gates
  the On-Site/Off-Site toggle for people who *already* passed the access
  password above. It's a convenience speed bump only, checked in the
  browser and visible to anyone who views page source — it's meant to slow
  down accidental taps from the sales floor, not to stop a deliberate
  bypass.

**Limitations of the access password worth knowing:** it's one shared
password for everyone (not individual logins), there's no lockout after
repeated wrong guesses, and it's sent as a URL query parameter on read
requests (so it can appear in Apps Script's own execution logs). That's an
appropriate tradeoff for an internal dealership tool — it stops a stranger
who finds the Pages URL from seeing inventory — but it isn't the same
security bar as a real per-user login system.
