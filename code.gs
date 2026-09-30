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

/* How long a servant stays signed in. A Google ID token only lasts an hour, so
   we verify it once and then issue our own token instead — otherwise everyone
   is asked to sign in again every hour, and on iOS (where an installed app has
   its own cookie jar) silent renewal cannot work at all. The window slides:
   using the app at all refreshes it, so an active servant never signs in twice. */
var SESSION_DAYS = 30;

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

  // This property outranks the sheet, which is easy to forget once it is set.
  if (leaders) {
    var forced = leaders.split(',').map(function (x) { return x.trim().toLowerCase(); })
                        .filter(String);
    try {
      var ts = table(SHEETS.servants);
      var mCol = pick(ts.index, ['Mail', 'Email', 'E-mail']);
      var rCol = pick(ts.index, ['Role', 'Access', 'Level']);
      if (mCol != null && rCol != null) {
        for (var q = 0; q < ts.rows.length; q++) {
          var em = String(ts.rows[q][mCol] || '').trim().toLowerCase();
          if (!em || forced.indexOf(em) === -1) continue;
          var rt = String(ts.rows[q][rCol] || '').trim();
          if (rt && rt.toLowerCase().indexOf('class') !== -1) {
            bad('LEADER_EMAILS overrides the sheet',
                em + ' is "' + rt + '" in the sheet but LEADER_EMAILS forces full ' +
                'leader access. Remove the address from LEADER_EMAILS for the ' +
                'sheet Role to apply.');
          }
        }
      }
    } catch (e) { /* the Servants check below reports sheet problems */ }
  }

  // 3b. Session signing key — created here so no live request has to make it.
  try {
    var existed = !!PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
    var probe = makeSession('setup-probe@example.com');
    var back = verifySessionToken(probe.token);
    if (back.email !== 'setup-probe@example.com') throw new Error('round-trip mismatch');
    ok('Session signing', (existed ? 'key already present' : 'key created') +
       ', sessions last ' + SESSION_DAYS + ' days');
  } catch (e) {
    bad('Session signing', e.message);
  }

  // 4. The access list, and who can see everything.
  try {
    var t = table(SHEETS.servants);
    var iMail = pick(t.index, ['Mail', 'Email', 'E-mail']);
    var iRole = pick(t.index, ['Role', 'Access', 'Level']);

    if (iMail == null) {
      bad('Servants.Mail column', 'missing — nobody can sign in');
    } else {
      var withMail = 0, leaderNames = [], classNames = [];
      var iScopeCol = pick(t.index, ['Scope', 'Class', 'Class_Scope']);

      for (var r = 0; r < t.rows.length; r++) {
        if (String(t.rows[r][iMail] || '').trim()) withMail++;
        if (iRole == null) continue;

        var nm = String(t.rows[r][t.index.Full_Name] || '?').trim();
        var rt = String(t.rows[r][iRole] || '').trim().toLowerCase();
        // Same order as findServant: "Class Leader" must not read as "leader".
        if (rt.indexOf('class') !== -1) {
          var sc = iScopeCol == null ? '' : String(t.rows[r][iScopeCol] || '').trim();
          var parsed = parseScope(sc);
          classNames.push(nm + ' → ' + (parsed
            ? (parsed.gender || 'all') + ' year ' + parsed.years.join(' & ')
            : 'NO USABLE SCOPE, treated as an ordinary servant'));
        } else if (rt.indexOf('leader') !== -1 || rt.indexOf('admin') !== -1) {
          leaderNames.push(nm);
        }
      }

      ok('Servants with an email', String(withMail));
      if (iRole == null) {
        bad('Servants.Role column', 'missing — nobody can open the dashboard');
      } else if (!leaderNames.length) {
        bad('Ministry leaders', 'no row has Role = Leader — nobody can open Shepherds');
      } else {
        ok('Ministry leaders', leaderNames.join(', '));
      }
      if (classNames.length) {
        ok('Class leaders', classNames.join('  |  '));
        if (iScopeCol == null) {
          bad('Servants.Scope column', 'missing — class leaders fall back to their own flock');
        }
      } else {
        note('Class leaders', '(none)');
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
    return json({ ok: true, service: 'the99-api', version: 7 });
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
    var auth = authenticate(req);
    var user = auth.user;
    var payload = req.payload || {};
    var data;

    switch (req.action) {
      case 'bootstrap':   data = bootstrap(user); break;
      case 'flock':       data = getFlock(user, payload); break;
      case 'logFollowup': data = logFollowUp(user, payload); break;
      case 'updateNotes': data = updateNotes(user, payload); break;
      case 'dashboard':   data = getDashboardData(user); break;
      case 'shepherds':   data = getShepherds(user); break;
      default:
        throw httpError(400, 'Unknown action: ' + req.action);
    }

    var body = { ok: true, data: data };
    // Present only when a session was just issued or slid forward.
    if (auth.session) body.session = auth.session;
    return json(body);
  } catch (err) {
    var code = (err && err.httpCode) ? err.httpCode : 500;
    return json({ ok: false, error: { code: code, message: String((err && err.message) || err) } });
  }
}

// ===========================================================================
// Auth — the Servants sheet is the access list
// ===========================================================================

/**
 * Resolves the caller from either an app session token (the normal case) or a
 * fresh Google ID token (first sign-in only), then matches the email against
 * the Servants sheet — which stays the access list either way, so removing a
 * row revokes access immediately, without waiting for a session to lapse.
 *
 * Returns { user, session } where session is present only when one was just
 * issued or refreshed.
 */
function authenticate(req) {
  var email, session = null;

  if (req.sessionToken) {
    var claims = verifySessionToken(req.sessionToken);
    email = claims.email;
    // Slide the window once past the halfway mark, so an app in regular use
    // never expires, but an abandoned token still dies on schedule.
    var life = claims.expiresAt - claims.issuedAt;
    if (Date.now() > claims.issuedAt + life / 2) session = makeSession(email);

  } else if (req.idToken) {
    email = verifyGoogleIdToken(req.idToken);
    session = makeSession(email);

  } else {
    throw httpError(401, 'Sign-in required');
  }

  var servant = findServant(email);
  if (!servant) {
    throw httpError(403,
      'This account is not on the Servants list.\n\n' + email +
      '\n\nAsk a leader to add it to the Servants sheet.');
  }

  return {
    user: {
      email: email,
      name: servant.name,
      year: servant.year,
      mobile: servant.mobile,
      role: servant.role,            // 'leader' | 'class' | 'servant'
      scope: servant.scope,          // { gender, years[] } for a class leader
      isLeader: servant.isLeader,    // true only for the ministry leader
      picture: ''
    },
    session: session
  };
}

/** Checks a Google ID token with Google. Only runs at first sign-in. */
function verifyGoogleIdToken(idToken) {
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

    cache.put(key, JSON.stringify(info), Math.max(1, Math.min(1800, Math.floor(msLeft / 1000) - 60)));
  }

  var email = String(info.email || '').trim().toLowerCase();
  if (!email) throw httpError(401, 'No email on the sign-in token');
  return email;
}

