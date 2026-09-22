/* ===========================================================================
   The 99 — shared front-end logic.
   The helpers keep the names and behaviour they had in the original pages;
   what changed is the transport: google.script.run became a fetch() call to
   the Apps Script JSON API, so the pages can live on a normal static host
   and therefore be installable.
   =========================================================================== */

/* Build marker. Must match the backend's apiVersion (code.gs). Check in the
   console with THE99_BUILD; the backend's is at the /exec URL's "version". */
var THE99_BUILD = 4;
window.THE99_BUILD = THE99_BUILD;

var CFG = window.APP_CONFIG || {};

/* ── VERSES ─────────────────────────────────────────────────────────────── */

var VERSES = [
  { text: "What man of you, having a hundred sheep, if he loses one of them, does not leave the ninety-nine in the wilderness, and go after the one which is lost until he finds it?", ref: "Luke 15:4" },
  { text: "He calls together his friends and neighbors, saying to them, 'Rejoice with me, for I have found my sheep which was lost!'", ref: "Luke 15:6" },
  { text: "I am the good shepherd. The good shepherd gives His life for the sheep.", ref: "John 10:11" },
  { text: "هأَنَذَا أَسْأَلُ عَنْ غَنَمِي وَأَفْتَقِدُهَا", ref: "حزقيال 34:11" },
  { text: "Let no one despise your youth, but be an example to the believers in word, in conduct, in love, in spirit, in faith, in purity.", ref: "1 Timothy 4:12" },
  { text: "My sheep hear My voice, and I know them, and they follow Me.", ref: "John 10:27" },
  { text: "يَا أَوْلاَدِي، لاَ نُحِبُّ بِالْكَلاَمِ وَلاَ بِاللِّسَانِ، بَلْ بِالْعَمَلِ وَالْحَقِّ.", ref: "رسالة يوحنا الأولى 3:18" }
];

function randomVerse() { return VERSES[Math.floor(Math.random() * VERSES.length)]; }

function setRandomVerse(textId, refId) {
  var v = randomVerse();
  var t = document.getElementById(textId || 'verseText');
  var r = document.getElementById(refId  || 'verseRef');
  if (t) t.innerText = v.text;
  if (r) r.innerText = v.ref;
}

/* ── FLOCK THRESHOLDS ───────────────────────────────────────────────────── */
/* Unchanged from the original: <=30 In the Fold, 31-60 Wandering,
   over 60 or never reached, Lost Sheep. */

/* Defaults only — overwritten from the backend on bootstrap, so code.gs stays
   the one place these are set. */
var FOLD_DAYS = 30, WANDER_DAYS = 60;

function flockState(days) {
  if (days === null || days === undefined || days > WANDER_DAYS) return 'late';
  if (days > FOLD_DAYS) return 'warn';
  return 'ok';
}

/* ── AUTH ───────────────────────────────────────────────────────────────── */
/* Google signs you in once. We then swap that for an app session token that
   lasts 30 days on a sliding window, and Google is not consulted again.
   Two reasons: a Google ID token only lives an hour, and re-running its sign-in
   on every page load pops the One Tap bubble each time you change tab. */

var SESSION_KEY = 'the99.session';
var BOOT_KEY    = 'the99.bootstrap';

try { localStorage.removeItem('the99.idToken'); } catch (e) { /* ignore */ }

/* Once a setup problem is on screen it must stay there: the gate's own
   "not signed in yet" path runs afterwards and would otherwise clear it. */
var CONFIG_ERROR = false;

/** Shows a setup problem on the sign-in screen instead of a blank gate. */
function showConfigError(message) {
  CONFIG_ERROR = true;
  var gate = document.getElementById('gate');
  var app  = document.getElementById('app');
  if (app) app.hidden = true;
  if (gate) gate.hidden = false;
  var note = document.getElementById('gate-error');
  if (note) { note.hidden = false; note.textContent = message; }
  var host = document.getElementById('gsi-button');
  if (host) host.innerHTML = '';
}

var Session = {
  token: null,
  expiresAt: 0,

  load: function () {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return false;
      var s = JSON.parse(raw);
      this.token = s.token;
      this.expiresAt = s.expiresAt || 0;
      return this.valid();
    } catch (e) { return false; }
  },

  save: function (s) {
    if (!s || !s.token) return;
    this.token = s.token;
    this.expiresAt = s.expiresAt || 0;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  },

  clear: function () {
    this.token = null;
    this.expiresAt = 0;
    try {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(BOOT_KEY);
    } catch (e) { /* ignore */ }
    clearApiCache();
  },

  /* A minute of slack so a call started now cannot land after expiry. */
  valid: function () { return !!this.token && this.expiresAt > Date.now() + 60000; }
};

