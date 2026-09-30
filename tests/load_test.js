/*
 * A whole class signing in within the same minute.
 *
 * Apps Script runs one script lock at a time, so whatever happens while the lock is
 * held is the ceiling on how many phones can be served per minute. This counts the
 * Sheets, Drive and Cache work each upload causes and turns it into an estimate,
 * using the rough latencies in tests/mock_gas.js (COST).
 *
 * Usage: node tests/load_test.js [students] [path/to/Code.gs]
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const STUDENTS = Number(process.argv[2] || 60);
const CODE = process.argv[3] || path.join(__dirname, '..', 'src', 'Code.gs');
const DAY = '2026-09-22';

const ctx = { console, Intl, Date, Math, JSON, btoa, atob, String, Number, Array, Object, isFinite, isNaN, parseInt, Infinity, Buffer };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'mock_gas.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(CODE, 'utf8'), ctx);
vm.runInContext(`__setupSheets('${DAY}')`, ctx);

// A term's worth of history already in the sheet, because the duplicate check reads it back
const sheet = ctx.__gas.sheets.Sheet2;
const HISTORY = 4000;
for (let i = 0; i < HISTORY; i++) {
  const r = new Array(23).fill('');
  r[0] = 'seed'; r[4] = 'GPS_PING_2MIN'; r[22] = 'old-' + i;
  sheet.raw.push(r); sheet.shown.push(r.map(String));
}

const photo = 'data:image/jpeg;base64,' + Buffer.alloc(150 * 1024, 7).toString('base64');
function events(n, withPhoto) {
  const t = Date.now() - 60000;   // records queued a moment ago, as in a real rush
  const out = [{ eventId: 'e' + n + '-in', eventType: 'SIGN_IN', section: 'BSCS-A', rollNo: String(100 + n), name: 'S' + n,
                 lat: 31.47, lng: 74.409, distanceMeters: 8, accuracy: 12, deviceId: 'D' + n, deviceTs: t, appVersion: 2 },
               { eventId: 'e' + n + '-p1', eventType: 'GPS_PING_2MIN', section: 'BSCS-A', rollNo: String(100 + n), name: 'S' + n,
                 lat: 31.47, lng: 74.409, distanceMeters: 8, accuracy: 12, deviceId: 'D' + n, deviceTs: t + 600000, appVersion: 2 }];
  if (withPhoto) out.push({ eventId: 'e' + n + '-ph', eventType: 'PHOTO_UPLOAD', section: 'BSCS-A', rollNo: String(100 + n),
                            name: 'S' + n, lat: 31.47, lng: 74.409, distanceMeters: 8, deviceId: 'D' + n, deviceTs: t + 30000,
                            appVersion: 2, imageBase64: photo });
  return out;
}

const meter = ctx.__meterReset();
ctx.__run = (evs) => vm.runInContext('recordAttendanceBatch(__evs)', Object.assign(ctx, { __evs: evs }));

let busy = 0, rows0 = sheet.raw.length;
for (let i = 0; i < STUDENTS; i++) {
  // text records in one call, then the photo in its own call, as the phone sends them
  for (const batch of [events(i, false), [events(i, true)[2]]]) {
    ctx.__evs = batch;
    const res = vm.runInContext('recordAttendanceBatch(__evs)', ctx);
    if (res.busy) busy++;
  }
}

const rows = sheet.raw.length - rows0;
const perStudent = meter.total / STUDENTS;
const round = (n) => Math.round(n * 10) / 10;

console.log(`\n${STUDENTS} students, ${rows} rows written, ${busy} busy replies`);
console.log('operations:', meter.ops);
console.log('cells read/written:', meter.cells);
console.log(`\nestimated server work:      ${round(meter.total)} s total, ${round(perStudent * 1000) / 1000} s per student`);
console.log(`estimated time under lock:  ${round(meter.inLock)} s   <- this is serialized: nobody else can write during it`);
console.log(`so one minute of lock time serves about ${Math.floor(60 / (meter.inLock / STUDENTS))} students`);
