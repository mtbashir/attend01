/**
 * Class Sign-In: server side (Google Apps Script)
 *
 * Built for phones that are offline most of the time:
 *  - The page keeps every event in a local queue and uploads them in batches
 *    whenever it gets a signal (recordAttendanceBatch).
 *  - Every event carries a unique eventId, so a retry after a dropped
 *    connection never creates a duplicate row.
 *  - The roster is cached here and only re-sent to a phone when it changes.
 *  - The page can be served by Apps Script (google.script.run) or hosted
 *    elsewhere, e.g. GitHub Pages, and reach this script through doGet/doPost.
 *
 * Columns A to R in Sheet2 are unchanged. Five columns are added after them:
 *   S Session No, T GPS Accuracy (m), U Upload Delay (mins), V Clock Check, W Event ID
 */

var CONFIG = {
  ROSTER_SHEET: 'Roster',
  // One tab per class per day. {date} is yyyy-MM-dd, {section} the class.
  //   '{date} {section}'  ->  "2026-09-30 BSCS-A"   (a tab per class)
  //   '{date}'            ->  "2026-09-30"          (a tab per day, all classes together)
  LOG_SHEET_PATTERN: '{date} {section}',
  LEGACY_LOG_SHEET: 'Sheet2',   // rows written before this change: still read, never added to
  PHOTO_FOLDER: 'FAST Attendance Photos',
  PHOTO_PUBLIC_LINK: false,     // true = anyone with the link can open student photos (old behaviour)
  DEFAULT_RULES: [5, 7, 15],    // minutes after start: fined after 5, late after 7, absent after 15
  ROSTER_CACHE_SECONDS: 300,    // roster edits reach phones within 5 min (instantly when edited by hand, see onEdit)
  DEDUP_LOOKBACK_ROWS: 2000,      // only read when a phone says it is retrying
  DEDUP_CACHE_SECONDS: 21600,     // remember written event ids for 6 hours
  BUSY_RETRY_MS: 15000,           // told to the phone when the sheet is busy
  SUMMARY_CACHE_SECONDS: 30,      // today's class summary is built at most twice a minute
  SUMMARY_MAX_ROWS: 6000,         // how far back a summary looks for today's rows    // how far back to look for an already-recorded eventId
  LOCK_WAIT_MS: 10000,
  CLOCK_TOLERANCE_MIN: 3        // flag phones whose clock is off by this many minutes or more
};

var HEADERS = [
  'Server Sync Time', 'Device Date', 'Device Day', 'Device Time', 'Event Type',
  'Roll No', 'Section', 'Student Name', 'Latitude', 'Longitude', 'Distance (m)',
  'Photo Drive Link', 'Device ID', 'Late vs Schedule (Mins)', 'On Time', 'Fined',
  'Late', 'Absent',
  'Session No', 'GPS Accuracy (m)', 'Upload Delay (mins)', 'Clock Check', 'Event ID'
];
var FIRST_NEW_COL = 19;               // S
var COL_EVENT_ID = HEADERS.length;    // W
var ROSTER_CACHE_KEY = 'att_roster_v2';


/* ================================================================
   Web app
   ================================================================ */

/**
 * Opened in a browser with no parameters: serves the sign-in page.
 * With ?action=...: answers as a JSON API, used when the page is hosted
 * somewhere else (GitHub Pages) and has no google.script.run.
 *   ?action=ping              -> quick check that the link works
 *   ?action=roster&v=VERSION  -> same reply as getRosterData(VERSION)
 */
