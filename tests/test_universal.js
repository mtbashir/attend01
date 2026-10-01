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
has(/start time "half six" in column I cannot be read/);
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

// ---------------------------------------------------------------- 5. the live Roster layout (1 Oct 2026)
// Class/Course inserted at E pushes every timetable column one to the right; LAT / LONG / Radius at O-Q.
// Columns are found by header, so this must read exactly like the standard layout.
freshSheets();
const LIVE = ['Section', 'Student Roll No', 'Student Name', '', 'Class/Course', 'Session No. ', 'Day', 'Session Dates', 'Section', 'Start Time',
  'End Time', 'Fine if Delay by Min', 'Late if Delay by Min', 'Absent if Delay by Min', 'LAT', 'LONG', 'Radius'];
const t1899 = (h, m) => new Date(Date.UTC(1899, 11, 30, h - 5, m - 28));   // how Sheets hands back a time-only cell
const liveRows = [
  ['ECOM-SEP-26', '1', 'Abdullah Umar', '', 'ECOM-SEP-26', '4', 'Thursday', new Date(DAY + 'T00:00:00+05:00'), 'ECOM-SEP-26', t1899(18, 30), t1899(20, 30), 5, 10, 20, 31.47084875, 74.40948265, 300],
  ['ECOM-SEP-26', '14', 'Mahnoor Elahi', '', 'BSBA 7A', '1', 'Thursday', new Date(DAY + 'T00:00:00+05:00'), 'BSBA 7A', t1899(16, 0), t1899(17, 20), 0, 7, 15, 31.48103858, 74.30327411, 300],
];
const sh5 = ctx.__gas.sheets.Roster;
sh5.raw = [LIVE].concat(liveRows); sh5.maxCols = 30;
sh5.shown = sh5.raw.map((r, i) => r.map((v, j) => !i ? v : j === 7 ? '1-Oct-2026' : j === 9 ? (i === 1 ? '6:30:00 PM' : '4:00:00 PM') : j === 10 ? (i === 1 ? '8:30:00 PM' : '5:20:00 PM') : String(v)));
run('clearRosterCache()');
const live = run("getRosterData('none')");
const s4 = live.timetable.find(t => t.section === 'ECOM-SEP-26');
eq([s4.sessionNo, s4.date, s4.startTime, s4.endTime, s4.rules, s4.lat, s4.radius], ['4', DAY, '18:30', '20:30', [5, 10, 20], 31.47084875, 300]);
const bsba = live.timetable.find(t => t.section === 'BSBA 7A');
eq([bsba.sessionNo, bsba.startTime, bsba.endTime, bsba.rules, bsba.lng], ['1', '16:00', '17:20', [0, 7, 15], 74.30327411]);
eq(live.students[0], ['1', 'Abdullah Umar', 'ECOM-SEP-26'], 'student block read from A to C');
assert.strictEqual(live.classNames['bsba 7a'], 'BSBA 7A', 'Class/Course is the class name');
ctx.__l = [ev('L1', 'SIGN_IN', '1', 'Abdullah Umar', at('18:42'), { lat: 31.4708, lng: 74.4095 })];
run('recordAttendanceBatch(__l)');
const l1 = run('__logRows()').find(x => x[22] === 'L1');
assert.strictEqual([l1[13], l1[15], l1[16], l1[18]].join('|'), '+12 mins|Fined|Late|4', '12 minutes late on the live layout');
problems = run('checkRoster()');
assert.ok(!problems.some(p => /cannot be read|not recognised|no classroom/.test(p)), 'live layout reads cleanly:\n' + problems.join('\n'));
eq(run('rosterColumns_(' + JSON.stringify(LIVE) + ').col.sessionSection'), 8, 'the second Section (I) is the session\'s');
const setupLive = run('setupRosterColumns()');
assert.ok(/^Added: Check-out Opens \(min before end\), Early Leaver if Not Seen \(min before end\), Sign-in Opens \(min before start\)\. Filled 6/.test(setupLive),
  'only the three missing columns are added, defaults go into both session rows: ' + setupLive);