// ---------------------------------------------------------------------------
// App session tokens
// ---------------------------------------------------------------------------

/**
 * The signing key, created on first use and kept in Script Properties.
 * Changing or deleting it signs everybody out, which is the way to do that.
 */
function sessionSecret() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SESSION_SECRET');
  if (secret) return secret;

  // Two first-requests arriving together must not each mint a different key,
  // which would silently invalidate one of the two sessions.
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    secret = props.getProperty('SESSION_SECRET');
    if (!secret) {
      secret = Utilities.getUuid() + Utilities.getUuid();
      props.setProperty('SESSION_SECRET', secret);
    }
    return secret;
  } finally {
    lock.releaseLock();
  }
}

/** payload.signature, both base64url. The payload is readable but not forgeable. */
function makeSession(email) {
  var now = Date.now();
  var claims = { e: email, i: now, x: now + SESSION_DAYS * 86400000 };
  var body = Utilities.base64EncodeWebSafe(JSON.stringify(claims));
  return {
    token: body + '.' + signPart(body),
    expiresAt: claims.x
  };
}

function signPart(body) {
  var raw = Utilities.computeHmacSha256Signature(body, sessionSecret());
  return Utilities.base64EncodeWebSafe(raw);
}

function verifySessionToken(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2) throw httpError(401, 'Please sign in again.');

  // Compare every byte regardless of where the first difference falls, so the
  // time taken says nothing about how close a forged signature was.
  var expected = signPart(parts[0]);
  if (expected.length !== parts[1].length) throw httpError(401, 'Please sign in again.');
  var diff = 0;
  for (var i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ parts[1].charCodeAt(i);
  }
  if (diff !== 0) throw httpError(401, 'Please sign in again.');

  var claims;
  try {
    claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (e) {
    throw httpError(401, 'Please sign in again.');
  }

  if (!claims.e || !claims.x) throw httpError(401, 'Please sign in again.');
  if (Date.now() > claims.x) throw httpError(401, 'Your session has expired. Please sign in again.');

  return { email: String(claims.e).toLowerCase(), issuedAt: claims.i || 0, expiresAt: claims.x };
}

