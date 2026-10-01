/*
 * The real page (docs/) in a real browser, talking to the real Code.gs (run here with the
 * Apps Script mocks). Checks what a student sees: per-class location, the sign-in window,
 * check-out, shared roll numbers, offline sign-in and the iPhone location message.
 *
 * Needs Playwright with Chromium:  npm run e2e
 */
const fs = require('fs'), vm = require('vm'), path = require('path'), http = require('http'), assert = require('assert');
const { execSync } = require('child_process');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))); }

const DOCS = path.join(__dirname, '..', 'docs');
const API = 'https://script.google.com/macros/s/TEST/exec';
const LUMS = { latitude: 31.4708, longitude: 74.4097, accuracy: 15 };
const FAST = { latitude: 31.48104614, longitude: 74.30328505, accuracy: 15 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A time zone where it is late morning now, so "start 100 minutes ago" never crosses midnight
const ZONES = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo', 'Atlantic/Azores',
  'Europe/London', 'Europe/Berlin', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Shanghai',
  'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
const partsIn = (tz) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((p) => [p.type, p.value]));
const TZ = ZONES.find((z) => { const h = +partsIn(z).hour; return h >= 9 && h <= 13; }) || 'Asia/Karachi';
const P = partsIn(TZ), TODAY = `${P.year}-${P.month}-${P.day}`, NOW = (+P.hour) * 60 + (+P.minute);
const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

// ---------- server: Code.gs in a VM ----------
const ctx = { console, Intl, Date, Math, JSON, btoa, atob, String, Number, Array, Object, isFinite, isNaN, parseInt, Infinity, Buffer };
ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'mock_gas.js'), 'utf8').replace("var TZ = 'Asia/Karachi'", 'var TZ = ' + JSON.stringify(TZ)), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8'), ctx);
vm.runInContext(`__setupSheets('${TODAY}')`, ctx);
// The Roster exactly as the live sheet lays it out: Class/Course at E, LAT / LONG / Radius at O-Q,
// no Sign-in / Check-out / Early Leaver columns (so the defaults 30 / 10 / 30 apply)
const HDR = ['Section', 'Student Roll No', 'Student Name', '', 'Class/Course', 'Session No. ', 'Day', 'Session Dates', 'Section', 'Start Time',
  'End Time', 'Fine if Delay by Min', 'Late if Delay by Min', 'Absent if Delay by Min', 'LAT', 'LONG', 'Radius'];
const sess = (no, sec, start, end, loc, cls) => ['', '', '', '', cls || sec, no, 'x', TODAY, sec, hm(start), hm(end), 5, 10, 20,
  loc ? loc.latitude : '', loc ? loc.longitude : '', 100];
const rows = [
  sess('1', 'ECOM-SEP-26', NOW - 100, NOW + 5, LUMS, 'LUMS ECOM Sep-2026'),   // in its check-out window
  sess('2', 'FUTURE', NOW + 60, NOW + 120, LUMS),                             // sign-in opens in 30 min
  sess('3', 'BSBA 7A', NOW - 3, NOW + 60, FAST),                              // FAST campus, 10 km from LUMS
  sess('4', 'NOLOC', NOW - 3, NOW + 60, null),                                // no classroom location in the Roster
];
const students = [['ECOM-SEP-26', 'ECOM-SEP-26', 'Ali Dhillon'], ['ECOM-SEP-26', 'ECOM-SEP-26', 'Asma Bashir'], ['ECOM-SEP-26', 'E-03', 'Ali Hassan'],
  ['BSBA 7A', '22L-5002', 'Ezzan Hussain'], ['FUTURE', 'F-1', 'Future Student'], ['NOLOC', 'N-1', 'No Loc']];
students.forEach((s, i) => { rows[i] = rows[i] || new Array(HDR.length).fill(''); rows[i][0] = s[0]; rows[i][1] = s[1]; rows[i][2] = s[2]; });
const roster = ctx.__gas.sheets.Roster;
roster.raw = [HDR].concat(rows); roster.shown = roster.raw.map((r) => r.map(String)); roster.maxCols = 30;
vm.runInContext('clearRosterCache()', ctx);
const logRows = () => vm.runInContext('__logRows()', ctx);
function handle(method, url, body) {
  ctx.__e = method === 'GET' ? { parameter: Object.fromEntries(new URL(url).searchParams) } : { parameter: {}, postData: { contents: body } };
  return vm.runInContext(method === 'GET' ? 'doGet(__e)' : 'doPost(__e)', ctx).getContent();
}

// ---------- docs/ served as GitHub Pages would ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  let f = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/app/, '');
  if (f.endsWith('/')) f += 'index.html';
  if (f === '/config.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ apiUrl: API })); }
  fs.readFile(path.join(DOCS, f), (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(data);
  });
});
const URL0 = 'http://localhost:8124/app/';