function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action) {
    if (action === 'ping') return json_({ ok: true, result: { serverTs: Date.now() } });
    if (action === 'roster') return api_(function () { return getRosterData(e.parameter.v || 'none'); });
    if (action === 'summary') return api_(function () { return getDaySummary(e.parameter.section, e.parameter.date); });
    return json_({ ok: false, error: 'Unknown action: ' + action });
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Class Sign-In')
    // HtmlService ignores <meta name="viewport"> inside the file; it must be added here
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * JSON API for pages hosted outside Apps Script. The page sends the body as
 * text/plain (a "simple" request), because Apps Script cannot answer the
 * CORS preflight that application/json would trigger.
 *   { "action": "record", "events": [ ... ] }  -> same reply as recordAttendanceBatch
 *   { "action": "roster", "v": "VERSION" }      -> same reply as getRosterData
 */
function doPost(e) {
  return api_(function () {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'record') return recordAttendanceBatch(body.events || []);
    if (body.action === 'roster') return getRosterData(body.v || 'none');
    if (body.action === 'summary') return getDaySummary(body.section, body.date);
    throw new Error('Unknown action: ' + body.action);
  });
}

function api_(fn) {
  try {
    return json_({ ok: true, result: fn() });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


/* ================================================================
   Roster and timetable
   ================================================================ */

/**
 * @param {string=} clientVersion  version the phone already has. If it matches,
 *   only a tiny "notModified" reply is sent back.
 */
function getRosterData(clientVersion) {
  var roster = loadRoster_();
  var now = Date.now();

  if (clientVersion && clientVersion === roster.version) {
    return { notModified: true, version: roster.version, serverTs: now };
  }

  var res = {
    version: roster.version,
    students: roster.students,          // [[rollNo, name, section], ...]
    timetable: roster.timetable,
    totalStudents: roster.students.length,
    defaultRules: CONFIG.DEFAULT_RULES,
    serverTs: now
  };

  // A page opened before this update may still be running: give it the fields it expects.
  if (clientVersion === undefined || clientVersion === null) {
    var sections = {}, rolls = {}, names = {};
    roster.students.forEach(function (s) {
      rolls[s[0]] = 1; names[s[1]] = 1;
      if (s[2]) sections[s[2]] = 1;
    });
    res.sections = Object.keys(sections);
    res.rollNos = Object.keys(rolls);
    res.names = Object.keys(names);
  }
  return res;
}

function loadRoster_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(ROSTER_CACHE_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* rebuild below */ }
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var sheet = ss.getSheetByName(CONFIG.ROSTER_SHEET);
  var students = [];
  var timetable = [];

  if (sheet && sheet.getLastRow() > 1) {
    var numCols = Math.max(3, Math.min(13, sheet.getLastColumn()));   // A:M
    var range = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols);
    var raw = range.getValues();
    var shown = range.getDisplayValues();   // time cells come back as "9:00", not as an 1899 Date

    for (var i = 0; i < raw.length; i++) {
      var section = text_(shown[i][0]);
      var roll = text_(shown[i][1]);
      var name = text_(shown[i][2]);
      if (roll && name) students.push([roll, name, section]);

      var sessionNo = text_(shown[i][4]);
      if (sessionNo) {
        timetable.push({
          sessionNo: sessionNo,
          day: text_(shown[i][5]),
          date: dateKey_(raw[i][6], shown[i][6], tz),
          section: text_(shown[i][7]),
          startTime: clock_(shown[i][8]),
          endTime: clock_(shown[i][9]),
          // rules in one cell ("5,10,20") or in three columns K, L and M
          rules: rules_([shown[i][10], shown[i][11], shown[i][12]].join(','))      // optional "5,7,15" in column K; blank = defaults
        });
      }
    }
  }

  var sectionNames = {};
  students.forEach(function (st) { if (st[2]) sectionNames[st[2].toLowerCase()] = st[2]; });
  timetable.forEach(function (t) { if (t.section) sectionNames[t.section.toLowerCase()] = t.section; });

  var body = { students: students, timetable: timetable, sectionNames: sectionNames };
  body.version = hash_(JSON.stringify(body) + '|' + CONFIG.DEFAULT_RULES.join(','));
  try {
    cache.put(ROSTER_CACHE_KEY, JSON.stringify(body), CONFIG.ROSTER_CACHE_SECONDS);
  } catch (e) { /* roster too large for the cache (>100 KB): read the sheet each time */ }
  return body;
}

