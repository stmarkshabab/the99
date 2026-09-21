/* The 99 — service worker.
   Its job is to make the app installable and instant to open. Ministry data is
   never cached: every API call goes to the network so the sheet stays the
   single source of truth and nobody acts on a stale flock. */

var VERSION = 'the99-v3';
var SHELL = [
  'index.html',
  'shepherds.html',
  'dashboard.html',
  'offline.html',
  'assets/the99.css',
  'assets/the99.js',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'manifest.webmanifest'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      // Add one at a time: addAll is all-or-nothing and one 404 would break install.
      return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; })
                             .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                   // API writes go straight through

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;    // Google, Apps Script, CDN: never cache
  if (url.pathname.endsWith('/config.js')) return;    // always read fresh config

  // Navigations: network first, so a redeploy is picked up immediately.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('offline.html');
        });
      })
    );
    return;
  }

  // Static shell: cache first, refreshed in the background.
  e.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || network;
    })
  );
});
