/*
 * Keeps the sign-in page on the phone so it opens with no signal.
 * The page is served from the phone's copy straight away and refreshed in the
 * background, so an update you push shows up the next time the page is opened.
 * Calls to the Apps Script web app (a different site) are never touched.
 */
var CACHE = 'class-signin-v2';
var SHELL = ['./', './index.html', './config.json', './roster.json', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

// Each file is cached on its own. Caching them as one list means a single missing file
// (config.json not pushed yet, a missing icon) leaves the phone with no offline copy at all.
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (url) {
      return fetch(url, { cache: 'reload' }).then(function (res) {
        if (res && res.ok) return c.put(url, res);
      }).catch(function () { /* this one file is missing: keep the rest */ });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // config.json decides where records are uploaded, so take the newest one when there is signal
  var configFirst = req.url.indexOf('config.json') >= 0;
  if (configFirst) {
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); e.waitUntil(caches.open(CACHE).then(function (c) { return c.put(req, copy); })); }
      return res;
    }).catch(function () { return caches.match(req, { ignoreSearch: true }); }));
    return;
  }

  var saving = Promise.resolve();
  var fresh = fetch(req).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      saving = caches.open(CACHE).then(function (c) { return c.put(req, copy); });
    }
    return res;
  });
  e.waitUntil(fresh.then(function () { return saving; }).catch(function () {}));

  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    return fresh.catch(function () {
      // Any page address inside the app falls back to the saved page
      if (req.mode === 'navigate') return caches.match('./index.html').then(function (p) { return p || caches.match('./'); });
      return Response.error();
    });
  }));
});