/** Run this by hand after bulk-editing the Roster if you want phones to see it immediately. */
function clearRosterCache() {
  CacheService.getScriptCache().remove('att_next_row');
  CacheService.getScriptCache().remove(ROSTER_CACHE_KEY);
}

/** Simple trigger: editing the Roster tab by hand clears the cache straight away. */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var edited = e.range.getSheet().getName();
    if (edited === CONFIG.ROSTER_SHEET) clearRosterCache();
    if (edited !== CONFIG.ROSTER_SHEET) clearRowCounter(edited);   // rows added or deleted by hand
  } catch (err) { /* never block an edit */ }
}


/* ================================================================
   Recording events
   ================================================================ */

/**
 * Receives a batch of queued events from one phone.
 * Returns { results: { eventId: 'ok' | 'dup' | 'error: ...' }, serverTs, fatal? }
 * 'ok' and 'dup' both mean "safe to delete from the phone's queue".
 */
function recordAttendanceBatch(events) {
  var out = { results: {}, serverTs: Date.now() };
  if (!events || !events.length) return out;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var timetable = loadRoster_().timetable;
  var seen = seenIds_(ss, events, tz);

  // Everything slow happens here, before the lock: photos to Drive, times, rules.
  // Each record is sorted into the tab for its own class and day.
  var groups = {}, order = [];
  events.forEach(function (ev) {
    if (!ev) return;
    var id = text_(ev.eventId) || ('srv-' + Utilities.getUuid());
    ev.eventId = id;
    if (seen[id]) { out.results[id] = 'dup'; return; }
    try {
      var row = buildRow_(ev, id, timetable, tz);
      row[6] = canonicalSection_(row[6]) || row[6];  // G Section, as the Roster spells it
      var name = logSheetName_(row[1], row[6]);      // B Device Date, G Section
      if (!groups[name]) { groups[name] = []; order.push(name); }
      groups[name].push({ id: id, row: row });
    } catch (err) {
      out.results[id] = 'error: ' + (err && err.message ? err.message : err);
    }
  });

  // read before the lock, so the lock is held for the writes alone
  var lastSeen = {};
  order.forEach(function (name) {
    var existing = ss.getSheetByName(name);
    lastSeen[name] = existing ? existing.getLastRow() : 0;
  });

  if (order.length) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
      // Everyone is uploading at once. Say so instead of failing: the phone waits and retries,
      // and any photo already sent to Drive is reused rather than uploaded again.
      out.busy = true;
      out.retryAfterMs = CONFIG.BUSY_RETRY_MS;
      return out;
    }

    var written = [];
    try {
      order.forEach(function (name) {
        try {
          var sheet = logSheet_(ss, name);          // created the first time this class meets
          var rows = groups[name].map(function (p) { return p.row; });
          var at = nextRow_(sheet, name, lastSeen[name]);
          sheet.getRange(at.row, 1, rows.length, HEADERS.length).setValues(rows);
          if (at.fromSheet) SpreadsheetApp.flush(); // no row counter yet: make the write visible to the next writer
          setNextRow_(name, at.row + rows.length);
          groups[name].forEach(function (p) { out.results[p.id] = 'ok'; written.push(p.id); });
        } catch (err) {
          // One class's tab could not be written: say nothing about those records, so the phone
          // keeps them and tries again. Records for other classes in the same batch still count.
          out.tabError = "Could not write to '" + name + "': " + (err && err.message ? err.message : err);
        }
      });
    } finally {
      lock.releaseLock();
    }
    rememberIds_(written);   // outside the lock: the rows are already placed
  }

  out.serverTs = Date.now();
  return out;
}

/**
 * Which event ids are already in the sheet.
 *
 * Written ids are kept in the script cache, so the normal case costs one cache read and
 * no reading of the sheet. The cache can be dropped by Google at any time, so the sheet is
 * still read when a phone says it is resending something (ev.retry) or when an event is
 * older than the cache keeps ids for. Those are the only cases where a duplicate could slip in.
 */
