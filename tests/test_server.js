const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const ctx = { console, Intl, Date, Math, JSON, btoa, atob, String, Number, Array, Object, isFinite, isNaN, parseInt, Infinity };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'mock_gas.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8'), ctx);
const run = (s) => vm.runInContext(s, ctx);
const byIdNow = (id) => run('__logRows()').filter(r => r[22] === id)[0];

run("__setupSheets('2026-09-22')");
const at = (hhmm) => new Date('2026-09-22T' + hhmm + ':00+05:00').getTime();

// 1. Roster: parsing, times, rules, version check
const r = run("getRosterData('none')");
assert.strictEqual(r.students.length, 4);
assert.strictEqual(JSON.stringify(r.timetable.map(t => t.startTime)), JSON.stringify(['09:00', '14:00', '18:30']), 'a 24-hour time written as "18:30 PM" is still read');
assert.strictEqual(JSON.stringify(r.timetable[1].rules), JSON.stringify([5, 7, 15]), 'rules in one cell');
assert.strictEqual(JSON.stringify(r.timetable[2].rules), JSON.stringify([5, 10, 20]), 'rules in three columns K, L, M');
assert.strictEqual(r.timetable[0].date, '2026-09-22');
assert.strictEqual(r.sections, undefined, 'new clients get no legacy lists');
const nm = run(`getRosterData('${r.version}')`);
assert.ok(nm.notModified && !nm.students, 'unchanged roster -> tiny reply');
const legacy = run("getRosterData()");
assert.ok(legacy.sections && legacy.rollNos.length === 4, 'old page still gets its lists');
console.log('roster ok, version', r.version, 'full reply', JSON.stringify(r).length, 'bytes, notModified reply', JSON.stringify(nm).length, 'bytes');

// 2. Batch recording with status rules (Section A: session 1 at 09:00; session 2 at 14:00)
const ev = (id, type, sec, roll, t, extra) => Object.assign({ eventId: id, eventType: type, section: sec, rollNo: roll, name: 'N', lat: 31.47, lng: 74.40, distanceMeters: 20, accuracy: 12, deviceId: 'DEV-x', deviceTs: t, skewMs: 1000 }, extra || {});
ctx.__batch = [
  ev('e1', 'SIGN_IN', 'BSCS-A', '101', at('09:04')),   // on time
  ev('e2', 'SIGN_IN', 'bscs-a', '102', at('09:06')),   // fined (case-insensitive section)
  ev('e3', 'SIGN_IN', 'BSCS-A', '103', at('09:10')),   // late + fined
  ev('e4', 'SIGN_IN', 'BSCS-A', '104', at('09:20')),   // absent
  ev('e5', 'SIGN_IN', 'BSCS-A', '105', at('13:58')),   // nearest session is 14:00 -> on time, session 2
  ev('e6', 'SIGN_IN', 'BSCS-C', '301', at('09:30')),   // no timetable -> On Time (original fallback)
  ev('e7', 'GPS_PING_2MIN', 'BSCS-A', '101', at('09:14')),
  ev('e8', 'AUTO_LOGOUT_ABSENT', 'BSCS-A', '101', at('09:40')),
  ev('e9', 'SIGN_IN', 'BSCS-A', '=cmd', at('09:00'), { name: '+danger', skewMs: 9 * 60000 }),
];
let res = run('recordAttendanceBatch(__batch)');
assert.ok(Object.values(res.results).every(v => v === 'ok'), JSON.stringify(res.results));
// records now live in a tab per class per day; rows() gathers them all
const rows = () => run('__logRows()');
const tabs = () => run('SpreadsheetApp.getActiveSpreadsheet().getSheets().map(s => s.getName())');
assert.strictEqual(rows().length, 9);
assert.strictEqual(
  JSON.stringify([].concat(tabs()).filter(n => n !== 'Roster' && n !== 'Sheet2').sort()),
  JSON.stringify(['2026-09-22 BSCS-A', '2026-09-22 BSCS-C']),
  'one tab per class per day, whatever case the phone sent: ' + [].concat(tabs()).join(', '));
