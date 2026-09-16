/**
 * The 99 — Follow-Up API
 * ===========================================================================
 * This replaces the old page-serving web app. It no longer renders HTML; the
 * pages are now a static PWA that calls these actions and gets JSON back.
 *
 * The spreadsheet stays the single source of truth. Nothing here writes to
 * Youths!Latest_Followup — that column is a MAX(FILTER(...)) formula over
 * 'FollowUp Logs' and recalculates itself once a log row is appended.
 *
 * ---------------------------------------------------------------------------
 * DEPLOY
 *   Deploy > New deployment > Web app
 *     Execute as:      Me
 *     Who has access:  Anyone
 *
 *   "Anyone" is required so the PWA can call this from its own origin. It does
 *   NOT make the data public: every action verifies a Google ID token and
 *   matches its email against the Servants sheet.
 *
 * ROLES
 *   Add a "Role" column to the Servants sheet. Put Leader (or Admin) in it for
 *   anyone who should see the dashboard, the shepherds list, and every flock.
 *   Blank means an ordinary servant: their own flock only.
 * ---------------------------------------------------------------------------
 */

var SPREADSHEET_ID = '1v4CpILHr2ZuN2SeCfBh-HS6sCSDTRCsFJoJ1Y7X1p50';

var SHEETS = {
  youths:   'Youths',
  servants: 'Servants',
  logs:     'FollowUp Logs'
};

/** Days since last reach-out. Mirrors the thresholds the pages have always used. */
var FOLD_DAYS   = 30;   // <= 30            -> In the Fold
var WANDER_DAYS = 60;   // 31..60           -> Wandering
                        // > 60, or never   -> Lost Sheep

var FOLLOWUP_TYPES = ['WhatsApp', 'Call', 'Home Visit', 'Outing'];

// ===========================================================================
// Setup / self-test
// ===========================================================================

/**
 * RUN THIS ONCE from the editor, before your first deployment, and again any
 * time you see an authorization error.
 *
 *   1. Select "setup" in the toolbar's function dropdown
 *   2. Click Run
 *   3. Approve the permissions Google asks for
 *   4. Read the report in the Execution log
 *
 * Running it forces Google to grant both scopes this script needs — reading the
 * spreadsheet, and the outbound call that verifies each sign-in token. An older
 * authorization that predates those will otherwise fail at request time with
 * "You do not have permission to call UrlFetchApp.fetch".
 */
function setup() {
  var report = [];
  var failed = false;

  function ok(label, detail)   { report.push('OK    ' + label + (detail ? ' — ' + detail : '')); }
  function bad(label, detail)  { failed = true; report.push('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
  function note(label, detail) { report.push('note  ' + label + (detail ? ' — ' + detail : '')); }

  // 1. Spreadsheet access (grants the spreadsheets scope).
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    ok('Spreadsheet', ss.getName());

    [SHEETS.youths, SHEETS.servants, SHEETS.logs].forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (sh) ok('Sheet "' + name + '"', (sh.getLastRow() - 1) + ' rows');
      else bad('Sheet "' + name + '"', 'not found');
    });
  } catch (e) {
    bad('Spreadsheet', e.message);
  }

  // 2. Outbound request (grants script.external_request — the scope that fails
  //    if the script was authorized before this code existed).
  try {
    var res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=setup-probe',
      { muteHttpExceptions: true });
    // A 400 is the expected, correct answer to a deliberately invalid token.
    ok('Outbound requests', 'Google replied ' + res.getResponseCode());
  } catch (e) {
    bad('Outbound requests', e.message);
  }

  // 3. Script properties.
  var clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) {
    bad('GOOGLE_CLIENT_ID', 'not set — Project Settings > Script properties');
  } else if (clientId.slice(-24) !== '.apps.googleusercontent.com'.slice(-24)) {
    bad('GOOGLE_CLIENT_ID', 'should end in .apps.googleusercontent.com');
  } else {
    ok('GOOGLE_CLIENT_ID', clientId.slice(0, 18) + '…');
  }

  var leaders = PropertiesService.getScriptProperties().getProperty('LEADER_EMAILS');
  note('LEADER_EMAILS', leaders || '(none — using the Servants sheet Role column)');

  // 4. The access list, and who can see everything.
  try {
    var t = table(SHEETS.servants);
    var iMail = pick(t.index, ['Mail', 'Email', 'E-mail']);
    var iRole = pick(t.index, ['Role', 'Access', 'Level']);

    if (iMail == null) {
      bad('Servants.Mail column', 'missing — nobody can sign in');
    } else {
      var withMail = 0, leaderNames = [];
      for (var r = 0; r < t.rows.length; r++) {
        if (String(t.rows[r][iMail] || '').trim()) withMail++;
        if (iRole != null) {
          var role = String(t.rows[r][iRole] || '').trim().toLowerCase();
          if (role.indexOf('leader') !== -1 || role.indexOf('admin') !== -1) {
            leaderNames.push(String(t.rows[r][t.index.Full_Name] || '?').trim());
          }
        }
      }
      ok('Servants with an email', String(withMail));
      if (iRole == null) {
        bad('Servants.Role column', 'missing — nobody can open the dashboard');
      } else if (!leaderNames.length) {
        bad('Leaders', 'no row has Role = Leader — nobody can open the dashboard');
      } else {
        ok('Leaders', leaderNames.join(', '));
      }
    }
  } catch (e) {
    bad('Servants sheet', e.message);
  }

  var out = '\n' + report.join('\n') +
    '\n\n' + (failed ? '>>> Something needs fixing — see the FAIL lines above.'
                     : '>>> All good. Deploy > Manage deployments > edit > New version > Deploy.');
  Logger.log(out);
  return out;
}