var Auth = {
  idToken: null,          // held only long enough to trade for a session
  _onReady: null,

  init: function (onReady) {
    this._onReady = onReady;

    if (Session.load()) {
      onReady();          // already signed in — Google is not involved at all
      return;
    }
    Session.clear();
    this._gsi();
  },

  _gsi: function () {
    var self = this;

    // Catch an unfilled or malformed client id here, rather than letting Google
    // answer with its own "Error 401: invalid_client" page.
    var cid = String(CFG.GOOGLE_CLIENT_ID || '');
    if (!cid || cid.indexOf('PASTE_') === 0 || !/\.apps\.googleusercontent\.com$/.test(cid)) {
      showConfigError(
        'GOOGLE_CLIENT_ID is not set correctly in config.js.\n\n' +
        'It must end in .apps.googleusercontent.com — see README.md, steps 2 and 5.\n\n' +
        'Currently: ' + (cid || '(empty)'));
      return;
    }

    function start() {
      if (!window.google || !google.accounts || !google.accounts.id) return;
      google.accounts.id.initialize({
        client_id: cid,
        callback: function (res) { self._accept(res.credential); },
        auto_select: true,
        cancel_on_tap_outside: false,
        use_fedcm_for_prompt: true
      });

      var host = document.getElementById('gsi-button');
      if (host) {
        google.accounts.id.renderButton(host, {
          theme: 'filled_black', size: 'large', shape: 'pill',
          text: 'signin_with', width: Math.min(300, host.clientWidth || 300)
        });
      }
      // Only ever prompted on the sign-in screen, never on an ordinary page load.
      google.accounts.id.prompt();
    }

    if (window.google && window.google.accounts) start();
    else window.addEventListener('gsi-loaded', start, { once: true });
  },

  _accept: function (credential) {
    this.idToken = credential;
    if (this._onReady) this._onReady();
  },

  signOut: function () {
    try { google.accounts.id.disableAutoSelect(); } catch (e) { /* not loaded */ }
    this.idToken = null;
    Session.clear();
    location.href = 'index.html';
  }
};

/* ── API ────────────────────────────────────────────────────────────────── */
/* Apps Script cannot answer a CORS preflight, so the request has to stay a
   "simple" one: text/plain body and no custom headers. The JSON rides in the
   body all the same. */

function ApiError(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

function api(action, payload) {
  payload = payload || {};

  if (!CFG.API_URL || CFG.API_URL.indexOf('PASTE_') === 0) {
    return Promise.reject(ApiError(0, 'API_URL is not set yet — see step 5 of README.md'));
  }

  var envelope = { action: action, payload: payload };
  if (Session.valid())      envelope.sessionToken = Session.token;
  else if (Auth.idToken)    envelope.idToken = Auth.idToken;
  else {
    Session.clear();
    return Promise.reject(ApiError(401, 'Please sign in again.'));
  }

  return fetch(CFG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(envelope),
    redirect: 'follow'
  }).catch(function () {
    throw ApiError(0, navigator.onLine
      ? 'Could not reach the server. Please try again.'
      : 'You are offline. Reconnect and try again.');
  }).then(function (res) {
    return res.text().then(function (text) {
      var body;
      try { body = JSON.parse(text); }
      catch (e) {
        throw ApiError(res.status,
          'The server sent an unexpected response. Check that the web app is ' +
          'deployed with access set to "Anyone".');
      }

      // A freshly issued or slid-forward session rides back on any response.
      if (body.session) {
        Session.save(body.session);
        Auth.idToken = null;          // no longer needed once traded in
      }

      if (!body.ok) {
        var err = body.error || {};
        if (err.code === 401) Session.clear();
        throw ApiError(err.code || 500, err.message || 'Something went wrong');
      }
      return body.data;
    });
  });
}

/**
 * Renders from the last response immediately, then refreshes from the network.
 *
 * Apps Script takes a second or two to answer, which made every tab switch feel
 * like a reload. `onData(data, isFresh)` is therefore called up to twice: once
 * with cached data if any (isFresh false), then again with the live answer.
 * `onError` only fires when there was nothing cached to fall back on.
 */