function seenIds_(ss, events, tz) {
  var cache = CacheService.getScriptCache();
  var seen = {}, keys = [], byKey = {}, scanNames = {};
  var oldest = Date.now() - (CONFIG.DEDUP_CACHE_SECONDS - 900) * 1000;

  events.forEach(function (ev) {
    var id = ev && text_(ev.eventId);
    if (!id) return;
    var k = 'att_id_' + id;
    keys.push(k); byKey[k] = id;
    if (ev.retry || !(Number(ev.deviceTs) > oldest)) {
      var day = Utilities.formatDate(new Date(eventTime_(ev)), tz, 'yyyy-MM-dd');
      scanNames[logSheetName_(day, ev.section)] = true;      // only that class's own tab
    }
  });

  for (var i = 0; i < keys.length; i += 400) {
    var hit = cache.getAll(keys.slice(i, i + 400));
    for (var k in hit) { if (byKey[k]) seen[byKey[k]] = true; }
  }

  var names = Object.keys(scanNames);
  if (names.length) {
    if (CONFIG.LEGACY_LOG_SHEET) names.push(CONFIG.LEGACY_LOG_SHEET);   // records queued before the split
    names.forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh) return;
      var fromSheet = recentEventIds_(sh);
      for (var id in fromSheet) seen[id] = true;
    });
  }
  return seen;
}

function rememberIds_(ids) {
  if (!ids.length) return;
  var cache = CacheService.getScriptCache();
  for (var i = 0; i < ids.length; i += 400) {
    var map = {};
    ids.slice(i, i + 400).forEach(function (id) { map['att_id_' + id] = '1'; });
    cache.putAll(map, CONFIG.DEDUP_CACHE_SECONDS);
  }
}

/**
 * Where the next rows go. A counter in the cache avoids asking the sheet (and waiting for
 * the previous writer's rows to appear) on every upload. Without it, fall back to the sheet.
 */
/**
 * Where the next rows go.
 * lastSeen is the sheet's last row, read before taking the lock. It is only a lower bound,
 * because other uploads may have added rows since, so the counter wins whenever it is ahead.
 * If the counter is missing or behind (rows pasted in by hand), ask the sheet again and flush.
 */
function nextRow_(sheet, name, lastSeen) {
  var cached = Number(CacheService.getScriptCache().get('att_next_row_' + name));
  if (cached >= (lastSeen || 0) + 1) return { row: cached, fromSheet: false };
  return { row: sheet.getLastRow() + 1, fromSheet: true };
}

function setNextRow_(name, row) {
  CacheService.getScriptCache().put('att_next_row_' + name, String(row), CONFIG.DEDUP_CACHE_SECONDS);
}

/** Called when rows are added or removed by hand, so the row counter is not left behind. */
function clearRowCounter(name) {
  if (name) CacheService.getScriptCache().remove('att_next_row_' + name);
}

/** Kept so a page opened before this update can still upload its queue. */
function recordAttendance(payload) {
  var res = recordAttendanceBatch([payload]);
  if (res.fatal) return 'ERROR: ' + res.fatal;
  var r = res.results[payload.eventId];
  return (r === 'ok' || r === 'dup') ? 'SUCCESS' : 'ERROR: ' + r;
}