eq(sh5.raw[1].slice(17, 20).map(String), ['10', '30', '30']);
console.log('live Roster layout ok (Class/Course at E, LAT/LONG/Radius at O-Q, times as 6:30:00 PM)');

// ---------------------------------------------------------------- 6. attendance register
freshSheets();
const D2 = dayOf(Date.now() - 2 * 86400000), D1 = DAY, TMR = dayOf(Date.now() + 86400000);
const sessRow = (sec, no, day, start, end, rules, loc) => ['', '', '', '', sec, no, 'x', new Date(day + 'T00:00:00+05:00'), sec, start, end].concat(rules, loc, [300]);
const reg = ctx.__gas.sheets.Roster;
reg.raw = [LIVE,
  ['ECOM-SEP-26', '1', 'Amna'].concat(sessRow('ECOM-SEP-26', '1', D2, '18:30', '20:30', [5, 10, 20], LUMS).slice(3)),
  ['ECOM-SEP-26', '2', 'Bilal'].concat(sessRow('ECOM-SEP-26', '2', D1, '18:30', '20:30', [5, 10, 20], LUMS).slice(3)),
  ['ECOM-SEP-26', '3', 'Chand'].concat(sessRow('ECOM-SEP-26', '3', TMR, '18:30', '20:30', [5, 10, 20], LUMS).slice(3)),
  ['ECOM-SEP-26', '4', 'Dua'].concat(sessRow('BSBA 7A', '1', D1, '16:00', '17:20', [0, 7, 15], FAST).slice(3)),
  ['BSBA 7A', '22L-1', 'Ezzan', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
];
reg.shown = reg.raw.map((r) => r.map((v) => v instanceof Date ? 'date' : String(v)));
reg.raw.forEach((r, i) => { if (i && r[7] instanceof Date) reg.shown[i][7] = dayOf(r[7].getTime()); });
run('clearRosterCache()');
// session 1 (two days ago): Bilal's sign-in is in the old Sheet2, under the shared roll no of those days
ctx.__gas.sheets.Sheet2.raw.push(['x', D2, 'x', '18:32:00', 'SIGN_IN', 'ECOM-SEP-26', 'ECOM-SEP-26', 'Bilal', 1, 2, 3, '', 'D-b', '', 'On Time', '', '', '', '', '', '', '', 'old-b']);
ctx.__gas.sheets.Sheet2.shown.push(ctx.__gas.sheets.Sheet2.raw[ctx.__gas.sheets.Sheet2.raw.length - 1].map(String));
const R = (id, roll, name, day, hm, extra) => ev(id, 'SIGN_IN', roll, name, at(hm, day), extra);
ctx.__r = [
  R('r1', '1', 'Amna', D2, '18:31'), R('r2', '3', 'Chand', D2, '18:40'),                                   // Present, Fined; Dua never came
  R('r3', '1', 'Amna', D1, '18:45'), R('r4', '2', 'Bilal', D1, '19:00'), R('r5', '3', 'Chand', D1, '18:30'), // Late, Absent, Present (leaves early)
  R('r6', '4', 'Dua', D1, '18:29'), ev('r7', 'AUTO_LOGOUT_ABSENT', '4', 'Dua', at('19:10', D1)),            // on time, then out of the area 10 min
  R('r8', '22L-1', 'Ezzan', D1, '15:59', { section: 'BSBA 7A', lat: FAST[0], lng: FAST[1] }),
  ev('r10', 'GPS_PING_2MIN', '22L-1', 'Ezzan', at('17:05', D1), { section: 'BSBA 7A', lat: FAST[0], lng: FAST[1] }),
  ev('r9', 'GPS_PING_2MIN', '1', 'Amna', at('20:10', D1)),                                                 // Amna stays to the end
];
res = run('recordAttendanceBatch(__r)');
assert.ok(Object.values(res.results).every((v) => v === 'ok'), JSON.stringify(res.results));
const flagMsg = run('updateFlags()');
assert.ok(/Attendance register: 5 student\(s\) x 4 session\(s\)/.test(flagMsg), 'updateFlags also rebuilds the register: ' + flagMsg);
const G = ctx.__gas.sheets['Attendance Register'].raw;
const cols = G[0].length;
eq(G[0].slice(8), ['BSBA 7A', 'ECOM-SEP-26', 'ECOM-SEP-26', 'ECOM-SEP-26'], 'class header, classes in alphabetical order, sessions by date');
eq(G[1].slice(8), ['S1', 'S1', 'S2', 'S3'], 'session header');
const fmtD = (d) => { const [y, m, dd] = d.split('-'); return +dd + '-' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1] + '-' + y; };
eq(G[2].slice(0, 9), ['Section', 'Roll No', 'Student Name', 'Present', 'Fined', 'Late', 'Absent', 'Left Early', fmtD(D1)]);
assert.strictEqual(G[2][9], fmtD(D2), 'date header');
const row = (name) => G.find((r) => r[2] === name);
eq(row('Amna').slice(3), [1, 0, 1, 0, 0, '', 'Present', 'Late', ''], 'Amna: on time, then 15 min late; tomorrow blank; other class blank');
eq(row('Bilal').slice(3), [1, 0, 0, 1, 0, '', 'Present', 'Absent · 30 min late', ''], 'Bilal: found in the old Sheet2 by name; 30 min late = Absent');
eq(row('Chand').slice(3), [1, 1, 0, 0, 1, '', 'Fined', 'Present · Left early', ''], 'Chand: fined; not seen in the last 30 min');
eq(row('Dua').slice(3), [1, 0, 0, 1, 1, '', 'Absent · no sign-in', 'Present · Left early (out of area 19:10)', ''],
  'Dua: never came; then on time but signed out for leaving the area during class = left early, not absent');
