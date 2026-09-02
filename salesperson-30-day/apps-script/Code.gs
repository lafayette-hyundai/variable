/**
 * Salesperson 30 Day Report — Apps Script backend.
 *
 * Bind this script to a dedicated Google Sheet (create a blank one just for
 * this — it doesn't need any existing data). It does two jobs:
 *
 *  1. Watches the inbox for the daily "Digital Retail Report" CSV email
 *     (from reportscheduler@motosnap.com) and ingests it automatically —
 *     no manual export/upload for the normal day-to-day case.
 *  2. Exposes a small JSON API (like the Recon dashboard's Code.gs) that
 *     the dashboard reads from and posts manual backfills to.
 *
 * All the metrics math (close rate, appointment funnel rates, date-range
 * rollups) lives in the dashboard's own JavaScript, not here — same
 * separation of concerns as Recon. This script only ingests and serves
 * rows; it doesn't compute or interpret anything.
 *
 * ---- Why counts, not percentages ----
 * The report is configured to export raw integer counts (Good Leads, Sold
 * in Time Frame, Appts Set, Appts Shown, Appts Shown Sold) rather than
 * percentages. Percentages can't be correctly averaged across multiple
 * days (a weighted ratio needs the underlying counts), so every rollup —
 * daily, weekly, monthly, custom range — is computed by summing raw counts
 * across whatever date range is selected and dividing, entirely on the
 * dashboard side. Keep the report configured for counts; if it ever gets
 * switched back to percentages, ingestion will still run but the numbers
 * it stores will be wrong.
 *
 * ---- Setup ----
 * 1. Create a new, blank Google Sheet for this (e.g. "Salesperson 30 Day
 *    Report Data"). Open Extensions → Apps Script, delete the default
 *    Code.gs contents, and paste this whole file in. Save.
 * 2. In the Apps Script editor's function dropdown (top toolbar), select
 *    `installDailyTrigger` and click Run once. Authorize the requested
 *    permissions (Gmail read, Sheets read/write, and the ability to run on
 *    a schedule). This creates a daily trigger (see CHECK_HOUR below —
 *    defaults to 11am, an hour after the report's 10am delivery) that
 *    watches for the report email — you only need to run it once, ever.
 * 3. Deploy → New deployment → type "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Deploy, authorize again if prompted, and copy the resulting "/exec"
 *    URL into APPS_SCRIPT_URL near the top of index.html.
 * 4. Reload the Sheet so the "Salesperson Report" menu appears, then use
 *    it to set an access password — same convenience-vs-security tradeoff
 *    as the Recon dashboard's password. Until you do, the dashboard is NOT
 *    password-protected.
 * 5. To backfill history immediately instead of waiting for tomorrow's
 *    email, use the menu's "Run Import Now" — it checks for any
 *    already-arrived, not-yet-processed report emails right away.
 *
 * A "Daily Data" tab will be created automatically the first time this
 * script writes anything. Don't create it manually — the script owns its
 * columns.
 */

const REPORT_SENDER = 'reportscheduler@motosnap.com';
const REPORT_SUBJECT_HINT = 'Digital Retail Report';
const PROCESSED_LABEL_NAME = 'DRR-Processed';
const DATA_SHEET_NAME = 'Daily Data';