assert.strictEqual(run("SpreadsheetApp.getActiveSpreadsheet().getSheetByName('2026-09-22 BSCS-A').getRange(1, 19).getValue()"), 'Session No', 'a new tab gets the full headers');
const byId = Object.fromEntries(rows().map(x => [x[22], x]));
const st = (id) => [byId[id][13], byId[id][14], byId[id][15], byId[id][16], byId[id][17], byId[id][18]].join('|');
assert.strictEqual(st('e1'), '+4 mins|On Time||||1');
assert.strictEqual(st('e2'), '+6 mins||Fined|||1');
assert.strictEqual(st('e3'), '+10 mins||Fined|Late||1');
assert.strictEqual(st('e4'), '+20 mins||||Absent|1');
assert.strictEqual(st('e5'), '-2 mins|On Time||||2');
assert.strictEqual(st('e6'), '|On Time||||');
assert.strictEqual(byId.e8[17], 'Absent');
assert.strictEqual(byId.e1[1] + ' ' + byId.e1[2] + ' ' + byId.e1[3], '2026-09-22 Tuesday 09:04:00');
assert.strictEqual(byId.e9[5], "'=cmd"); assert.strictEqual(byId.e9[7], "'+danger");
assert.strictEqual(byId.e9[21], 'Device clock ahead by 9 min');
assert.strictEqual(byId.e1[21], 'OK');
console.log('statuses, dates, formula guard, clock check ok');

// 3. Retry of the same events -> duplicates are recognised, no new rows
res = run('recordAttendanceBatch(__batch)');
assert.ok(Object.values(res.results).every(v => v === 'dup'));
assert.strictEqual(rows().length, 9);
console.log('dedup ok');

// 4. Photo: uploaded once, private by default; dup photo not re-uploaded
ctx.__photo = [ev('p1', 'PHOTO_UPLOAD', 'BSCS-A', '101', at('09:30'), { imageBase64: 'data:image/jpeg;base64,' + Buffer.from('fakejpeg').toString('base64') })];
res = run('recordAttendanceBatch(__photo)'); assert.strictEqual(res.results.p1, 'ok');
res = run('recordAttendanceBatch(__photo)'); assert.strictEqual(res.results.p1, 'dup');
assert.strictEqual(ctx.__gas.files.length, 1); assert.ok(!ctx.__gas.files[0].shared);
assert.ok(String(byIdNow('p1')[11]).startsWith('https://drive.mock/BSCSA_101_'), 'photo link: ' + byIdNow('p1')[11]);
console.log('photo ok');

// 5. Old page: legacy single-record call with a day-first locale time string
ctx.__old = { eventType: 'SIGN_IN', section: 'BSCS-B', rollNo: '201', name: 'Hira', lat: 1, lng: 2, distanceMeters: 5, imageBase64: '', deviceId: 'D', deviceTime: '22/09/2026, 11:03:00' };
assert.strictEqual(run('recordAttendance(__old)'), 'SUCCESS');
const legacyRow = rows().filter(r => r[5] === '201' && r[6] === 'BSCS-B').pop();
assert.strictEqual(legacyRow[21], 'Old app version');
// an unparseable old-format time falls back to "now", so the row lands in that day's tab
assert.ok(tabs().indexOf(legacyRow[1] + ' BSCS-B') >= 0, 'the old single-record call lands in its class tab too: ' + [].concat(tabs()).join(', '));
console.log('legacy call ok (old code would have thrown here on the unparseable date)');

// 6. A bad record fails alone, the rest of the batch still lands
ctx.__mixed = [ev('m1', 'PHOTO_UPLOAD', 'BSCS-A', '101', at('09:31'), { imageBase64: 'data:image/jpeg;base64,%%%notbase64' }), ev('m2', 'GPS_PING_2MIN', 'BSCS-A', '101', at('09:32'))];
ctx.Utilities.base64Decode = (b) => { if (/%/.test(b)) throw new Error('Could not decode string.'); return [1]; };
res = run('recordAttendanceBatch(__mixed)');
assert.ok(res.results.m1.startsWith('error')); assert.strictEqual(res.results.m2, 'ok');
console.log('per-record errors ok:', res.results.m1);