// ===========================================================================
// Entry points
// ===========================================================================

function doGet(e) {
  if (!e || !e.parameter || !e.parameter.action) {
    return json({ ok: true, service: 'the99-api', version: 2 });
  }
  return handle(e.parameter);
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: { code: 400, message: 'Malformed request body' } });
  }
  return handle(req);
}

function handle(req) {
  try {
    var user = authenticate(req.idToken);
    var payload = req.payload || {};

    switch (req.action) {
      case 'bootstrap':   return json({ ok: true, data: bootstrap(user) });
      case 'flock':       return json({ ok: true, data: getFlock(user, payload) });
      case 'logFollowup': return json({ ok: true, data: logFollowUp(user, payload) });
      case 'updateNotes': return json({ ok: true, data: updateNotes(user, payload) });
      case 'dashboard':   return json({ ok: true, data: getDashboardData(user) });
      default:
        throw httpError(400, 'Unknown action: ' + req.action);
    }
  } catch (err) {
    var code = (err && err.httpCode) ? err.httpCode : 500;
    return json({ ok: false, error: { code: code, message: String((err && err.message) || err) } });
  }
}

// ===========================================================================
// Auth — the Servants sheet is the access list
// ===========================================================================

function authenticate(idToken) {
  if (!idToken) throw httpError(401, 'Sign-in required');

  var clientId = prop('GOOGLE_CLIENT_ID', true);
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));

  var info;
  var cached = cache.get(key);
  if (cached) {
    info = JSON.parse(cached);
  } else {
    var res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      throw httpError(401, 'Your sign-in has expired. Please sign in again.');
    }
    info = JSON.parse(res.getContentText());

    if (info.aud !== clientId) throw httpError(401, 'Token was not issued for this app');
    if (String(info.email_verified) !== 'true') throw httpError(401, 'Email is not verified');

    var msLeft = Number(info.exp) * 1000 - Date.now();
    if (msLeft <= 0) throw httpError(401, 'Your sign-in has expired. Please sign in again.');

    // Never cache a verification beyond the token's own lifetime.
    cache.put(key, JSON.stringify(info), Math.max(1, Math.min(1800, Math.floor(msLeft / 1000) - 60)));
  }

  var email = String(info.email || '').trim().toLowerCase();
  if (!email) throw httpError(401, 'No email on the sign-in token');

  var servant = findServant(email);
  if (!servant) {
    throw httpError(403,
      'This account is not on the Servants list.\n\n' + email +
      '\n\nAsk a leader to add it to the Servants sheet.');
  }

  return {
    email: email,
    name: servant.name,
    year: servant.year,
    mobile: servant.mobile,
    isLeader: servant.isLeader,
    picture: info.picture || ''
  };
}

/** Looks the caller up by the Mail column, and reads the optional Role column. */
function findServant(email) {
  var t = table(SHEETS.servants);
  var iMail = pick(t.index, ['Mail', 'Email', 'E-mail']);
  var iName = pick(t.index, ['Full_Name', 'Full Name', 'Name']);
  var iRole = pick(t.index, ['Role', 'Access', 'Level']);

  if (iMail == null) throw httpError(500, 'The Servants sheet has no "Mail" column');

  var extraLeaders = (prop('LEADER_EMAILS') || '').split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(String);

  for (var r = 0; r < t.rows.length; r++) {
    var cell = String(t.rows[r][iMail] || '').trim().toLowerCase();
    if (!cell || cell !== email) continue;

    var role = iRole == null ? '' : String(t.rows[r][iRole] || '').trim().toLowerCase();
    return {
      name:   String(t.rows[r][iName] || '').trim(),
      year:   iName == null ? '' : normYear(t.rows[r][t.index.Year]),
      mobile: t.index.Mobile == null ? '' : String(t.rows[r][t.index.Mobile] || ''),
      isLeader: role.indexOf('leader') !== -1 || role.indexOf('admin') !== -1 ||
                extraLeaders.indexOf(email) !== -1
    };
  }
  return null;
}