eq(row('Ezzan').slice(3), [1, 0, 0, 0, 0, 'Present', '', '', ''], 'BSBA student: only the BSBA column is filled');
const bg = ctx.__gas.sheets['Attendance Register'].bg;
assert.strictEqual(bg[G.indexOf(row('Amna'))][10], '#fce8dc', 'Late is coloured');
assert.strictEqual(bg[G.indexOf(row('Amna'))][8], '#eef0f2', 'another class\'s session is greyed');
assert.strictEqual(G.length, 8, '3 header rows + 5 students');
run('buildRegister()');
assert.strictEqual(ctx.__gas.sheets['Attendance Register'].raw.length, 8, 'rebuilding replaces, never appends');
// a past session nobody signed in to (the app was not used that day): "No data", not Absent for all
const D3 = dayOf(Date.now() - 3 * 86400000);
reg.raw.push(['', '', ''].concat(sessRow('ECOM-SEP-26', '0', D3, '18:30', '20:30', [5, 10, 20], LUMS).slice(3)));
reg.shown.push(reg.raw[reg.raw.length - 1].map((v) => v instanceof Date ? D3 : String(v)));
run('clearRosterCache()');
run('buildRegister()');
const G2 = ctx.__gas.sheets['Attendance Register'].raw;
const amna2 = G2.find((r) => r[2] === 'Amna');
eq(amna2.slice(3), [1, 0, 1, 0, 0, '', 'No data', 'Present', 'Late', ''], 'unused day shows No data and does not count');
assert.strictEqual(G2.find((r) => r[2] === 'Dua')[6], 1, 'Dua still has exactly 1 absence');
console.log('attendance register ok (present / fined / late / absent / never came / left early / future / other class / old Sheet2 rows / unused day)');