// 7. JSON API used when the page is hosted outside Apps Script (GitHub Pages)
const api = (expr) => { const out = run(expr); assert.strictEqual(out.mime, 'application/json'); return JSON.parse(out.getContent()); };
let j = api("doGet({ parameter: { action: 'ping' } })");
assert.ok(j.ok && j.result.serverTs > 0);
j = api("doGet({ parameter: { action: 'roster', v: 'none' } })");
assert.ok(j.ok && j.result.students.length === 4 && j.result.sections === undefined);
const ver = j.result.version;
j = api(`doGet({ parameter: { action: 'roster', v: '${ver}' } })`);
assert.ok(j.ok && j.result.notModified);
j = api(`doPost({ postData: { contents: JSON.stringify({ action: 'roster', v: '${ver}' }) } })`);
assert.ok(j.ok && j.result.notModified);
const before = rows().length;
ctx.__body = JSON.stringify({ action: 'record', events: [ev('h1', 'SIGN_IN', 'BSCS-A', '101', at('09:03'))] });
j = api('doPost({ postData: { contents: __body } })');
assert.ok(j.ok && j.result.results.h1 === 'ok' && rows().length === before + 1);
j = api('doPost({ postData: { contents: __body } })');
assert.ok(j.ok && j.result.results.h1 === 'dup' && rows().length === before + 1, 'retry over HTTP is not duplicated');
j = api("doPost({ postData: { contents: 'not json' } })");
assert.ok(!j.ok && j.error);
j = api("doGet({ parameter: { action: 'nope' } })");
assert.ok(!j.ok);
assert.ok(run('doGet({ parameter: {} })').setTitle, 'no action -> HTML page as before');
console.log('JSON API ok (ping, roster, notModified, record, dedup, bad input)');

// 8. Class rush: duplicate checking without reading the sheet, busy replies, no repeated Drive upload
const fresh = () => Date.now() - 30000;   // queued a moment ago, as during a rush
ctx.__warm = [ev('w0', 'GPS_PING_2MIN', 'BSCS-A', '101', fresh())];
run('recordAttendanceBatch(__warm)');          // first call of the day fills the caches
const meter = run('__meterReset()');
ctx.__rush = [ev('r1', 'SIGN_IN', 'BSCS-A', '101', fresh()), ev('r2', 'GPS_PING_2MIN', 'BSCS-A', '102', fresh())];
res = run('recordAttendanceBatch(__rush)');
assert.strictEqual(res.results.r1, 'ok');
assert.ok(!meter.cells.sheetRead, 'an upload during the rush reads nothing from the sheet: ' + JSON.stringify(meter));
res = run('recordAttendanceBatch(__rush)');
assert.strictEqual(res.results.r1, 'dup', 'repeat caught from the cache');

// the cache can be dropped at any time; a phone that says it is resending makes the server look at the sheet
ctx.__gas.cache = {};
run("__gas.cache = {}");
ctx.__retry = [Object.assign({}, ctx.__rush[0], { retry: 1 })];
res = run('recordAttendanceBatch(__retry)');
assert.strictEqual(res.results.r1, 'dup', 'repeat still caught after the cache was lost');

// sheet busy: nothing written, the phone is told to wait, and the photo is not sent to Drive twice
const filesBefore = ctx.__gas.files.length, rowsBefore = rows().length;
ctx.__gas.lockHeld = true;
ctx.__busy = [ev('b1', 'PHOTO_UPLOAD', 'BSCS-A', '101', fresh(), { imageBase64: 'data:image/jpeg;base64,' + Buffer.from('jpegbytes').toString('base64') })];
ctx.Utilities.base64Decode = (b) => [1];
res = run('recordAttendanceBatch(__busy)');
assert.ok(res.busy && res.retryAfterMs > 0 && !res.results.b1, 'busy reply, record not confirmed');
assert.strictEqual(rows().length, rowsBefore, 'nothing written while busy');
assert.strictEqual(ctx.__gas.files.length, filesBefore + 1, 'photo had already gone to Drive');
ctx.__gas.lockHeld = false;
res = run('recordAttendanceBatch(__busy)');
assert.strictEqual(res.results.b1, 'ok');
assert.strictEqual(ctx.__gas.files.length, filesBefore + 1, 'retry reused the photo instead of uploading it again');
assert.strictEqual(rows().length, rowsBefore + 1);
console.log('rush ok (cache dedup, busy reply, photo uploaded once)');