function requireLeader(user) {
  if (!user.isLeader) {
    throw httpError(403, 'This page is for leaders only.');
  }
}

// ===========================================================================
// Actions
// ===========================================================================

function bootstrap(user) {
  return {
    user: {
      name: user.name,
      email: user.email,
      year: user.year,
      isLeader: user.isLeader,
      picture: user.picture
    },
    followupTypes: FOLLOWUP_TYPES,
    thresholds: { fold: FOLD_DAYS, wander: WANDER_DAYS },
    serverTime: new Date().toISOString()
  };
}

/**
 * One servant's flock. A servant may only read their own; a leader may pass
 * ?servant= to read anyone's. This is the check the old ?servant= URL lacked.
 */
function getFlock(user, payload) {
  var who = String(payload.servant || '').trim();
  if (!who || !user.isLeader) who = user.name;
  if (who !== user.name && !user.isLeader) requireLeader(user);

  var t = table(SHEETS.youths);
  var lastLog = lastFollowupByYouth();
  var wanted = who.toLowerCase();
  var out = [];

  for (var r = 0; r < t.rows.length; r++) {
    var owner = String(t.rows[r][t.index.Servant_Name] || '').trim().toLowerCase();
    if (owner !== wanted) continue;
    out.push(youthObject(t, t.rows[r], lastLog));
  }

  return { servant: who, youths: out, isOwnFlock: who === user.name };
}