async function phone(browser, geo, opts = {}) {
  const c = await browser.newContext({ timezoneId: TZ, geolocation: geo, permissions: opts.noGeo ? [] : ['geolocation'], userAgent: opts.ua });
  await c.route(API + '**', async (route) => {
    const r = route.request();
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: handle(r.method(), r.url(), r.postData()) });
  });
  const p = await c.newPage();
  await p.goto(URL0);
  await p.waitForFunction(() => document.querySelectorAll('#namesList option').length > 0, null, { timeout: 90000 });
  return { c, p };
}
async function trySignIn(p, roll, name, sec) {
  await p.fill('#rollNoInput', roll); await p.dispatchEvent('#rollNoInput', 'input');
  await p.fill('#studentNameInput', name); await p.fill('#sectionInput', sec);
  await p.click('#signInBtn');
  await p.waitForFunction(() => { const s = document.getElementById('status').textContent; return s && !/Checking/.test(s); }, null, { timeout: 60000 });
  return p.textContent('#status');
}
async function waitFor(fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await sleep(500); } throw new Error('timed out: ' + label); }

(async () => {
  await new Promise((r) => srv.listen(8124, r));
  const browser = await chromium.launch();
  try {
    console.log('time zone', TZ, 'now', hm(NOW));
    const a = await phone(browser, LUMS);

    let m = await trySignIn(a.p, '22L-5002', 'Ezzan Hussain', 'BSBA 7A');
    assert.ok(/You are 10\d{3} m from class/.test(m), 'FAST class from LUMS is refused: ' + m);
    m = await trySignIn(a.p, 'F-1', 'Future Student', 'FUTURE');
    assert.ok(/Sign-in for FUTURE opens at /.test(m), m);
    m = await trySignIn(a.p, 'N-1', 'No Loc', 'NOLOC');
    assert.ok(/location for NOLOC is not in the Roster/.test(m), m);
    console.log('refusals ok: wrong campus, before the window, no location');

    await a.p.fill('#rollNoInput', 'ECOM-SEP-26'); await a.p.dispatchEvent('#rollNoInput', 'input');
    assert.strictEqual(await a.p.inputValue('#studentNameInput'), '', 'a shared roll no never fills in a name');
    assert.ok(/2 students share this roll no/.test(await a.p.textContent('#rosterHint')));
    m = await trySignIn(a.p, 'ECOM-SEP-26', 'Asma Bashir', 'ECOM-SEP-26');
    assert.ok(/^Signed in/.test(m), m);
    assert.ok(/LUMS ECOM Sep-2026, session 1/.test(await a.p.textContent('#activeMeta')), 'class name shown');
    assert.ok(await a.p.isVisible('#checkoutBtn'), 'check-out shows in the last 10 minutes');
    await a.p.click('#checkoutBtn');
    await a.p.waitForFunction(() => /Checked out at/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
    await waitFor(() => logRows().some((r) => r[4] === 'CHECK_OUT' && r[7] === 'Asma Bashir'), 60000, 'check-out uploaded');
    const co = logRows().find((r) => r[4] === 'CHECK_OUT');
    assert.strictEqual(co[10], 0, 'distance worked out on the server');
    console.log('shared roll no, class name, check-out ok');

    const b = await phone(browser, FAST);
    m = await trySignIn(b.p, '22L-5002', 'Ezzan Hussain', 'BSBA 7A');
    assert.ok(/^Signed in/.test(m), m);
    assert.ok(!(await b.p.isVisible('#checkoutBtn')), 'no check-out an hour before the end');
    assert.ok(/Check out opens at /.test(await b.p.textContent('#checkoutHint')));
    console.log('FAST class from FAST ok, check-out hidden until its window');

    // offline: sign in with no signal, upload when it comes back
    await a.c.setOffline(true);
    await a.p.reload(); await sleep(1500);
    m = await trySignIn(a.p, 'E-03', 'Ali Hassan', 'ECOM-SEP-26');
    assert.ok(/Saved on this phone/.test(m), m);
    await a.p.waitForFunction(() => /^Offline\. \d+ record/.test(document.getElementById('syncTitle').textContent), null, { timeout: 10000 })
      .catch(async () => assert.fail('sync bar: ' + await a.p.textContent('#syncTitle')));
    await a.c.setOffline(false);
    await waitFor(() => logRows().some((r) => r[4] === 'SIGN_IN' && r[7] === 'Ali Hassan'), 90000, 'offline sign-in uploaded');
    console.log('offline sign-in ok');

    const ios = await phone(browser, LUMS, { noGeo: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
    m = await trySignIn(ios.p, 'E-03', 'Ali Hassan', 'ECOM-SEP-26');
    assert.ok(/On iPhone: Settings > Privacy & Security > Location Services/.test(m), m);
    console.log('iPhone location help ok');

    console.log('\nALL BROWSER TESTS PASSED');
  } finally {
    await browser.close(); srv.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