function buildRow_(ev, id, timetable, tz) {
  var now = Date.now();
  var ts = eventTime_(ev);
  var when = new Date(ts);
  var type = text_(ev.eventType);

  var photo = type === 'PHOTO_UPLOAD' ? 'PROCESSING' : 'NO_PHOTO';
  if (ev.imageBase64) photo = savePhoto_(ev, ts);

  var st = { diffText: '', onTime: '', fined: '', late: '', absent: '', sessionNo: '' };
  if (type === 'SIGN_IN') st = evaluateStatus_(ev.section, ts, timetable, tz);
  else if (type === 'AUTO_LOGOUT_ABSENT') st.absent = 'Absent';

  return [
    new Date(now),                                   // A Server Sync Time
    Utilities.formatDate(when, tz, 'yyyy-MM-dd'),    // B Device Date
    Utilities.formatDate(when, tz, 'EEEE'),          // C Device Day
    Utilities.formatDate(when, tz, 'HH:mm:ss'),      // D Device Time
    cell_(type, 40),                                 // E Event Type
    cell_(ev.rollNo, 60),                            // F Roll No
    cell_(ev.section, 60),                           // G Section
    cell_(ev.name, 120),                             // H Student Name
    num_(ev.lat),                                    // I Latitude
    num_(ev.lng),                                    // J Longitude
    num_(ev.distanceMeters),                         // K Distance (m)
    photo,                                           // L Photo Drive Link
    cell_(ev.deviceId, 80),                          // M Device ID
    st.diffText,                                     // N Late vs Schedule (Mins)
    st.onTime,                                       // O On Time
    st.fined,                                        // P Fined
    st.late,                                         // Q Late
    st.absent,                                       // R Absent
    st.sessionNo,                                    // S Session No
    num_(ev.accuracy),                               // T GPS Accuracy (m)
    Math.max(0, Math.round((now - ts) / 60000)),     // U Upload Delay (mins)
    clockCheck_(ev, ts, now),                        // V Clock Check
    id                                               // W Event ID
  ];
}