/** Appends one reach-out. Latest_Followup recalculates itself in the sheet. */
function logFollowUp(user, payload) {
  var youthId = String(payload.youthId || '').trim();
  var type = String(payload.type || '').trim();
  var successful = (payload.successful === true || payload.successful === 'Yes');

  if (!youthId) throw httpError(400, 'Missing youthId');
  if (FOLLOWUP_TYPES.indexOf(type) === -1) {
    throw httpError(400, 'Type must be one of: ' + FOLLOWUP_TYPES.join(', '));
  }

  var youth = findYouth(youthId);
  if (!youth) throw httpError(404, 'No youth with id ' + youthId);
  // The old app let anyone edit the URL and log against another flock.
  if (!user.isLeader && youth.servantName.toLowerCase() !== user.name.toLowerCase()) {
    throw httpError(403, youth.fullName + ' is not in your flock.');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw httpError(503, 'The sheet is busy — please try again.');
  try {
    var sheet = sheetByName(SHEETS.logs);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(function (h) { return String(h).trim(); });

    var when = new Date();
    var values = {
      'Date': when,
      'Youth_ID': youth.youthId,
      'Youth_Name': youth.fullName,
      'Servant_Name': youth.servantName || user.name,
      'Year': youth.year,
      'Gender': youth.gender,
      'Type': type,
      'Successful?': successful ? 'Yes' : 'No',
      // Written only if you add these headers; ignored otherwise.
      'Note': String(payload.note || ''),
      'Logged_By': user.email
    };

    sheet.appendRow(headers.map(function (h) {
      return Object.prototype.hasOwnProperty.call(values, h) ? values[h] : '';
    }));

    return {
      youthId: youth.youthId,
      youthName: youth.fullName,
      type: type,
      successful: successful ? 'Yes' : 'No',
      date: Utilities.formatDate(when, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    };
  } finally {
    lock.releaseLock();
  }
}

/** Saves the Notes cell for one youth, with the ownership check the old one skipped. */
function updateNotes(user, payload) {
  var youthId = String(payload.youthId || '').trim();
  var notes = String(payload.notes == null ? '' : payload.notes);

  var youth = findYouth(youthId);
  if (!youth) throw httpError(404, "Youth_ID '" + youthId + "' not found in sheet.");
  if (!user.isLeader && youth.servantName.toLowerCase() !== user.name.toLowerCase()) {
    throw httpError(403, youth.fullName + ' is not in your flock.');
  }

  var t = table(SHEETS.youths);
  var col = pick(t.index, ['Notes', 'notes']);
  if (col == null) throw httpError(500, "Column 'Notes' not found in sheet.");

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw httpError(503, 'The sheet is busy — please try again.');
  try {
    sheetByName(SHEETS.youths).getRange(youth.rowNumber, col + 1).setValue(notes);
    return { youthId: youth.youthId, notes: notes };
  } finally {
    lock.releaseLock();
  }
}

/** Everything the dashboard and shepherds pages need. Leaders only. */
function getDashboardData(user) {
  requireLeader(user);

  var t = table(SHEETS.youths);
  var lastLog = lastFollowupByYouth();
  var youths = [];
  for (var r = 0; r < t.rows.length; r++) {
    if (!String(t.rows[r][t.index.Youth_ID] || '').trim()) continue;
    youths.push(youthObject(t, t.rows[r], lastLog));
  }

  var tl = table(SHEETS.logs);
  var followUps = [];
  for (var i = 0; i < tl.rows.length; i++) {
    var row = tl.rows[i];
    if (!String(row[tl.index.Youth_ID] || '').trim()) continue;
    var obj = {};
    tl.headers.forEach(function (h, j) { if (h) obj[h] = plain(row[j]); });
    followUps.push(obj);
  }

  return { youths: youths, followUps: followUps };
}

// ===========================================================================
// Sheet helpers
// ===========================================================================

function youthObject(t, row, lastLog) {
  var obj = {};
  t.headers.forEach(function (h, j) { if (h) obj[h] = plain(row[j]); });

  // Latest_Followup is a formula and reads #N/A for a youth with no logs.
  // Resolve it from the log itself so the pages get a real value or a clean null.
  var id = String(obj.Youth_ID || '').trim();
  var fromLog = lastLog[id] || null;
  obj.Latest_Followup = fromLog
    ? Utilities.formatDate(fromLog, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : null;

  obj.Year = normYear(obj.Year);
  return obj;
}

function spreadsheet() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function sheetByName(name) {
  var sh = spreadsheet().getSheetByName(name);
  if (!sh) throw httpError(500, 'Missing sheet: "' + name + '"');
  return sh;
}

/** Reads a sheet into { headers, index, rows }; columns are found by name. */
function table(name) {
  var sh = sheetByName(name);
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { headers: [], index: {}, rows: [] };

  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var index = {};
  headers.forEach(function (h, i) { if (h && index[h] == null) index[h] = i; });
  return { headers: headers, index: index, rows: values.slice(1) };
}

function findYouth(youthId) {
  var t = table(SHEETS.youths);
  for (var r = 0; r < t.rows.length; r++) {
    if (String(t.rows[r][t.index.Youth_ID] || '').trim() === youthId) {
      return {
        youthId: youthId,
        fullName: String(t.rows[r][t.index.Full_Name] || '').trim(),
        servantName: String(t.rows[r][t.index.Servant_Name] || '').trim(),
        gender: String(t.rows[r][t.index.Gender] || '').trim(),
        year: normYear(t.rows[r][t.index.Year]),
        rowNumber: r + 2   // 1-based, plus the header row
      };
    }
  }
  return null;
}

/** Youth_ID -> most recent follow-up Date, read straight from the log. */
function lastFollowupByYouth() {
  var t = table(SHEETS.logs);
  var out = {};
  for (var r = 0; r < t.rows.length; r++) {
    var id = String(t.rows[r][t.index.Youth_ID] || '').trim();
    if (!id) continue;
    var d = toDate(t.rows[r][t.index.Date]);
    if (!d) continue;
    if (!out[id] || d.getTime() > out[id].getTime()) out[id] = d;
  }
  return out;
}

// ===========================================================================
// Utilities
// ===========================================================================

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function httpError(code, message) {
  var e = new Error(message);
  e.httpCode = code;
  return e;
}

function prop(key, required) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !v) throw httpError(500, 'Script property "' + key + '" is not set');
  return v;
}

/** First matching header index from a list of acceptable spellings. */
function pick(index, names) {
  for (var i = 0; i < names.length; i++) {
    if (index[names[i]] != null) return index[names[i]];
  }
  return null;
}

/** Dates become yyyy-MM-dd strings, matching what the pages already expect. */
function plain(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (v == null) return '';
  // A formula error such as #N/A arrives as a string; treat it as empty.
  if (typeof v === 'string' && v.charAt(0) === '#' && v.toUpperCase() === v) return '';
  return v;
}

/** "1.0" / 1 / "Year 1" all become "1". */
function normYear(v) {
  if (v === '' || v == null) return '';
  var n = Number(v);
  if (!isNaN(n) && isFinite(n)) return String(Math.round(n));
  return String(v).trim();
}

/** Handles real Dates, spreadsheet serial numbers and date strings alike. */
function toDate(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' && isFinite(v) && v > 0) {
    return new Date(Math.round((v - 25569) * 86400000));   // days since 1899-12-30
  }
  var s = String(v || '').trim();
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