function apiCached(key, action, payload, onData, onError) {
  var full = 'the99.cache.' + key;
  var served = false;

  try {
    var raw = localStorage.getItem(full);
    if (raw) {
      var hit = JSON.parse(raw);
      if (hit && hit.data) { served = true; onData(hit.data, false); }
    }
  } catch (e) { /* unreadable cache is just a miss */ }

  return api(action, payload).then(function (data) {
    try {
      localStorage.setItem(full, JSON.stringify({ at: Date.now(), data: data }));
    } catch (e) { /* quota or private mode — not fatal */ }
    onData(data, true);
  }).catch(function (err) {
    // Stale data already on screen beats an error message.
    if (!served && onError) onError(err);
    else if (served) console.warn('Refresh failed, showing cached data:', err.message);
  });
}

/** Drops the cached copies; used on sign-out so nothing leaks between accounts. */
function clearApiCache() {
  try {
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf('the99.cache.') === 0) localStorage.removeItem(k);
    });
  } catch (e) { /* ignore */ }
}

/** bootstrap() is wanted by every page, so keep it for the session. */
function getBootstrap(force) {
  if (!force) {
    var cached = sessionStorage.getItem(BOOT_KEY);
    if (cached) { try { return Promise.resolve(JSON.parse(cached)); } catch (e) { /* refetch */ } }
  }
  return api('bootstrap').then(function (data) {
    try { sessionStorage.setItem(BOOT_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
    return data;
  });
}

/* ── THE GATE ───────────────────────────────────────────────────────────── */

/**
 * Shows the sign-in screen until the servant is authenticated and known to the
 * Servants sheet, then resolves with { profile, boot } and reveals the app.
 * Pass { leaderOnly: true } to refuse ordinary servants.
 */
function requireServant(opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var gate = document.getElementById('gate');
    var app  = document.getElementById('app');

    function showGate(message) {
      if (CONFIG_ERROR) return;          // a config error outranks everything
      if (app) app.hidden = true;
      if (gate) {
        gate.hidden = false;
        var note = document.getElementById('gate-error');
        if (note) {
          if (message) { note.hidden = false; note.textContent = message; }
          else note.hidden = true;
        }
      }
    }

    /* With a session in hand the servant is going to be let in, so put the
       shell up now rather than after the first round trip. Waiting meant a
       blank page for the whole of it — on a phone, seconds of nothing. */
    if (Session.valid()) {
      if (gate) gate.hidden = true;
      if (app) app.hidden = false;
    }

    var v = randomVerse();
    var gv = document.getElementById('gate-verse');
    var gr = document.getElementById('gate-ref');
    if (gv) gv.innerText = v.text;
    if (gr) gr.innerText = v.ref;

    Auth.init(function () {
      getBootstrap().then(function (boot) {
        if (boot.thresholds) {
          FOLD_DAYS   = boot.thresholds.fold   || FOLD_DAYS;
          WANDER_DAYS = boot.thresholds.wander || WANDER_DAYS;
        }
        /* Signing in must produce a session. If it did not, the deployed
           backend predates session tokens and every page load would bounce
           through Google again — an endless sign-in loop. Stop and say so. */
        if (!Session.valid()) {
          try { google.accounts.id.disableAutoSelect(); } catch (e) { /* not loaded */ }
          showGate(
            'The Apps Script backend is out of date.\n\n' +
            'It signed you in but issued no session, so the app would ask you ' +
            'to sign in again on every page.\n\n' +
            'In the Apps Script editor: paste the current code.gs, then\n' +
            'Deploy > Manage deployments > edit > Version: New version > Deploy.' +
            (boot.apiVersion ? '\n\nBackend reports version ' + boot.apiVersion + ', expected 4.'
                             : '\n\nBackend reports no version, expected 4.'));
          return;
        }

        if (opts.leaderOnly && !boot.user.isLeader) {
          showGate('This page is for leaders only.\n\nYou are signed in as ' +
                   boot.user.email + '.');
          return;
        }
        if (gate) gate.hidden = true;
        if (app) app.hidden = false;
        mountChrome(boot);
        resolve({ profile: boot.user, boot: boot });
      }).catch(function (err) {
        Session.clear();
        // Without this, auto_select signs straight back in and the failure loops.
        try { google.accounts.id.disableAutoSelect(); } catch (e) { /* not loaded */ }
        showGate(err.message);
      });
    });

    if (!Session.valid()) showGate(null);
  });
}

