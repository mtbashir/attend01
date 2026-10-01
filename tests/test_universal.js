// One app for every class: per-class settings in the Roster, sign-in window, server-side distance,
// check-out / early-leaver / shared-phone flags, shared roll numbers, Roster check and setup.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const ctx = { console, Intl, Date, Math, JSON, btoa, atob, String, Number, Array, Object, isFinite, isNaN, parseInt, Infinity };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'mock_gas.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8'), ctx);
const run = (s) => vm.runInContext(s, ctx);
const eq = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);   // arrays from the VM are another realm's
const TZ = 'Asia/Karachi';
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const DAY = dayOf(Date.now() - 86400000);              // yesterday: its classes are over, so flags are due
const at = (hhmm, day) => new Date((day || DAY) + 'T' + hhmm + ':00+05:00').getTime();
const LUMS = [31.4708, 74.4097], FAST = [31.48104614, 74.30328505];

const HDR = ['Section', 'Student Roll No', 'Student Name', 'Class Name', 'Session No.', 'Day', 'Session Dates', 'Section',
  'Session Start Time', 'Session End Time', 'Fine if Delay by Min', 'Late if Delay by Min', 'Absent if Delay by Min',
  'Latitude', 'Longitude', 'Radius (m)', 'Sign-in Opens (min before start)', 'Check-out Opens (min before end)',
  'Early Leaver if Not Seen (min before end)'];
function setRoster(header, rows) {
  const sh = ctx.__gas.sheets.Roster;
  sh.raw = [header].concat(rows); sh.shown = sh.raw.map(r => r.map(String));
  sh.maxCols = Math.max(26, header.length + 8);
  run('clearRosterCache()');
}
function freshSheets() { run(`__setupSheets('${DAY}')`); }