// 9. Today's class summary: sign-ins only, one row per student, section filtered, cached
const today = run("Utilities.formatDate(new Date(), 'Asia/Karachi', 'yyyy-MM-dd')");
ctx.__day = [ev('s1', 'SIGN_IN', 'BSCS-A', '101', Date.now() - 60000),
             ev('s2', 'GPS_PING_2MIN', 'BSCS-A', '101', Date.now() - 30000),
             ev('s3', 'SIGN_IN', 'BSCS-A', '101', Date.now() - 10000),   // same student again
             ev('s4', 'SIGN_IN', 'BSCS-B', '201', Date.now() - 20000)];
run('recordAttendanceBatch(__day)');
let sum = run(`getDaySummary('BSCS-A', '${today}')`);
assert.strictEqual(sum.students.length, 1, 'one row per student, pings and repeats left out');
assert.strictEqual(sum.students[0][1], '101');
assert.strictEqual(sum.counts.signedIn, 1);
const all = run(`getDaySummary('', '${today}')`);
assert.ok(all.counts.signedIn >= 2, 'no section given: the whole day');
const m2 = run('__meterReset()');
run(`getDaySummary('BSCS-A', '${today}')`);
assert.ok(!m2.cells.sheetRead, 'a second phone asking within the minute is served from the cache');
assert.ok(!run(`getDaySummary('BSCS-A', '2020-01-01')`).students.length, 'a day with nothing returns nothing');
console.log('day summary ok (sign-ins only, per section, cached)');

// 10. A deleted tab is simply recreated
const liveTab = '2026-09-22 BSCS-A';
delete ctx.__gas.sheets[liveTab];
run("__gas.cache = {}");
ctx.__again = [ev('n1', 'SIGN_IN', 'BSCS-A', '109', Date.now() - 20000)];
res = run('recordAttendanceBatch(__again)');
assert.strictEqual(res.results.n1, 'ok');
assert.ok(rows().filter(r => r[22] === 'n1').length === 1, 'the tab was created again and the record landed');

// 11. If a tab cannot be written, those records stay unconfirmed while the rest still land
run('__realSS = SpreadsheetApp.getActiveSpreadsheet');
run("SpreadsheetApp.getActiveSpreadsheet = (function (orig) { return function () { var ss = orig(); var wrapped = {}; for (var k in ss) wrapped[k] = ss[k]; wrapped.insertSheet = function () { throw new Error('no permission'); }; return wrapped; }; })(SpreadsheetApp.getActiveSpreadsheet)");
ctx.__split = [ev('g1', 'SIGN_IN', 'BSCS-A', '110', Date.now() - 15000),          // tab exists
               ev('g2', 'SIGN_IN', 'BSCS-NEW', '999', Date.now() - 15000)];       // tab would have to be created
res = run('recordAttendanceBatch(__split)');
assert.strictEqual(res.results.g1, 'ok', 'the class whose tab exists is recorded');
assert.ok(!res.results.g2 && res.tabError, 'the other stays unconfirmed so the phone retries: ' + res.tabError);
console.log('per-class tabs ok (created, recreated, one class failing does not lose another)');

// 12. Splitting an old single tab into per-class tabs, twice, changes nothing the second time
run("SpreadsheetApp.getActiveSpreadsheet = __realSS");
run("__setupSheets('2026-09-22')");
run("__gas.sheets.Sheet2.raw.push(['ts','2026-09-21','Monday','09:03','SIGN_IN','101','BSCS-A','Ayesha',1,2,3,'','D','','On Time','','','','','','','','old-1'])");
run("__gas.sheets.Sheet2.raw.push(['ts','2026-09-21','Monday','09:05','SIGN_IN','201','BSCS-B','Hira',1,2,3,'','D','','On Time','','','','','','','','old-2'])");
run("__gas.sheets.Sheet2.shown.push([]); __gas.sheets.Sheet2.shown.push([])");
const first = run('splitLegacyLog()');
assert.ok(/Copied 2 row/.test(first), first);
assert.ok(tabs().indexOf('2026-09-21 BSCS-A') >= 0 && tabs().indexOf('2026-09-21 BSCS-B') >= 0, 'old rows split by class and day');
const second = run('splitLegacyLog()');
assert.ok(/Copied 0 row/.test(second) && /2 were already there/.test(second), second);
assert.strictEqual(run("__gas.sheets.Sheet2.raw.length"), 3, 'the old tab is left as it was');
console.log('legacy split ok:', second);
console.log('\nALL SERVER TESTS PASSED');