/** Time the event happened on the phone (epoch ms). Accepts the old locale-string format too. */
function eventTime_(ev) {
  var t = Number(ev.deviceTs);
  if (t > 0 && isFinite(t)) return t;
  var d = new Date(ev.deviceTime);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

/** Offline sign-ins rely on the phone's clock, so record how trustworthy it was. */
function clockCheck_(ev, ts, now) {
  if (ev.timeGuessed) return 'Time estimated (queued by old app version)';
  if (!(Number(ev.deviceTs) > 0)) return 'Old app version';
  if (ts > now + 5 * 60000) return 'Device time is in the future';
  if (ev.skewMs === null || ev.skewMs === undefined || !isFinite(Number(ev.skewMs))) return 'Not checked';
  var mins = Math.round(Number(ev.skewMs) / 60000);
  if (Math.abs(mins) < CONFIG.CLOCK_TOLERANCE_MIN) return 'OK';
  return 'Device clock ' + (mins > 0 ? 'ahead' : 'behind') + ' by ' + Math.abs(mins) + ' min';
}


/* ================================================================
   Schedule evaluation (same rules as evaluateLocal() in Index.html)
   ================================================================ */

function evaluateStatus_(section, ts, timetable, tz) {
  var r = { diffText: '', onTime: '', fined: '', late: '', absent: '', sessionNo: '' };
  var when = new Date(ts);
  var dateKey = Utilities.formatDate(when, tz, 'yyyy-MM-dd');
  var nowMin = minutes_(Utilities.formatDate(when, tz, 'HH:mm'));

  var s = pickSession_(timetable, section, dateKey, nowMin);
  if (!s) { r.onTime = 'On Time'; return r; }

  var rules = s.rules || CONFIG.DEFAULT_RULES;
  var diff = nowMin - minutes_(s.startTime);
  r.sessionNo = s.sessionNo;
  r.diffText = (diff > 0 ? '+' : '') + diff + ' mins';

  if (diff <= rules[0]) r.onTime = 'On Time';
  else if (diff <= rules[1]) r.fined = 'Fined';
  else if (diff <= rules[2]) { r.late = 'Late'; r.fined = 'Fined'; }
  else r.absent = 'Absent';
  return r;
}

/** When a section has more than one session in a day, use the one whose start is closest. */
function pickSession_(timetable, section, dateKey, nowMin) {
  var want = text_(section).toLowerCase();
  var best = null, bestGap = Infinity;
  for (var i = 0; i < timetable.length; i++) {
    var s = timetable[i];
    if (s.date !== dateKey || s.section.toLowerCase() !== want) continue;
    var start = minutes_(s.startTime);
    if (start === null) continue;
    var gap = Math.abs(nowMin - start);
    if (gap < bestGap) { best = s; bestGap = gap; }
  }
  return best;
}


/**
 * One-off: copies rows from the old single tab into a tab per class per day.
 * Run it by hand from the editor. It copies and never deletes, and running it twice
 * changes nothing, so the old tab stays as it is until you remove it yourself.
 * Returns a short summary of what it did.
 */
function splitLegacyLog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var legacy = CONFIG.LEGACY_LOG_SHEET ? ss.getSheetByName(CONFIG.LEGACY_LOG_SHEET) : null;
  if (!legacy) return 'No tab named ' + CONFIG.LEGACY_LOG_SHEET + ' to split.';
  var last = legacy.getLastRow();
  if (last < 2) return 'Nothing to split.';

  var vals = legacy.getRange(2, 1, last - 1, Math.max(1, Math.min(HEADERS.length, legacy.getLastColumn()))).getValues();
  var groups = {}, order = [];
  vals.forEach(function (r) {
    if (!r || !text_(r[1])) return;                         // B Device Date
    var row = r.slice();
    while (row.length < HEADERS.length) row.push('');
    row[6] = canonicalSection_(row[6]) || row[6];
    var name = logSheetName_(row[1], row[6]);
    if (!groups[name]) { groups[name] = []; order.push(name); }
    groups[name].push(row);
  });

  var moved = 0, skipped = 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_WAIT_MS);
  try {
    order.forEach(function (name) {
      var sheet = logSheet_(ss, name);
      var have = {};
      var end = sheet.getLastRow();
      if (end > 1) {
        sheet.getRange(2, 1, end - 1, HEADERS.length).getValues().forEach(function (r) { have[rowKey_(r)] = true; });
      }
      var add = groups[name].filter(function (r) {
        if (have[rowKey_(r)]) { skipped++; return false; }
        have[rowKey_(r)] = true;
        return true;
      });
      if (!add.length) return;
      sheet.getRange(sheet.getLastRow() + 1, 1, add.length, HEADERS.length).setValues(add);
      moved += add.length;
      clearRowCounter(name);
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return 'Copied ' + moved + ' row(s) into ' + order.length + ' tab(s); ' + skipped + ' were already there. ' +
         'The ' + CONFIG.LEGACY_LOG_SHEET + ' tab was left untouched.';
}

/** Identifies a row whether or not it has an event id, so a second run copies nothing twice. */
function rowKey_(r) {
  return text_(r[22]) || [text_(r[1]), text_(r[3]), text_(r[4]), text_(r[5]), text_(r[6])].join('|');
}

/* ================================================================
   Today's class summary
   ================================================================ */

/**
 * Today's sign-ins for a whole class, so every phone shows the same picture.
 * Only SIGN_IN rows count, one per student (the earliest of the day).
 * The answer is cached for a minute: a class all asking at once causes one read, not sixty.
 *
 * Returns { date, section, students: [[time, rollNo, name, section, status], ...],
 *           counts: { signedIn, onTime, fined, late, absent }, serverTs }
 */
function getDaySummary(section, date) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var day = text_(date) || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var sec = text_(section).toLowerCase();
  var cache = CacheService.getScriptCache();
  var key = 'att_sum_' + day + '|' + sec;

  var hit = cache.get(key);
  if (hit) {
    var cached = JSON.parse(hit);
    cached.serverTs = Date.now();
    return cached;
  }

  var out = { date: day, section: text_(section), students: [], counts: { signedIn: 0, onTime: 0, fined: 0, late: 0, absent: 0 }, serverTs: Date.now() };
  var byRoll = {};

  // That day's own tabs hold only that day, so they are read whole.
  var sheets = logSheetsFor_(ss, day, text_(section));
  sheets.forEach(function (sheet) {
    var last = sheet.getLastRow();
    if (last < 2) return;
    var vals = sheet.getRange(2, 2, Math.min(last - 1, CONFIG.SUMMARY_MAX_ROWS), 17).getValues();   // B..R
    collectSignIns_(vals, day, sec, byRoll);
  });

  // Anything recorded before the split still lives in the old single tab.
  var legacy = CONFIG.LEGACY_LOG_SHEET ? ss.getSheetByName(CONFIG.LEGACY_LOG_SHEET) : null;
  if (legacy) {
    var last2 = legacy.getLastRow();
    var CHUNK = 500, scanned = 0, stop = false;
    // rows there are in time order, so read from the bottom and stop once the day changes
    for (var end = last2; end >= 2 && scanned < CONFIG.SUMMARY_MAX_ROWS && !stop; end -= CHUNK) {
      var start = Math.max(2, end - CHUNK + 1);
      var chunk = legacy.getRange(start, 2, end - start + 1, 17).getValues();
      scanned += chunk.length;
      stop = collectSignIns_(chunk, day, sec, byRoll);
    }
  }

  for (var k in byRoll) out.students.push(byRoll[k]);
  out.students.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  out.students.forEach(function (st) {
    out.counts.signedIn++;
    if (st[4] === 'Absent') out.counts.absent++;
    else if (st[4] === 'Late') { out.counts.late++; out.counts.fined++; }
    else if (st[4] === 'Fined') out.counts.fined++;
    else out.counts.onTime++;
  });

  cache.put(key, JSON.stringify(out), CONFIG.SUMMARY_CACHE_SECONDS);
  return out;
}

/**
 * Picks that day's sign-ins out of rows of columns B..R, keeping the earliest per student.
 * Returns true when rows older than the day were reached.
 */
function collectSignIns_(vals, day, sec, byRoll) {
  for (var i = vals.length - 1; i >= 0; i--) {
    var r = vals[i];
    var d = text_(r[0]);                                   // B Device Date
    if (!d) continue;
    if (d < day) return true;
    if (d > day || text_(r[3]) !== 'SIGN_IN') continue;    // E Event Type
    var rollNo = text_(r[4]), rowSec = text_(r[5]);        // F Roll No, G Section
    if (sec && rowSec.toLowerCase() !== sec) continue;
    // scanning upwards, so a later assignment is an earlier sign-in: the first of the day wins
    byRoll[rollNo.toLowerCase()] = [text_(r[2]), rollNo, text_(r[6]), rowSec,
                                    r[16] ? 'Absent' : r[15] ? 'Late' : r[14] ? 'Fined' : 'On Time'];
  }
  return false;
}

/* ================================================================
   Sheet and Drive helpers
   ================================================================ */

/**
 * The class name as the Roster spells it. Phones send whatever was typed, and
 * "BSCS-A" and "bscs-a" must not end up as two tabs for the same class.
 */
function canonicalSection_(section) {
  var s = text_(section);
  if (!s) return s;
  var names = loadRoster_().sectionNames || {};
  return names[s.toLowerCase()] || s;
}

/** Tab name for a record, from its own date and class. */
function logSheetName_(date, section) {
  var name = String(CONFIG.LOG_SHEET_PATTERN)
    .replace('{date}', text_(date) || 'undated')
    .replace('{section}', canonicalSection_(section) || 'no section');
  return name.replace(/[\[\]\*\?:\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 95);
}

/** The tab for this name, created with headers the first time that class meets. */
function logSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name, ss.getNumSheets());
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    CacheService.getScriptCache().put('att_headers_' + name, '1', 21600);
  } else {
    ensureHeaders_(sheet, name);
  }
  return sheet;
}