// ---------------------------------------------------------------- 1. Roster with the new columns
freshSheets();
setRoster(HDR, [
  ['ECOM-SEP-26', 'ECOM-SEP-26', 'Ali Dhillon', 'LUMS ECOM Sep-2026', '1', 'x', DAY, 'ECOM-SEP-26', '18:30 PM', '20:30 PM', 5, 10, 20, LUMS[0], LUMS[1], 50, 30, 10, 30],
  ['ECOM-SEP-26', 'ECOM-SEP-26', 'Asma Bashir', '', '2', 'x', DAY, 'ECOM-SEP-26', '09:00', '10:00', '', '', '', LUMS[0], LUMS[1], '', '', '', ''],
  ['ECOM-SEP-26', 'E-03', 'Ali Hassan', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['ECOM-SEP-26', 'E-04', 'Ayaan Faisal', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['ECOM-SEP-26', 'E-05', 'Faryal Tariq', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['ECOM-SEP-26', 'E-06', 'Fatima Khan', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['ECOM-SEP-26', 'E-07', 'Hammad Afzal', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['BSBA 7A', '22L-5002', 'Ezzan Hussain', '', '7', 'x', DAY, 'BSBA 7A', '16:00', '17:20', '0', '7', '15', FAST[0], FAST[1], 100, 15, 5, 20],
]);
const r = run("getRosterData('none')");
const ecom = r.timetable.find(t => t.sessionNo === '1');
eq([ecom.lat, ecom.lng, ecom.radius, ecom.opensMin, ecom.checkoutMin, ecom.earlyMin], [LUMS[0], LUMS[1], 50, 30, 10, 30]);
eq(ecom.rules, [5, 10, 20], '"Late if Delay by Min" in L is not mistaken for Latitude');
assert.strictEqual(ecom.startTime, '18:30');
const blank = r.timetable.find(t => t.sessionNo === '2');
eq([blank.radius, blank.opensMin, blank.checkoutMin, blank.earlyMin], [100, 30, 10, 30], 'blank cells take the defaults');
const fast = r.timetable.find(t => t.sessionNo === '7');
eq([fast.lat, fast.radius, fast.opensMin, fast.earlyMin], [FAST[0], 100, 15, 20], 'each class keeps its own settings');
assert.strictEqual(r.classNames['ecom-sep-26'], 'LUMS ECOM Sep-2026');
console.log('roster: per-class location, radius and windows ok');

// ---------------------------------------------------------------- 2. sign-in window and server distance
const ev = (id, type, roll, name, t, extra) => Object.assign({ eventId: id, eventType: type, section: 'ECOM-SEP-26', rollNo: roll, name: name,
  lat: LUMS[0], lng: LUMS[1], distanceMeters: 999, accuracy: 10, deviceId: 'DEV-' + name, deviceTs: t, skewMs: 0 }, extra || {});
ctx.__b = [
  ev('w1', 'SIGN_IN', 'E-03', 'Ali Hassan', at('17:55')),                       // 35 min early: before sign-in opens
  ev('w2', 'SIGN_IN', 'E-04', 'Ayaan Faisal', at('18:05')),                     // inside the window
  ev('w3', 'SIGN_IN', 'E-05', 'Faryal Tariq', at('18:40')),                     // fined (5 < 10 <= 10)
  ev('w4', 'SIGN_IN', 'E-06', 'Fatima Khan', at('09:10')),                      // morning session 2
  ev('w5', 'SIGN_IN', 'E-07', 'Hammad Afzal', at('18:31'), { lat: FAST[0], lng: FAST[1], distanceMeters: 5 }),   // phone claims 5 m from FAST
  ev('w6', 'SIGN_IN', 'E-07', 'Hammad Afzal', at('12:00', DAY), { section: 'NO-SUCH-CLASS' }),
];
let res = run('recordAttendanceBatch(__b)');
assert.ok(Object.values(res.results).every(v => v === 'ok'), JSON.stringify(res.results));
const byId = () => Object.fromEntries(run('__logRows()').map(x => [x[22], x]));
let b = byId();
assert.strictEqual(b.w1[13], '-35 mins (before sign-in opened)');
assert.strictEqual(b.w2[13] + '|' + b.w2[14] + '|' + b.w2[18], '-25 mins|On Time|1');
assert.strictEqual(b.w3[13] + '|' + b.w3[15], '+10 mins|Fined');
assert.strictEqual(b.w4[18], '2', 'a sign-in picks the session whose window it falls in');
assert.ok(b.w5[10] > 10000, 'distance worked out on the server from the session classroom, not the phone\'s 5 m: ' + b.w5[10]);
assert.strictEqual(b.w6[13], 'No session found');
assert.strictEqual(b.w2[10], 0, 'phone at the classroom -> 0 m');
console.log('sign-in window, session choice, server distance, no-session ok');

// ---------------------------------------------------------------- 3. after class: check-out, early leaver, shared phone
freshSheets();
setRoster(HDR, [
  ['ECOM-SEP-26', 'ECOM-SEP-26', 'Ali Dhillon', '', '1', 'x', DAY, 'ECOM-SEP-26', '18:30', '20:30', 5, 10, 20, LUMS[0], LUMS[1], 50, 30, 10, 30],
  ['ECOM-SEP-26', 'ECOM-SEP-26', 'Asma Bashir', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
]);
const far = { lat: LUMS[0] + 0.01, lng: LUMS[1] };    // about 1.1 km away
ctx.__c = [
  // S1 checks out inside the area
  ev('a1', 'SIGN_IN', 'E-01', 'S1', at('18:31')), ev('a2', 'GPS_PING_2MIN', 'E-01', 'S1', at('20:05')), ev('a3', 'CHECK_OUT', 'E-01', 'S1', at('20:22')),
  // S2 last seen at 19:30: early leaver
  ev('b1', 'SIGN_IN', 'E-02', 'S2', at('18:32')), ev('b2', 'GPS_PING_2MIN', 'E-02', 'S2', at('19:30')),
  // S3 seen at 20:10 but no check-out: not early, no check-out
  ev('c1', 'SIGN_IN', 'E-03', 'S3', at('18:33')), ev('c2', 'GPS_PING_2MIN', 'E-03', 'S3', at('20:10')),
  // S4's only late location is 1 km away: early leaver
  ev('d1', 'SIGN_IN', 'E-04', 'S4', at('18:34')), ev('d2', 'GPS_PING_2MIN', 'E-04', 'S4', at('20:15'), far),
  // S5 absent (30 min late): no early-leaver verdict
  ev('e1', 'SIGN_IN', 'E-05', 'S5', at('19:00')),
  // S6 and S7 signed in on the same phone
  ev('f1', 'SIGN_IN', 'E-06', 'S6', at('18:35'), { deviceId: 'DEV-shared' }), ev('f2', 'SIGN_IN', 'E-07', 'S7', at('18:36'), { deviceId: 'DEV-shared' }),
  // two students sharing roll no ECOM-SEP-26 are told apart by name
  ev('g1', 'SIGN_IN', 'ECOM-SEP-26', 'Ali Dhillon', at('18:30')), ev('g2', 'CHECK_OUT', 'ECOM-SEP-26', 'Ali Dhillon', at('20:25')),
  ev('h1', 'SIGN_IN', 'ECOM-SEP-26', 'Asma Bashir', at('18:30')),
];
res = run('recordAttendanceBatch(__c)');
assert.ok(Object.values(res.results).every(v => v === 'ok'), JSON.stringify(res.results));
const msg = run('updateFlags()');
assert.ok(/Updated 9 sign-in row/.test(msg), msg);
b = byId();
const fl = (id) => [b[id][23], b[id][24], b[id][25], b[id][26]].join('|');
assert.strictEqual(fl('a1'), 'Yes 20:22|20:22|No|');
assert.strictEqual(fl('b1'), 'No|19:30|Yes|');
assert.strictEqual(fl('c1'), 'No|20:10|No|');
assert.strictEqual(fl('d1'), 'No|18:34|Yes|', 'a location outside the area does not count as seen');
assert.strictEqual(fl('e1'), 'No|19:00||', 'absentees get no early-leaver verdict');
assert.strictEqual(fl('f1'), 'No|18:35|Yes|Yes: 2 students');
assert.strictEqual(fl('f2'), 'No|18:36|Yes|Yes: 2 students');
assert.strictEqual(fl('g1'), 'Yes 20:25|20:25|No|', 'shared roll no: Ali\'s check-out stays Ali\'s');
assert.strictEqual(fl('h1'), 'No|18:30|Yes|', '... and does not cover Asma');
assert.strictEqual(fl('a2'), '|||', 'only sign-in rows carry flags');
assert.ok(/Updated 0 sign-in row/.test(run('updateFlags()')), 'running it again changes nothing');

// the class summary counts both students sharing a roll no
const sum = run(`getDaySummary('ECOM-SEP-26', '${DAY}')`);
assert.strictEqual(sum.students.filter(s => s[1] === 'ECOM-SEP-26').length, 2, 'two students, one roll no, two rows');

// Sheets turns "2026-09-30" into a date when it is written: the summary still finds the rows
const tab = ctx.__gas.sheets[DAY + ' ECOM-SEP-26'];
tab.raw.forEach((row, i) => { if (i) row[1] = new Date(DAY + 'T00:00:00+05:00'); });
run('__gas.cache = {}');
assert.strictEqual(run(`getDaySummary('ECOM-SEP-26', '${DAY}')`).counts.signedIn, 9);

// a class that has not ended yet (today, ends 23:59) gets no flags
freshSheets();
const TODAY = dayOf(Date.now());
setRoster(HDR, [['X', 'X-1', 'Late Owl', '', '1', 'x', TODAY, 'X', '00:00', '23:59', 5, 10, 20, LUMS[0], LUMS[1], 50, 30, 10, 30]]);
ctx.__t = [ev('t1', 'SIGN_IN', 'X-1', 'Late Owl', Date.now() - 60000, { section: 'X' })];
run('recordAttendanceBatch(__t)');
run('updateFlags()');
assert.strictEqual([0, 1, 2].map(i => run('__logRows()')[0][23 + i]).join('|'), '||', 'flags wait until the class is over');
console.log('flags ok (check-out, early leaver, outside pings, absentees, shared phone, shared roll no, waits for class end)');

// ---------------------------------------------------------------- 4. Roster check and setup
freshSheets();
setRoster(HDR.slice(0, 13).map((h, i) => i === 3 ? '' : h), [   // the Roster as it is today: no new columns
  ['ECOM-SEP-26', 'ECOM-SEP-26', 'Abdullah Umar', '', '1', 'Tuesday', DAY, 'ECOM-SEP-26', '18:30 PM', '20:30 PM', 5, 10, 20],
  ['ECOM-SEP-26', 'ECOM-SEP-26', 'Ali Dhillon', '', '2', 'Friday', DAY, 'ECOM-SEP-26', 'half six', '20:30 PM', 5, 10, 20],
  ['ECOM-SEP-26', 'ECOM-SEP-26', 'Ali Hassan', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '3', 'Friday', DAY, 'GHOST', '10:00', '11:00', 9, 5, 1],
]);
let problems = run('checkRoster()');
const has = (re) => assert.ok(problems.some(p => re.test(p)), re + ' not found in:\n' + problems.join('\n'));
has(/missing: Class Name, Latitude, Longitude, Radius/);
has(/Roll no ECOM-SEP-26 in ECOM-SEP-26 is shared by 3 students/);
has(/start time "half six" cannot be read/);
has(/no classroom Latitude/);
has(/three numbers, smallest first/);
has(/GHOST has sessions but no students/);
console.log('checkRoster ok:', problems.length, 'problems found');

const setup1 = run('setupRosterColumns()');
assert.ok(/Added: Class Name, Latitude, Longitude, Radius \(m\), Check-out Opens/.test(setup1), setup1);
const sh = ctx.__gas.sheets.Roster;
assert.strictEqual(sh.raw[0].length, 20);
eq(sh.raw[1].slice(16, 20).map(String), ['100', '10', '30', '30'], 'defaults written into session rows');
assert.strictEqual(String(sh.raw[3][16] || ''), '', 'student-only rows are left blank');
const setup2 = run('setupRosterColumns()');
assert.ok(/already there/.test(setup2) && !/Filled/.test(setup2), 'second run adds nothing: ' + setup2);
problems = run('checkRoster()');
assert.ok(!problems.some(p => /missing:/.test(p)));
console.log('setupRosterColumns ok:', setup1);

console.log('\nALL UNIVERSAL TESTS PASSED');
