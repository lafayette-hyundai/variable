/**
 * Lafayette Hyundai Recon Line — Apps Script backend.
 *
 * Bind this script to the dealership's inventory Google Sheet
 * (Extensions → Apps Script from within the sheet). It exposes a small
 * JSON API that the dashboard (index.html, hosted on GitHub Pages) talks to.
 *
 * The Inventory tab is the dealership's existing, human-maintained sheet —
 * this script only ever reads it. All dashboard-only state (on-site/off-site,
 * assigned-to, notes, stage history, sold-history records, etc.) lives in a
 * second tab this script owns and creates automatically: "Dashboard Data".
 * Every dashboard load/save is a single batch read or a single batch write
 * against that tab — never one read/write per row — to keep syncs fast and
 * avoid hammering the Sheets API on a large board.
 *
 * All the actual business logic (stage derivation, location defaults,
 * metrics, reconciliation, Wholesale/incomplete-data handling) lives in the
 * dashboard's own JavaScript, unchanged from the CSV-import version. This
 * script is intentionally a thin data-access layer: read the Inventory
 * sheet as JSON, and read/write the Dashboard Data tab as JSON.
 *
 * ---- Setup ----
 * 1. Open the inventory Google Sheet. Confirm the tab with the real data is
 *    named exactly as INVENTORY_SHEET_NAME below (or change the constant to
 *    match your tab name) and that its header row matches the columns this
 *    dashboard expects: Stock #, VIN, YMM, To Service, From Service,
 *    To Detail, From Detail, Photos Uploaded, Include/Exclude, Sold Date,
 *    Disposition.
 * 2. Extensions → Apps Script. Delete the default Code.gs contents and
 *    paste this whole file in. Save.
 * 3. Deploy → New deployment → type "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Deploy, authorize the requested permissions, and copy the resulting
 *    "/exec" URL.
 * 4. Paste that URL into APPS_SCRIPT_URL near the top of index.html.
 * 5. Reload the dashboard and click "Sync Now". A "Dashboard Data" tab will
 *    be created automatically the first time the script runs.
 */

const INVENTORY_SHEET_NAME = 'Inventory';
const DASHBOARD_SHEET_NAME = 'Dashboard Data';

// Column order for the Dashboard Data tab. "recordType" distinguishes an
// active board vehicle from a sold-history record — Stock # is unique
// across the two by construction of the reconciliation logic, so one flat
// table can hold both.
const DASHBOARD_HEADERS = [
  'id', 'recordType', 'stock', 'vin', 'ymm', 'stage',
  'onSite', 'subLocation', 'assignedTo', 'notes', 'stageEnteredAt',
  'toServiceDate', 'fromServiceDate', 'toDetailDate', 'fromDetailDate',
  'readyAt', 'soldAt', 'daysToFrontline', 'daysInInventory',
  'includeInAvg', 'legacyIncomplete',
];
const DATE_FIELDS = [
  'stageEnteredAt', 'toServiceDate', 'fromServiceDate',
  'toDetailDate', 'fromDetailDate', 'readyAt', 'soldAt',
];
const NUMBER_FIELDS = ['daysToFrontline', 'daysInInventory'];
const BOOL_TRUE_DEFAULT_FIELDS = ['includeInAvg']; // absent/blank => true
const BOOL_FALSE_DEFAULT_FIELDS = ['onSite', 'legacyIncomplete']; // absent/blank => false

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === 'inventory') return jsonOut(getInventoryRows());
    if (action === 'state') return jsonOut(getState());
    return jsonOut({ error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonOut({ error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'saveState') {
      saveState(body.vehicles || {}, body.soldRecords || {});
      return jsonOut({ ok: true });
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

/** Reads the Inventory tab and returns one JSON object per row, keyed by
 *  header name — the same shape the dashboard used to get from a parsed
 *  CSV export. */
function getInventoryRows() {
  const sh = SpreadsheetApp.getActive().getSheetByName(INVENTORY_SHEET_NAME);
  if (!sh) throw new Error('No sheet tab named "' + INVENTORY_SHEET_NAME + '" — check INVENTORY_SHEET_NAME in Code.gs.');
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(h => String(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(c => c === '' || c === null)) continue; // skip fully blank rows
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cellToString(row[idx]); });
    rows.push(obj);
  }
  return rows;
}

function cellToString(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'America/Indiana/Indianapolis', 'yyyy-MM-dd');
  }
  return String(v);
}

function getDashboardSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(DASHBOARD_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(DASHBOARD_SHEET_NAME);
    sh.getRange(1, 1, 1, DASHBOARD_HEADERS.length).setValues([DASHBOARD_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Reads the whole Dashboard Data tab in one batch call and splits it back
 *  into {vehicles, soldRecords} keyed by id, matching the shape the
 *  dashboard keeps in memory. */
function getState() {
  const sh = getDashboardSheet();
  const lastRow = sh.getLastRow();
  const vehicles = {};
  const soldRecords = {};
  if (lastRow < 2) return { vehicles, soldRecords };

  const values = sh.getRange(2, 1, lastRow - 1, DASHBOARD_HEADERS.length).getValues();
  values.forEach(row => {
    const obj = {};
    DASHBOARD_HEADERS.forEach((h, idx) => { obj[h] = row[idx]; });
    if (!obj.id) return; // skip stray blank rows

    DATE_FIELDS.forEach(f => { obj[f] = normalizeDate(obj[f]); });
    NUMBER_FIELDS.forEach(f => { obj[f] = normalizeNumber(obj[f]); });
    BOOL_TRUE_DEFAULT_FIELDS.forEach(f => { obj[f] = normalizeBool(obj[f], true); });
    BOOL_FALSE_DEFAULT_FIELDS.forEach(f => { obj[f] = normalizeBool(obj[f], false); });

    const recordType = obj.recordType;
    delete obj.recordType;
    if (recordType === 'sold') soldRecords[obj.id] = obj;
    else vehicles[obj.id] = obj;
  });
  return { vehicles, soldRecords };
}

function normalizeDate(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
function normalizeNumber(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function normalizeBool(v, defaultVal) {
  if (v === '' || v === null || v === undefined) return defaultVal;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  return s === 'true';
}

/** Overwrites the Dashboard Data tab with the given state in one clear +
 *  one write, regardless of how many rows there are — mirrors the
 *  dashboard's own single-combined-write discipline on its side. */
function saveState(vehicles, soldRecords) {
  const sh = getDashboardSheet();
  const rows = [];
  Object.keys(vehicles).forEach(id => rows.push(toRow(vehicles[id], 'active')));
  Object.keys(soldRecords).forEach(id => rows.push(toRow(soldRecords[id], 'sold')));

  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, DASHBOARD_HEADERS.length).clearContent();
  }
  if (rows.length > 0) {
    sh.getRange(2, 1, rows.length, DASHBOARD_HEADERS.length).setValues(rows);
  }
}

function toRow(record, recordType) {
  return DASHBOARD_HEADERS.map(h => {
    if (h === 'recordType') return recordType;
    const v = record[h];
    return (v === undefined || v === null) ? '' : v;
  });
}