/** Existing tabs holding records for a date: one class, or every class that day. */
function logSheetsFor_(ss, date, section) {
  if (section) {
    var one = ss.getSheetByName(logSheetName_(date, section));
    if (one) return [one];
  }
  var parts = logSheetName_(date, '\u0000').split('\u0000');   // the name with a hole where the class goes
  var out = [];
  ss.getSheets().forEach(function (sh) {
    var n = sh.getName();
    var match = parts.length === 1 ? n === parts[0]
      : n.length >= parts[0].length + parts[1].length && n.indexOf(parts[0]) === 0 && n.slice(n.length - parts[1].length) === parts[1];
    if (match) out.push(sh);
  });
  return out;
}

function ensureHeaders_(sheet, name) {
  var cache = CacheService.getScriptCache();
  var key = 'att_headers_' + (name || sheet.getName());
  if (cache.get(key)) return;

  var maxCols = sheet.getMaxColumns();
  if (maxCols < HEADERS.length) sheet.insertColumnsAfter(maxCols, HEADERS.length - maxCols);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else if (!(sheet.getRange(1, 1).getValue() instanceof Date)) {   // row 1 is a header row
    var extra = sheet.getRange(1, FIRST_NEW_COL, 1, HEADERS.length - FIRST_NEW_COL + 1);
    if (extra.getValues()[0].join('') === '') {
      extra.setValues([HEADERS.slice(FIRST_NEW_COL - 1)]).setFontWeight('bold');
    }
  }
  cache.put(key, '1', 21600);
}