/** Fills the header tools, the nav, and marks the current page. */
function mountChrome(boot) {
  var tools = document.getElementById('header-tools');
  if (tools) {
    tools.innerHTML =
      '<button class="header-btn" id="installBtn" type="button" hidden>Install</button>' +
      '<button class="header-btn" id="signoutBtn" type="button">Sign out</button>';
    document.getElementById('signoutBtn').onclick = function () { Auth.signOut(); };
    if (deferredInstall) document.getElementById('installBtn').hidden = false;
    document.getElementById('installBtn').onclick = doInstall;
  }

  var nav = document.getElementById('nav');
  if (nav) {
    if (!boot.user.isLeader) { nav.hidden = true; }
    else {
      nav.hidden = false;
      nav.innerHTML =
        '<a href="index.html">My Flock</a>' +
        '<a href="shepherds.html">Shepherds</a>' +
        '<a href="dashboard.html">Dashboard</a>';
      var here = location.pathname.split('/').pop() || 'index.html';
      var links = nav.querySelectorAll('a');
      for (var i = 0; i < links.length; i++) {
        if (links[i].getAttribute('href') === here) links[i].setAttribute('aria-current', 'page');
      }
    }
  }
}

/* ── HELPERS (unchanged from the original pages) ────────────────────────── */

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escJs(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

var COUNTRY_CODE = '20';
function cleanPhone(phone) {
  if (!phone) return '';
  var digits = phone.toString().replace(/\D/g, '');
  if (digits.startsWith('0')) digits = COUNTRY_CODE + digits.substring(1);
  return digits;
}

function daysSince(date) {
  if (!date) return null;
  var d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return Math.floor((new Date() - d) / 86400000);
}

function formatDate(date) {
  if (!date) return null;
  var d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString();
}

function initials(name) {
  return String(name || '').trim().split(/\s+/)
    .map(function (w) { return w[0] || ''; }).slice(0, 2).join('').toUpperCase();
}

function isSuccessful(f) {
  var v = String(f.Successful || f['Successful?'] || '').trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === '1';
}

function normalizeYear(val) {
  var n = parseInt(parseFloat(String(val || '').trim()));
  if (isNaN(n)) return '?';
  if (n >= 4) return '4-5';
  return String(n);
}

function gpsUrl(val) {
  var v = String(val || '').trim();
  if (!v) return null;
  if (v.startsWith('http')) return v;
  return 'https://maps.google.com/?q=' + encodeURIComponent(v);
}

function el(tag, cls) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function appendSection(parent, label) {
  var s = el('div', 'section-label');
  s.textContent = label;
  parent.appendChild(s);
}

function statCard(type, num, label) {
  return '<div class="stat-card ' + type + '">' +
         '<span class="stat-num">' + num + '</span>' +
         '<span class="stat-label">' + escHtml(label) + '</span></div>';
}

function showToast(message, color) {
  var old = document.querySelectorAll('.toast');
  for (var i = 0; i < old.length; i++) old[i].remove();

  var toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.backgroundColor = color || '#5A7A5A';
  toast.setAttribute('role', 'status');
  toast.innerText = message;
  document.body.appendChild(toast);

  setTimeout(function () { toast.classList.add('show'); }, 30);
  setTimeout(function () {
    toast.classList.remove('show');
    setTimeout(function () { toast.remove(); }, 400);
  }, 3200);
}

/** Search across the fields a servant would actually type. */
function matchesQuery(youth, q) {
  if (!q) return true;
  var hay = [youth.Full_Name, youth.Area, youth.Address, youth.University,
             youth.Faculty, youth.Mobile, youth.Talent, youth.Talent_Category,
             youth.Service, youth.Notes].join(' ').toLowerCase();
  return hay.indexOf(q) !== -1;
}

/* ── PWA ────────────────────────────────────────────────────────────────── */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* non-fatal */ });
  });
}

var deferredInstall = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  deferredInstall = e;
  var btn = document.getElementById('installBtn');
  if (btn) btn.hidden = false;
});

function doInstall() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.then(function (choice) {
    if (choice.outcome === 'accepted') {
      var btn = document.getElementById('installBtn');
      if (btn) btn.hidden = true;
    }
    deferredInstall = null;
  });
}

/* A quiet strip when the connection drops, so a failed save makes sense. */
window.addEventListener('offline', function () { toggleOfflineBar(true); });
window.addEventListener('online',  function () { toggleOfflineBar(false); });

function toggleOfflineBar(show) {
  var bar = document.getElementById('offlineBar');
  if (bar) bar.hidden = !show;
}