// Appending a new field here is safe for a sheet that already has data —
// getDataSheet() extends the header row automatically, and old rows just
// read back blank for whatever's new. Never reorder or remove an existing
// entry — that would shift every column out from under already-saved data.
const DATA_HEADERS = [
  'date', 'salesperson', 'inventoryType', 'leadType',
  'goodLeads', 'soldInTimeFrame', 'apptsSet', 'apptsShown', 'apptsShownSold',
];

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === 'state') {
      if (!checkAccess(e.parameter.key)) return unauthorizedOut();
      return jsonOut({ rows: getAllRows() });
    }
    return jsonOut({ error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonOut({ error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'backfillDay') {
      if (!checkAccess(body.key)) return unauthorizedOut();
      if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw new Error('Invalid or missing date (expected yyyy-MM-dd).');
      if (!Array.isArray(body.rows)) throw new Error('Missing rows array.');
      ingestDayRows(body.date, body.rows);
      return jsonOut({ ok: true, count: body.rows.length });
    }
    return jsonOut({ error: 'Unknown action: ' + body.action });
  } catch (err) {
    return jsonOut({ error: String(err && err.message ? err.message : err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function unauthorizedOut() {
  return jsonOut({ error: 'Incorrect password.', unauthorized: true });
}

// ---------------- access control (same pattern as Recon's Code.gs) ----------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Salesperson Report')
    .addItem('Set/Change Access Password', 'setAccessKey')
    .addItem('Run Import Now', 'checkForNewReport')
    .addToUi();
}

function setAccessKey() {
  const ui = SpreadsheetApp.getUi();
  const result = ui.prompt(
    'Set Dashboard Access Password',
    'Enter the password dashboard viewers will need to enter. Leave blank and press OK to remove password protection entirely.',
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() !== ui.Button.OK) return;
  const value = result.getResponseText().trim();
  if (value === '') {
    PropertiesService.getScriptProperties().deleteProperty('ACCESS_KEY');
    ui.alert('Password protection removed — anyone with the dashboard URL can now view it.');
  } else {
    PropertiesService.getScriptProperties().setProperty('ACCESS_KEY', value);
    ui.alert('Password set. Share it only with staff who should have dashboard access.');
  }
}

function checkAccess(providedKey) {
  const real = PropertiesService.getScriptProperties().getProperty('ACCESS_KEY');
  if (!real) return true;
  return providedKey === real;
}

// ---------------- Gmail ingestion ----------------

// Runs at 11am — an hour after the report's 10am delivery, since
// Apps Script's atHour() fires sometime within that hour, not at an exact
// minute. If the report's delivery time ever changes, update CHECK_HOUR to
// stay at least an hour after it and re-run this function (it replaces any
// existing trigger for checkForNewReport, so it's safe to run again).
const CHECK_HOUR = 11;

function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkForNewReport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkForNewReport')
    .timeBased()
    .everyDays(1)
    .atHour(CHECK_HOUR)
    .create();
}

function getOrCreateProcessedLabel_() {
  let label = GmailApp.getUserLabelByName(PROCESSED_LABEL_NAME);
  if (!label) label = GmailApp.createLabel(PROCESSED_LABEL_NAME);
  return label;
}

// Finds any not-yet-processed report emails and ingests their attachment.
// Safe to run repeatedly (daily trigger, or manually via the menu) — a
// thread is only labeled processed once its attachment has been parsed
// and written successfully, so a failure leaves it to retry next time
// instead of silently skipping that day.
function checkForNewReport() {
  const label = getOrCreateProcessedLabel_();
  const query = 'from:(' + REPORT_SENDER + ') subject:(' + REPORT_SUBJECT_HINT + ') -label:' + PROCESSED_LABEL_NAME + ' has:attachment';
  const threads = GmailApp.search(query, 0, 20);
  threads.forEach(thread => {
    let ok = true;
    thread.getMessages().forEach(msg => {
      const atts = msg.getAttachments().filter(a => /\.csv$/i.test(a.getName() || ''));
      if (atts.length === 0) return;
      try {
        const rows = parseCsv(atts[0].getDataAsString());
        if (rows.length > 0) {
          // The report covers "yesterday" relative to when it was sent —
          // anchored to the email's own send time, not to whenever this
          // trigger happens to run, so a late-running trigger still files
          // the data under the correct date.
          const targetDate = new Date(msg.getDate().getTime() - 24 * 60 * 60 * 1000);
          const dateStr = Utilities.formatDate(targetDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
          ingestDayRows(dateStr, rows);
        }
      } catch (err) {
        console.error('Failed to ingest report email in thread ' + thread.getId() + ': ' + err);
        ok = false;
      }
    });
    if (ok) thread.addLabel(label);
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = ''; rows.push(row); row = [];
      } else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
  if (nonEmpty.length === 0) return [];
  const headers = nonEmpty[0].map(h => h.trim());
  const out = [];
  for (let r = 1; r < nonEmpty.length; r++) {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (nonEmpty[r][idx] !== undefined) ? nonEmpty[r][idx].trim() : ''; });
    out.push(obj);
  }
  return out;
}

// ---------------- Daily Data sheet ----------------

function getDataSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(DATA_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(DATA_SHEET_NAME);
    sh.getRange(1, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS]);
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < DATA_HEADERS.length) {
    sh.getRange(1, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS]);
  }
  return sh;
}

function toInt_(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : Math.round(n);
}

function dateStrOf_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v || '');
}

// Overwrites whatever's stored for this date with the given rows — makes
// ingestion idempotent (safe to reprocess the same email twice) and makes
// a manual backfill or a corrected re-send simply replace, not duplicate,
// that day's numbers.
function ingestDayRows(dateStr, rawRows) {
  const sh = getDataSheet();
  removeRowsForDate_(sh, dateStr);
  const dateObj = new Date(dateStr + 'T00:00:00');
  const values = rawRows
    .filter(r => (r['User'] || '').trim() !== '')
    .map(r => [
      dateObj,
      (r['User'] || '').trim(),
      (r['Inventory Type'] || '').trim(),
      (r['Lead Type'] || '').trim(),
      toInt_(r['Good Leads']),
      toInt_(r['Sold in Time Frame']),
      toInt_(r['Appts Set']),
      toInt_(r['Appts Shown']),
      toInt_(r['Appts Shown Sold']),
    ]);
  if (values.length > 0) {
    const startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, values.length, DATA_HEADERS.length).setValues(values);
  }
}

function removeRowsForDate_(sh, dateStr) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  const dates = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  // Delete bottom-up so row indices don't shift out from under the loop.
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dateStrOf_(dates[i][0]) === dateStr) {
      sh.deleteRow(i + 2);
    }
  }
}

// Returns every stored row as a plain object keyed by DATA_HEADERS. The
// dashboard does all filtering, date-range summing, and rate calculation
// itself — this just hands over the raw daily records.
function getAllRows() {
  const sh = getDataSheet();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, DATA_HEADERS.length).getValues();
  return values
    .filter(row => row[0])
    .map(row => {
      const obj = {};
      DATA_HEADERS.forEach((h, idx) => { obj[h] = row[idx]; });
      obj.date = dateStrOf_(obj.date);
      return obj;
    });
}