function recentEventIds_(sheet) {
  var ids = {};
  var last = sheet.getLastRow();
  if (last < 2) return ids;
  var n = Math.min(CONFIG.DEDUP_LOOKBACK_ROWS, last - 1);
  var vals = sheet.getRange(last - n + 1, COL_EVENT_ID, n, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][0]) ids[String(vals[i][0])] = true;
  }
  return ids;
}

function savePhoto_(ev, ts) {
  // A retry after a lost reply (or a busy sheet) must not create a second file in Drive.
  var cache = CacheService.getScriptCache();
  var key = 'att_ph_' + text_(ev.eventId);
  var already = ev.eventId ? cache.get(key) : null;
  if (already) return already;

  var folder = photoFolder_();
  var fileName = text_(ev.section).replace(/[^a-zA-Z0-9]/g, '') + '_' +
                 text_(ev.rollNo).replace(/[^a-zA-Z0-9-]/g, '') + '_' + ts + '.jpg';
  var b64 = String(ev.imageBase64);
  var comma = b64.indexOf(',');
  if (comma >= 0) b64 = b64.slice(comma + 1);

  var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', fileName));
  if (CONFIG.PHOTO_PUBLIC_LINK) {
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) { /* Workspace domains may forbid public links; keep the photo private */ }
  }
  var url = file.getUrl();
  if (ev.eventId) cache.put(key, url, CONFIG.DEDUP_CACHE_SECONDS);
  return url;
}

/** Remembers the folder id so Drive isn't searched by name on every photo. */
function photoFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try {
      var f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* folder deleted: find or create again */ }
  }
  var it = DriveApp.getFoldersByName(CONFIG.PHOTO_FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.PHOTO_FOLDER);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}


/* ================================================================
   Small utilities
   ================================================================ */

function text_(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

/** Text for a cell. Values starting with = + - @ are stored as text, not run as formulas. */
function cell_(v, max) {
  var s = text_(v);
  if (max) s = s.slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function num_(v) {
  if (v === '' || v === null || v === undefined) return '';
  var n = Number(v);
  return isFinite(n) ? n : '';
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** "9:00", "09:00:00", "9:00 AM", "2.30 pm" -> "HH:mm" ('' if unreadable) */
function clock_(s) {
  var m = text_(s).match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\.?$/i);
  if (!m) return '';
  var h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (m[3] && h <= 12) {
    var pm = m[3].toLowerCase() === 'p';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  // "18:30 PM" is already a 24-hour time: the PM is ignored rather than throwing the time away
  if (h > 23 || min > 59) return '';
  return pad2_(h) + ':' + pad2_(min);
}

function minutes_(hhmm) {
  var m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function dateKey_(raw, shown, tz) {
  if (raw instanceof Date) return Utilities.formatDate(raw, tz, 'yyyy-MM-dd');
  return text_(shown);
}

/** Column K: three numbers such as "5,7,15" or "5/7/15"; anything else uses DEFAULT_RULES. */
function rules_(v) {
  var n = text_(v).match(/\d+(?:\.\d+)?/g);
  if (!n || n.length < 3) return null;
  var r = [Number(n[0]), Number(n[1]), Number(n[2])];
  return (r[0] <= r[1] && r[1] <= r[2]) ? r : null;
}

function hash_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 12);
}