/** Looks the caller up by the Mail column, and reads the optional Role column. */
function findServant(email) {
  var t = cachedTable(SHEETS.servants);
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

    var roleText = iRole == null ? '' : String(t.rows[r][iRole] || '').trim().toLowerCase();
    var iScope = pick(t.index, ['Scope', 'Class', 'Class_Scope']);
    var scopeText = iScope == null ? '' : String(t.rows[r][iScope] || '').trim();

    // "Class Leader" must be tested before the looser "leader" check.
    var role;
    if (extraLeaders.indexOf(email) !== -1) role = 'leader';
    else if (roleText.indexOf('class') !== -1) role = 'class';
    else if (roleText.indexOf('leader') !== -1 || roleText.indexOf('admin') !== -1) role = 'leader';
    else role = 'servant';

    var scope = role === 'class' ? parseScope(scopeText) : null;
    // A class leader with nothing usable in Scope can only see their own flock.
    if (role === 'class' && !scope) role = 'servant';

    return {
      name:   String(t.rows[r][iName] || '').trim(),
      year:   iName == null ? '' : normYear(t.rows[r][t.index.Year]),
      mobile: t.index.Mobile == null ? '' : String(t.rows[r][t.index.Mobile] || ''),
      role: role,
      scope: scope,
      isLeader: role === 'leader'          // kept: the write checks still read this
    };
  }
  return null;
}

function requireLeader(user) {
  if (!user.isLeader) {
    throw httpError(403, 'This page is for leaders only.');
  }
}

/**
 * Years 4 and 5 are run as one batch, so a class scope naming either covers
 * both. Year 6 is left out of that batching on purpose — those youths are
 * still awaiting a decision on graduating, so nobody's class sweeps them up.
 */
function batchYears(year) {
  var y = String(year).trim();
  return (y === '4' || y === '5') ? ['4', '5'] : [y];
}

/**
 * Reads a Scope cell such as "Female 3", "Male 5", "Female 1,2".
 * Returns { gender: 'Female'|'Male'|'', years: ['3'] } or null when unusable.
 */
function parseScope(text) {
  var s = String(text || '').trim();
  if (!s) return null;

  var gender = '';
  if (/female|بنات|فتيات/i.test(s)) gender = 'Female';
  else if (/male|بنين|شباب/i.test(s)) gender = 'Male';

  var years = {};
  (s.match(/\d+/g) || []).forEach(function (n) {
    batchYears(String(parseInt(n, 10))).forEach(function (y) { years[y] = true; });
  });

  var list = Object.keys(years).sort();
  if (!gender && !list.length) return null;
  return { gender: gender, years: list };
}

/** Is this youth inside the caller's class? */
function inScope(scope, gender, year) {
  if (!scope) return false;
  if (scope.gender && String(gender).trim() !== scope.gender) return false;
  if (scope.years.length && scope.years.indexOf(normYear(year)) === -1) return false;
  return true;
}

function requireMainLeader(user) {
  if (user.role !== 'leader') {
    throw httpError(403, 'This page is for the ministry leader only.');
  }
}

// ===========================================================================
// Actions
// ===========================================================================