// An old Sheet2 sign-out sent the next morning (dated the class day in Pacific time) is not "during class"
const nextMorning = new Date(at('07:14', dayOf(new Date(D1 + 'T12:00:00+05:00').getTime() + 86400000)));
ctx.__gas.sheets.Sheet2.raw.push([nextMorning, D1, 'x', '19:14:00', 'AUTO_LOGOUT_ABSENT', '1', 'ECOM-SEP-26', 'Amna', 1, 2, 3, '', 'D-a', '', '', '', '', '', '', '', 0, '', 'old-am']);
ctx.__gas.sheets.Sheet2.shown.push(ctx.__gas.sheets.Sheet2.raw[ctx.__gas.sheets.Sheet2.raw.length - 1].map(String));
// a sign-in typed with a name nobody in the Roster has
ctx.__u = [R('u1', '99', 'Amna Khann', D2, '18:35')];
run('recordAttendanceBatch(__u)');
run('buildRegister()');
const G3 = ctx.__gas.sheets['Attendance Register'].raw;
assert.strictEqual(G3.find((r) => r[2] === 'Amna')[11], 'Late', 'a sign-out sent the next morning does not make Amna an early leaver');
const ui = G3.findIndex((r) => /^Sign-ins not matched to a Roster student \(1\)$/.test(r[2]));
assert.ok(ui > 0, 'unmatched heading below the students');
eq(G3[ui + 1].slice(0, 4), ['ECOM-SEP-26', '99', 'Amna Khann', fmtD(D2)], 'the unmatched sign-in, as typed');
console.log('register: next-morning sign-out ignored; unmatched sign-ins listed');

// ---------------------------------------------------------------- 7. spreadsheet set to US Pacific time (the live sheet is)
// Class times are Pakistan time; sign-ins must be judged in Pakistan time whatever the sheet setting.
freshSheets();
ctx.__gas.ssTz = 'America/Los_Angeles';
const pacificMidnight = (day) => { const d = new Date(day + 'T12:00:00Z'); const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' }).formatToParts(d).find((p) => p.type === 'timeZoneName').value; const h = -Number(off.replace('GMT', '')); return new Date(day + 'T' + String(h).padStart(2, '0') + ':00:00Z'); };
const P = ctx.__gas.sheets.Roster;
P.raw = [LIVE, ['ECOM-SEP-26', '1', 'Abdullah Umar', '', 'ECOM-SEP-26', '3', 'Thursday', pacificMidnight(DAY), 'ECOM-SEP-26', t1899(18, 30), t1899(20, 30), 5, 10, 20, 31.47084875, 74.40948265, 300],
         ['ECOM-SEP-26', '2', 'Ali Dhillon', '', '', '', '', '', '', '', '', '', '', '', '', '', '']];
P.shown = P.raw.map((r, i) => r.map((v, j) => !i ? v : j === 7 && v ? '1-Oct-2026' : j === 9 && v ? '6:30:00 PM' : j === 10 && v ? '8:30:00 PM' : String(v)));
P.maxCols = 30;
run('clearRosterCache()');
assert.strictEqual(run("getRosterData('none')").timetable[0].date, DAY, 'a Roster date cell (midnight in the sheet\'s zone) keeps its date');
ctx.__p = [ev('pk1', 'SIGN_IN', '1', 'Abdullah Umar', at('18:42'), { lat: 31.4708, lng: 74.4095 }),
           ev('pk2', 'SIGN_IN', '2', 'Ali Dhillon', at('18:31'), { lat: 31.4708, lng: 74.4095 }),
           ev('pk3', 'AUTO_LOGOUT_ABSENT', '2', 'Ali Dhillon', at('20:45'))];   // walked out after class with the page open
run('recordAttendanceBatch(__p)');
const pk = Object.fromEntries(run('__logRows()').map((x) => [x[22], x]));
assert.strictEqual([pk.pk1[1], pk.pk1[3], pk.pk1[13], pk.pk1[16], pk.pk1[18]].join('|'), DAY + '|18:42:00|+12 mins|Late|3',
  'judged in Pakistan time, not the sheet\'s Pacific time: ' + [pk.pk1[1], pk.pk1[3], pk.pk1[13]].join('|'));
assert.ok(ctx.__gas.sheets[DAY + ' ECOM-SEP-26'], 'tab named by the Pakistan date');
run('buildRegister()');
const PR = ctx.__gas.sheets['Attendance Register'].raw;
assert.strictEqual(PR.find((r) => r[2] === 'Abdullah Umar')[8], 'Late');
assert.strictEqual(PR.find((r) => r[2] === 'Ali Dhillon')[8], 'Present', 'leaving after the class ended is not an absence');
ctx.__gas.ssTz = null;
console.log('time zone ok (sheet on Pacific time, classes in Pakistan time; walking out after class is not absent)');

console.log('\nALL UNIVERSAL TESTS PASSED');