function bootstrap(user) {
  return {
    apiVersion: 7,
    user: {
      name: user.name,
      email: user.email,
      year: user.year,
      role: user.role,
      scope: user.scope,
      isLeader: user.isLeader,
      canViewClass: user.role === 'class' || user.role === 'leader',
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
/**
 * The youths a caller may see.
 *
 *   view 'mine'    their own flock                        (everyone)
 *   view 'class'   every youth in their class, read-only  (class leader, leader)
 *   view 'servant' another servant's flock                (leader only)
 *   view 'all'     every youth in the register            (leader only)
 */
function getFlock(user, payload) {
  var view = String(payload.view || '').trim();
  var who = String(payload.servant || '').trim();

  // Fall back to the old behaviour when no view is named.
  if (!view) view = (who && who !== user.name) ? 'servant' : 'mine';

  var t = cachedTable(SHEETS.youths);
  var lastLog = lastFollowupByYouth();
  var out = [];

  if (view === 'all') {
    requireMainLeader(user);
    for (var a = 0; a < t.rows.length; a++) {
      if (!String(t.rows[a][t.index.Youth_ID] || '').trim()) continue;
      out.push(youthObject(t, t.rows[a], lastLog));
    }
    return { view: 'all', youths: out, canWrite: true };
  }

  if (view === 'class') {
    if (user.role !== 'class' && user.role !== 'leader') {
      throw httpError(403, 'You do not lead a class.');
    }
    var scope = user.scope;
    if (user.role === 'leader' && !scope) {
      throw httpError(400, 'No class scope set.');
    }
    for (var c = 0; c < t.rows.length; c++) {
      var row = t.rows[c];
      if (!String(row[t.index.Youth_ID] || '').trim()) continue;
      if (!inScope(scope, row[t.index.Gender], row[t.index.Year])) continue;
      out.push(youthObject(t, row, lastLog));
    }
    return {
      view: 'class',
      scope: scope,
      label: (scope.gender || 'All') + ' · year ' + scope.years.join(' & '),
      youths: out,
      canWrite: false           // class leaders look, they do not edit
    };
  }

  if (view === 'servant') {
    requireMainLeader(user);
  } else {
    who = user.name;
  }

  var wanted = who.toLowerCase();
  for (var r = 0; r < t.rows.length; r++) {
    var owner = String(t.rows[r][t.index.Servant_Name] || '').trim().toLowerCase();
    if (owner !== wanted) continue;
    out.push(youthObject(t, t.rows[r], lastLog));
  }

  return {
    view: view,
    servant: who,
    youths: out,
    isOwnFlock: who === user.name,
    canWrite: who === user.name || user.role === 'leader'
  };
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
  // Own flock, or the ministry leader. A class leader can see their class but
  // not change it, so being in scope is deliberately not enough here.
  if (user.role !== 'leader' && youth.servantName.toLowerCase() !== user.name.toLowerCase()) {
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
    invalidate(SHEETS.logs);      // Latest_Followup is derived from this table

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

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw httpError(503, 'The sheet is busy — please try again.');
  try {
    /* Resolve the row inside the lock and from a live read, never the cache:
       this writes by row number, and an inserted or deleted row would otherwise
       put the note on the wrong youth. */
    var youth = findYouth(youthId, true);
    if (!youth) throw httpError(404, "Youth_ID '" + youthId + "' not found in sheet.");
    if (user.role !== 'leader' && youth.servantName.toLowerCase() !== user.name.toLowerCase()) {
      throw httpError(403, youth.fullName + ' is not in your flock.');
    }

    var col = pick(table(SHEETS.youths).index, ['Notes', 'notes']);
    if (col == null) throw httpError(500, "Column 'Notes' not found in sheet.");

    sheetByName(SHEETS.youths).getRange(youth.rowNumber, col + 1).setValue(notes);
    invalidate(SHEETS.youths);
    return { youthId: youth.youthId, notes: notes };
  } finally {
    lock.releaseLock();
  }
}

/**
 * The dashboard, for everyone.
 *
 * The figures themselves are ministry-wide and carry no contact details, so
 * every servant may see them. What varies by role is the per-servant
 * breakdown: only the ministry leader receives Servant_Name on each row, so
 * nobody else can rebuild the shepherds ranking from this payload.
 *
 * Each youth is flagged `mine` (in the caller's own flock) and `inClass` (in
 * the caller's class), which is what lets a servant see their own numbers
 * beside the ministry's without being sent anyone else's.
 */
function getDashboardData(user) {
  var full = user.role === 'leader';
  var me = String(user.name || '').trim().toLowerCase();

  var t = cachedTable(SHEETS.youths);
  var lastLog = lastFollowupByYouth();
  var iId = t.index.Youth_ID;
  var youths = [];

  for (var r = 0; r < t.rows.length; r++) {
    var row = t.rows[r];
    var id = String(row[iId] || '').trim();
    if (!id) continue;

    var owner = String(row[t.index.Servant_Name] || '').trim();
    var gender = plain(row[t.index.Gender]);
    var year = normYear(row[t.index.Year]);
    var lf = lastLog[id] || null;

    var o = {
      Year: year,
      Gender: gender,
      Latest_Followup: lf
        ? Utilities.formatDate(lf, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : null,
      mine: owner.toLowerCase() === me,
      inClass: inScope(user.scope, gender, year)
    };
    if (full) o.Servant_Name = owner;
    youths.push(o);
  }

  var tl = cachedTable(SHEETS.logs);
  var followUps = [];
  var FIELDS = ['Date', 'Year', 'Gender', 'Type', 'Successful?'];

  for (var i = 0; i < tl.rows.length; i++) {
    var lrow = tl.rows[i];
    if (!String(lrow[tl.index.Youth_ID] || '').trim()) continue;
    var obj = {};
    for (var f = 0; f < FIELDS.length; f++) {
      var key = FIELDS[f], col = tl.index[key];
      obj[key] = col == null ? '' : plain(lrow[col]);
    }
    obj.Year = normYear(obj.Year);
    var sn = String(lrow[tl.index.Servant_Name] || '').trim();
    obj.mine = sn.toLowerCase() === me;
    if (full) obj.Servant_Name = sn;
    followUps.push(obj);
  }

  return {
    role: user.role,
    scope: user.scope,
    youths: youths,
    followUps: followUps,
    banner: faithfulShepherd(),      // a celebration, so everyone sees it
    hasServantNames: full
  };
}

/**
 * The shepherd whose whole flock is in the fold, largest flock first — or,
 * failing that, whoever is closest. Computed here so the dashboard can honour
 * someone without every servant's figures being sent to every servant.
 */
function faithfulShepherd() {
  var t = cachedTable(SHEETS.youths);
  var lastLog = lastFollowupByYouth();
  var now = Date.now();
  var per = {};

  for (var r = 0; r < t.rows.length; r++) {
    var row = t.rows[r];
    var id = String(row[t.index.Youth_ID] || '').trim();
    if (!id) continue;
    var name = String(row[t.index.Servant_Name] || '').trim();
    if (!name) continue;

    if (!per[name]) per[name] = { ok: 0, total: 0 };
    per[name].total++;

    var lf = lastLog[id];
    if (lf && Math.floor((now - lf.getTime()) / 86400000) <= FOLD_DAYS) per[name].ok++;
  }

  var MIN_FLOCK = 3;
  var best = null, perfect = 0;
  Object.keys(per).forEach(function (n) {
    var v = per[n];
    if (v.total < MIN_FLOCK) return;
    var pct = Math.round(v.ok / v.total * 100);
    if (pct === 100) perfect++;
    if (!best || pct > best.pct || (pct === best.pct && v.total > best.total)) {
      best = { name: n, pct: pct, ok: v.ok, total: v.total };
    }
  });

  if (!best) return null;
  best.alsoPerfect = best.pct === 100 ? Math.max(0, perfect - 1) : 0;
  return best;
}

/** The shepherds ranking. The ministry leader only. */
function getShepherds(user) {
  requireMainLeader(user);

  var t = cachedTable(SHEETS.youths);
  var lastLog = lastFollowupByYouth();
  var now = Date.now();
  var per = {};

  for (var r = 0; r < t.rows.length; r++) {
    var row = t.rows[r];
    var id = String(row[t.index.Youth_ID] || '').trim();
    if (!id) continue;
    var name = String(row[t.index.Servant_Name] || '').trim() || 'Unassigned';
    if (!per[name]) per[name] = { servant: name, ok: 0, warn: 0, late: 0, logs: 0 };

    var lf = lastLog[id];
    var days = lf ? Math.floor((now - lf.getTime()) / 86400000) : null;
    if (days === null || days > WANDER_DAYS) per[name].late++;
    else if (days > FOLD_DAYS) per[name].warn++;
    else per[name].ok++;
  }

  var tl = cachedTable(SHEETS.logs);
  for (var i = 0; i < tl.rows.length; i++) {
    var lrow = tl.rows[i];
    if (String(lrow[tl.index['Successful?']] || '').trim().toLowerCase() !== 'yes') continue;
    var sn = String(lrow[tl.index.Servant_Name] || '').trim() || 'Unassigned';
    if (per[sn]) per[sn].logs++;
  }

  var list = Object.keys(per).map(function (k) { return per[k]; });
  list.sort(function (a, b) {
    var ta = a.ok + a.warn + a.late, tb = b.ok + b.warn + b.late;
    return (tb ? b.ok / tb : 0) - (ta ? a.ok / ta : 0);
  });
  return { servants: list };
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

/* Reading a sheet is by far the slowest thing this script does, and every
   request was doing it two or three times over. These wrap the reads in the
   script cache. CacheService caps a value at 100KB, so a table is split across
   numbered chunks and stitched back together. */

var CACHE_SECONDS = {
  youths: 60,
  logs:   60,
  // Shorter: this one is the access list, so a removed servant should lose
  // access promptly rather than lingering for a full minute.
  servants: 20
};

function cacheRead(key) {
  var c = CacheService.getScriptCache();
  var meta = c.get(key + '_n');
  if (!meta) return null;

  var n = Number(meta), names = [];
  for (var i = 0; i < n; i++) names.push(key + '_' + i);

  var parts = c.getAll(names), out = '';
  for (var j = 0; j < n; j++) {
    var piece = parts[key + '_' + j];
    if (piece == null) return null;      // a chunk expired: treat as a miss
    out += piece;
  }
  try { return JSON.parse(out); } catch (e) { return null; }
}

function cacheWrite(key, obj, seconds) {
  try {
    var text = JSON.stringify(obj);
    var CHUNK = 90000;
    var n = Math.ceil(text.length / CHUNK);
    if (n > 25) return;                  // implausibly large; skip rather than thrash

    var map = {};
    for (var i = 0; i < n; i++) map[key + '_' + i] = text.substr(i * CHUNK, CHUNK);
    map[key + '_n'] = String(n);
    CacheService.getScriptCache().putAll(map, seconds);
  } catch (e) {
    // A cache failure must never fail the request.
  }
}

function cacheDrop(key) {
  try {
    var c = CacheService.getScriptCache();
    var meta = c.get(key + '_n');
    var names = [key + '_n'];
    if (meta) for (var i = 0; i < Number(meta); i++) names.push(key + '_' + i);
    c.removeAll(names);
  } catch (e) { /* ignore */ }
}

/** table(), but served from the cache when it is warm. */
function cachedTable(name) {
  var key = 'tbl_' + name.replace(/[^A-Za-z0-9]/g, '');
  var hit = cacheRead(key);
  if (hit && hit.headers) return hit;

  var t = table(name);
  var ttl = CACHE_SECONDS[name === SHEETS.youths ? 'youths'
          : name === SHEETS.logs ? 'logs'
          : 'servants'] || 60;
  cacheWrite(key, t, ttl);
  return t;
}

/** Call after any write, so the next read does not serve what we just changed. */
function invalidate(name) {
  cacheDrop('tbl_' + name.replace(/[^A-Za-z0-9]/g, ''));
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
  var t = cachedTable(SHEETS.youths);
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

/**
 * Youth_ID -> most recent SUCCESSFUL follow-up.
 *
 * An attempt that did not reach the youth is still worth recording — it shows
 * the servant tried — but it must not move anyone back into the fold. This
 * matches the sheet's own Latest_Followup formula, which has always filtered
 * on Successful? = "Yes"; the app used to count every attempt, so a call that
 * went unanswered quietly reset the clock here while the sheet ignored it.
 */
function lastFollowupByYouth() {
  var t = cachedTable(SHEETS.logs);
  var iOk = pick(t.index, ['Successful?', 'Successful', 'Success']);
  var out = {};

  for (var r = 0; r < t.rows.length; r++) {
    var row = t.rows[r];
    var id = String(row[t.index.Youth_ID] || '').trim();
    if (!id) continue;

    if (iOk != null) {
      var ok = String(row[iOk] || '').trim().toLowerCase();
      if (ok !== 'yes' && ok !== 'true' && ok !== '1') continue;
    }

    var d = toDate(row[t.index.Date]);
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

/**
 * Dates become yyyy-MM-dd strings, matching what the pages already expect.
 *
 * A cached table has been through JSON, so its date cells arrive as ISO strings
 * rather than Date objects. Both are normalised here, so a value looks the same
 * whether it came from the sheet or from the cache.
 */
function plain(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (v == null) return '';
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(v)) {
      var d = new Date(v);
      if (!isNaN(d.getTime())) {
        return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
    }
    // A formula error such as #N/A arrives as a string; treat it as empty.
    if (v.charAt(0) === '#' && v.toUpperCase() === v) return '';
  }
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
