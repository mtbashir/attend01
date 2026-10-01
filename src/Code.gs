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
 * One app for every class. Everything that differs between classes lives in the
 * Roster tab, not in this code: the timetable, the classroom location and radius,
 * when sign-in opens, when check-out appears and the early-leaver rule.
 *
 * Columns A to R of the log are the original layout. Added after them:
 *   S Session No, T GPS Accuracy (m), U Upload Delay (mins), V Clock Check, W Event ID,
 *   X Checked Out, Y Last Seen In Class, Z Early Leaver, AA Shared Device
 * X to AA are filled in on sign-in rows by updateFlags() once a class has ended.
 */

var CONFIG = {
  ROSTER_SHEET: 'Roster',
  // One tab per class per day. {date} is yyyy-MM-dd, {section} the class.
  //   '{date} {section}'  ->  "2026-09-30 BSCS-A"   (a tab per class)
  //   '{date}'            ->  "2026-09-30"          (a tab per day, all classes together)
  LOG_SHEET_PATTERN: '{date} {section}',
  LEGACY_LOG_SHEET: 'Sheet2',   // rows written before this change: still read, never added to
  PHOTO_FOLDER: 'Classroom Attendance Photos',
  PHOTO_PUBLIC_LINK: false,     // true = anyone with the link can open student photos (old behaviour)
  DEFAULT_RULES: [5, 7, 15],    // minutes after start: fined after 5, late after 7, absent after 15

  // Used only where the Roster cell is blank. "Add the new Roster columns" in the
  // Attendance menu writes these into the sheet, so they can be changed there.
  DEFAULT_RADIUS_M: 100,        // classroom radius
  DEFAULT_OPENS_MIN: 30,        // sign-in opens this many minutes before the start
  DEFAULT_CHECKOUT_MIN: 10,     // the Check out button appears this many minutes before the end
  DEFAULT_EARLY_MIN: 30,        // no location in this many last minutes of class = early leaver
  CHECKOUT_GRACE_MIN: 30,       // check-out is still accepted this long after the end
  FLAG_DELAY_MIN: 15,           // flags are worked out this long after a class ends, so late uploads count
  FLAG_DAYS_BACK: 2,            // updateFlags() revisits today and yesterday, for phones that upload late
  GPS_TOLERANCE_MAX: 30,        // metres of reported GPS error forgiven at the edge of the area
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
  'Session No', 'GPS Accuracy (m)', 'Upload Delay (mins)', 'Clock Check', 'Event ID',
  'Checked Out', 'Last Seen In Class', 'Early Leaver', 'Shared Device'
];
var FIRST_NEW_COL = 19;               // S
var COL_EVENT_ID = 23;                // W
var COL_FLAGS = 24;                   // X: first of the four flag columns
var ROSTER_CACHE_KEY = 'att_roster_v3';

/**
 * Optional Roster columns, found by their header wherever they are, so adding
 * them never shifts columns A to M. Column D (unused) can hold Class Name too.
 */
var ROSTER_EXTRAS = [
  { key: 'className',   header: 'Class Name',                                test: /class|course/i },
  { key: 'lat',         header: 'Latitude',                                  test: /^lat(itude)?\b/i },
  { key: 'lng',         header: 'Longitude',                                 test: /^(longitude|long|lon|lng)\b/i },
  { key: 'radius',      header: 'Radius (m)',                                test: /radius/i },
  { key: 'checkoutMin', header: 'Check-out Opens (min before end)',          test: /check.?out/i },
  { key: 'earlyMin',    header: 'Early Leaver if Not Seen (min before end)', test: /early|leaver/i },
  { key: 'opensMin',    header: 'Sign-in Opens (min before start)',          test: /sign.?in.*open|open.*before.*start/i }
];
var EXTRA_DEFAULTS = { radius: 'DEFAULT_RADIUS_M', opensMin: 'DEFAULT_OPENS_MIN', checkoutMin: 'DEFAULT_CHECKOUT_MIN', earlyMin: 'DEFAULT_EARLY_MIN' };
var SEEN_TYPES = { SIGN_IN: 1, GPS_PING_2MIN: 1, CHECK_OUT: 1, PHOTO_UPLOAD: 1 };


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
    timetable: roster.timetable,        // each session carries its own location and windows
    classNames: roster.classNames,      // { 'section in lower case': 'Class Name' }
    totalStudents: roster.students.length,
    defaultRules: CONFIG.DEFAULT_RULES,
    checkoutGraceMin: CONFIG.CHECKOUT_GRACE_MIN,
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

  var p = parseRoster_();
  var body = { students: p.students, timetable: p.timetable, sectionNames: p.sectionNames, classNames: p.classNames };
  body.version = hash_(JSON.stringify(body) + '|' + CONFIG.DEFAULT_RULES.join(',') + '|' + CONFIG.CHECKOUT_GRACE_MIN);
  try {
    cache.put(ROSTER_CACHE_KEY, JSON.stringify(body), CONFIG.ROSTER_CACHE_SECONDS);
  } catch (e) { /* roster too large for the cache (>100 KB): read the sheet each time */ }
  return body;
}

/**
 * Reads the Roster tab. Every column is found by its header, so columns can be added,
 * moved or reordered (the live Roster has Class/Course inserted at E). Headers it knows:
 *   Section (twice: the one before Session No is the student's, the one after it the session's),
 *   Student Roll No, Student Name, Class Name / Class/Course, Session No, Day, Session Dates,
 *   Start Time, End Time, Fine / Late / Absent if Delay by Min (or one Rules column),
 *   Latitude / LAT, Longitude / LONG, Radius, Sign-in Opens, Check-out Opens, Early Leaver.
 * If the headers cannot be recognised, columns A to M are read by position, as before:
 *   A Section, B Roll No, C Student Name, D (unused), E Session No, F Day, G Date, H Section,
 *   I Start Time, J End Time, K-M rules (fined / late / absent minutes)
 * Also returns the problems it noticed, for checkRoster().
 */
function parseRoster_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var sheet = ss.getSheetByName(CONFIG.ROSTER_SHEET);
  var out = { students: [], timetable: [], sectionNames: {}, classNames: {}, issues: [], missing: [], hasSheet: !!sheet };
  if (!sheet || sheet.getLastRow() < 1) return out;

  var numCols = Math.max(13, sheet.getLastColumn());
  var range = sheet.getRange(1, 1, sheet.getLastRow(), numCols);
  var raw = range.getValues();
  var shown = range.getDisplayValues();   // time cells come back as "9:00", not as an 1899 Date

  var layout = rosterColumns_(shown[0]);
  var col = layout.col;
  out.byPosition = layout.byPosition;
  if (layout.byPosition) {
    out.issues.push('The Roster headers were not recognised (looked for: ' + layout.notFound.join(', ') +
                    '), so columns A to M are read by position. Check that row 1 has the column names.');
  }
  ROSTER_EXTRAS.forEach(function (x) { if (col[x.key] === undefined) out.missing.push(x.header); });
  var cell = function (i, key) { return col[key] === undefined ? '' : text_(shown[i][col[key]]); };
  var num = function (i, key) {
    var s = cell(i, key);
    if (!s) return null;
    var n = Number(String(s).replace(/,/g, ''));
    return isFinite(n) ? n : NaN;
  };
  var orDefault = function (n, key) { return (n === null || isNaN(n)) ? CONFIG[EXTRA_DEFAULTS[key]] : n; };
  var letter = function (key) { return col[key] === undefined ? '?' : colLetter_(col[key] + 1); };
  var rulesCols = layout.rules;   // three columns: fined, late, absent (or one Rules column and the two after it)

  for (var i = 1; i < raw.length; i++) {
    var rowNo = i + 1;
    var section = cell(i, 'section');
    var roll = cell(i, 'roll');
    var name = cell(i, 'name');
    if (roll && name) out.students.push([roll, name, section]);

    var sessionNo = cell(i, 'sessionNo');
    var className = cell(i, 'className');
    if (!sessionNo) {
      if (className && section) out.classNames[section.toLowerCase()] = className;
      continue;
    }

    var ruleText = rulesCols.map(function (c) { return text_(shown[i][c]); }).join(',');
    var t = {
      sessionNo: sessionNo,
      day: cell(i, 'day'),
      date: col.date === undefined ? '' : dateKey_(raw[i][col.date], shown[i][col.date], tz),
      section: cell(i, 'sessionSection'),
      startTime: clock_(cell(i, 'start')),
      endTime: clock_(cell(i, 'end')),
      // rules in one cell ("5,10,20") or in three columns; blank = defaults
      rules: rules_(ruleText),
      lat: num(i, 'lat'),
      lng: num(i, 'lng'),
      radius: orDefault(num(i, 'radius'), 'radius'),
      opensMin: orDefault(num(i, 'opensMin'), 'opensMin'),
      checkoutMin: orDefault(num(i, 'checkoutMin'), 'checkoutMin'),
      earlyMin: orDefault(num(i, 'earlyMin'), 'earlyMin')
    };
    if (className && t.section) out.classNames[t.section.toLowerCase()] = className;

    var where = 'Roster row ' + rowNo + ' (session ' + sessionNo + (t.section ? ', ' + t.section : '') + ')';
    if (!t.section) out.issues.push(where + ': no section in column ' + letter('sessionSection') + '.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) out.issues.push(where + ': the date "' + cell(i, 'date') + '" in column ' + letter('date') + ' cannot be read.');
    if (!t.startTime) out.issues.push(where + ': the start time "' + cell(i, 'start') + '" in column ' + letter('start') + ' cannot be read. Write it like 18:30.');
    if (!t.endTime) out.issues.push(where + ': the end time "' + cell(i, 'end') + '" in column ' + letter('end') + ' cannot be read. Without it there is no check-out and no early-leaver check.');
    if (t.startTime && t.endTime && minutes_(t.endTime) <= minutes_(t.startTime)) out.issues.push(where + ': the class ends before it starts.');
    if (ruleText.replace(/,/g, '').trim() && !t.rules) {
      out.issues.push(where + ': the fined / late / absent minutes must be three numbers, smallest first. The defaults ' + CONFIG.DEFAULT_RULES.join(', ') + ' are used.');
    }
    if (t.lat === null || t.lng === null) out.issues.push(where + ': no classroom Latitude / Longitude, so nobody can sign in to it.');
    else if (isNaN(t.lat) || isNaN(t.lng) || Math.abs(t.lat) > 90 || Math.abs(t.lng) > 180) out.issues.push(where + ': the Latitude / Longitude cannot be read.');
    if (isNaN(t.lat)) t.lat = null;
    if (isNaN(t.lng)) t.lng = null;
    out.timetable.push(t);
  }

  out.students.forEach(function (st) { if (st[2]) out.sectionNames[st[2].toLowerCase()] = st[2]; });
  out.timetable.forEach(function (t) { if (t.section) out.sectionNames[t.section.toLowerCase()] = t.section; });
  return out;
}

/**
 * Which column holds what, from the Roster's header row. The first matching rule wins for a
 * header, so "Late if Delay by Min" is never taken for Latitude, nor "Session Dates" for Session No.
 */
var ROSTER_HEADER_RULES = [
  { key: 'checkoutMin', test: /check.?out/i },
  { key: 'earlyMin',    test: /early|leaver/i },
  { key: 'opensMin',    test: /sign.?in.*open|open.*before.*start/i },
  { key: 'className',   test: /class|course/i },
  { key: 'roll',        test: /roll/i },
  { key: 'name',        test: /name/i },
  { key: 'sessionNo',   test: /session\s*(no|num|#)|^session$/i },
  { key: 'date',        test: /date/i },
  { key: 'day',         test: /^day\b|weekday/i },
  { key: 'start',       test: /start/i },
  { key: 'end',         test: /^end\b|end\s*time|finish/i },
  { key: 'fine',        test: /fine/i },
  { key: 'late',        test: /^late\b|late\s*if/i },
  { key: 'absent',      test: /absent/i },
  { key: 'rules',       test: /rule/i },
  { key: 'lat',         test: /^lat(itude)?\b/i },
  { key: 'lng',         test: /^(longitude|long|lon|lng)\b/i },
  { key: 'radius',      test: /radius/i },
  { key: 'section',     test: /section/i }
];
var ROSTER_REQUIRED = ['roll', 'name', 'sessionNo', 'date', 'start'];
var ROSTER_BY_POSITION = { section: 0, roll: 1, name: 2, sessionNo: 4, day: 5, date: 6, sessionSection: 7, start: 8, end: 9 };

function rosterColumns_(headerRow) {
  var col = {}, sections = [];
  for (var c = 0; c < headerRow.length; c++) {
    var h = text_(headerRow[c]);
    if (!h) continue;
    for (var k = 0; k < ROSTER_HEADER_RULES.length; k++) {
      var rule = ROSTER_HEADER_RULES[k];
      if (!rule.test.test(h)) continue;
      if (rule.key === 'section') sections.push(c);
      else if (col[rule.key] === undefined) col[rule.key] = c;
      break;
    }
  }
  var notFound = ROSTER_REQUIRED.filter(function (k) { return col[k] === undefined; });

  if (notFound.length) {
    // Old layout without recognisable headers: A to M by position; only the optional extras by header,
    // and never from a column the positions already use (D, unused, may hold Class Name).
    var pos = {};
    for (var key in ROSTER_BY_POSITION) pos[key] = ROSTER_BY_POSITION[key];
    ROSTER_EXTRAS.forEach(function (x) {
      var c2 = col[x.key];
      if (c2 !== undefined && (c2 === 3 || c2 >= 13)) pos[x.key] = c2;
    });
    return { col: pos, rules: [10, 11, 12], byPosition: true, notFound: notFound };
  }

  // Two "Section" columns: the student's comes before Session No, the session's after it
  var before = sections.filter(function (c) { return c < col.sessionNo; });
  var after = sections.filter(function (c) { return c > col.sessionNo; });
  col.section = before.length ? before[0] : sections[0];
  col.sessionSection = after.length ? after[0] : col.section;

  var rules;
  if (col.fine !== undefined && col.late !== undefined && col.absent !== undefined) rules = [col.fine, col.late, col.absent];
  else if (col.rules !== undefined) rules = [col.rules, col.rules + 1, col.rules + 2].filter(function (c) {
    return c === col.rules || (c < headerRow.length && !text_(headerRow[c]));   // a lone Rules column may spill into blank-headed ones
  });
  else rules = [];
  return { col: col, rules: rules, byPosition: false, notFound: [] };
}

/** 1 -> A, 27 -> AA */
function colLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
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

  var dateKey = Utilities.formatDate(when, tz, 'yyyy-MM-dd');
  var pick = pickSession_(timetable, ev.section, dateKey, minutes_(Utilities.formatDate(when, tz, 'HH:mm')));

  var st = { diffText: '', onTime: '', fined: '', late: '', absent: '', sessionNo: '' };
  if (type === 'SIGN_IN') st = evaluateStatus_(pick, minutes_(Utilities.formatDate(when, tz, 'HH:mm')));
  else if (type === 'AUTO_LOGOUT_ABSENT') st.absent = 'Absent';

  // The distance is worked out here from the session's classroom, not taken from the phone
  var dist = num_(ev.distanceMeters);
  var lat = num_(ev.lat), lng = num_(ev.lng);
  if (pick && pick.s.lat !== null && pick.s.lng !== null && lat !== '' && lng !== '') {
    dist = distanceM_(lat, lng, pick.s.lat, pick.s.lng);
  }

  return [
    new Date(now),                                   // A Server Sync Time
    Utilities.formatDate(when, tz, 'yyyy-MM-dd'),    // B Device Date
    Utilities.formatDate(when, tz, 'EEEE'),          // C Device Day
    Utilities.formatDate(when, tz, 'HH:mm:ss'),      // D Device Time
    cell_(type, 40),                                 // E Event Type
    cell_(ev.rollNo, 60),                            // F Roll No
    cell_(ev.section, 60),                           // G Section
    cell_(ev.name, 120),                             // H Student Name
    lat,                                             // I Latitude
    lng,                                             // J Longitude
    dist,                                            // K Distance (m)
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
    id,                                              // W Event ID
    '', '', '', ''                                   // X-AA flags, filled in by updateFlags()
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

var NO_SESSION = 'No session found';

/**
 * A sign-in with no session in the Roster for that class and day is recorded as
 * "No session found", never as On Time, so a Roster mistake shows up in the sheet.
 */
function evaluateStatus_(pick, nowMin) {
  var r = { diffText: '', onTime: '', fined: '', late: '', absent: '', sessionNo: '' };
  if (!pick) { r.diffText = NO_SESSION; return r; }

  var s = pick.s;
  var rules = s.rules || CONFIG.DEFAULT_RULES;
  var diff = nowMin - minutes_(s.startTime);
  r.sessionNo = s.sessionNo;
  r.diffText = (diff > 0 ? '+' : '') + diff + ' mins';
  // the phone refuses these; one can still arrive from a phone with an old timetable
  if (!pick.inWindow) r.diffText += diff < 0 ? ' (before sign-in opened)' : ' (after class ended)';

  if (diff <= rules[0]) r.onTime = 'On Time';
  else if (diff <= rules[1]) r.fined = 'Fined';
  else if (diff <= rules[2]) { r.late = 'Late'; r.fined = 'Fined'; }
  else r.absent = 'Absent';
  return r;
}

/** Minutes of the day when sign-in opens and when the session ends (start + 24 h if no end time). */
function windowOf_(s) {
  var start = minutes_(s.startTime), end = minutes_(s.endTime);
  var opens = isFinite(s.opensMin) ? s.opensMin : CONFIG.DEFAULT_OPENS_MIN;
  return { open: start - opens, start: start, end: end, close: end !== null ? end : start + 24 * 60 };
}

/**
 * The session an event belongs to: one whose sign-in window (opening time to end) holds
 * the event, else the closest start that day. Several in the window: the closest start.
 * Returns { s, inWindow } or null when the class has no session that day.
 */
function pickSession_(timetable, section, dateKey, nowMin) {
  var want = text_(section).toLowerCase();
  var best = null, bestGap = Infinity, bestIn = false;
  for (var i = 0; i < timetable.length; i++) {
    var s = timetable[i];
    if (s.date !== dateKey || s.section.toLowerCase() !== want) continue;
    var w = windowOf_(s);
    if (w.start === null) continue;
    var inside = nowMin >= w.open && nowMin <= w.close;
    var gap = Math.abs(nowMin - w.start);
    if ((inside && !bestIn) || (inside === bestIn && gap < bestGap)) { best = s; bestGap = gap; bestIn = inside; }
  }
  return best ? { s: best, inWindow: bestIn } : null;
}

/** Metres between two points. */
function distanceM_(lat1, lng1, lat2, lng2) {
  var R = 6371000, toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad, dLon = (lng2 - lng1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
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

  var out = { date: day, section: text_(section), students: [], counts: { signedIn: 0, onTime: 0, fined: 0, late: 0, absent: 0, noSession: 0 }, serverTs: Date.now() };
  var byRoll = {};

  // That day's own tabs hold only that day, so they are read whole.
  // Display values: Sheets turns "2026-09-30" and "18:45:00" into a date and a time when they are written.
  var sheets = logSheetsFor_(ss, day, text_(section));
  sheets.forEach(function (sheet) {
    var last = sheet.getLastRow();
    if (last < 2) return;
    var vals = sheet.getRange(2, 2, Math.min(last - 1, CONFIG.SUMMARY_MAX_ROWS), 17).getDisplayValues();   // B..R
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
      var chunk = legacy.getRange(start, 2, end - start + 1, 17).getDisplayValues();
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
    else if (st[4] === 'No session') out.counts.noSession++;
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
    var d = dayText_(r[0]);                                // B Device Date
    if (!d) continue;
    if (d < day) return true;
    if (d > day || text_(r[3]) !== 'SIGN_IN') continue;    // E Event Type
    var rollNo = text_(r[4]), rowSec = text_(r[5]);        // F Roll No, G Section
    if (sec && rowSec.toLowerCase() !== sec) continue;
    // scanning upwards, so a later assignment is an earlier sign-in: the first of the day wins.
    // Roll no and name together: two students sharing a roll no are still two students.
    byRoll[studentKey_(rollNo, r[6])] = [text_(r[2]), rollNo, text_(r[6]), rowSec,
                                    r[16] ? 'Absent' : r[15] ? 'Late' : r[14] ? 'Fined' :
                                    text_(r[12]) === NO_SESSION ? 'No session' : 'On Time'];
  }
  return false;
}

/* ================================================================
   After class: check-out, early leavers, shared phones
   ================================================================ */

/**
 * Fills X to AA on each sign-in row once its class has ended (plus FLAG_DELAY_MIN):
 *   X Checked Out         "Yes 20:25" or "No"
 *   Y Last Seen In Class  last time the phone reported a location inside the classroom area
 *   Z Early Leaver        "Yes" when the student was not seen inside in the last N minutes
 *                         (Roster column "Early Leaver if Not Seen"); blank for absentees
 *   AA Shared Device      "Yes: N students" when one phone signed in several students that day
 * Runs every 15 minutes once "Update flags automatically" is chosen in the Attendance menu,
 * and looks back FLAG_DAYS_BACK days, so records uploaded late still count. Safe to run any time.
 */
function updateFlags() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var timetable = loadRoster_().timetable;
  var now = Date.now();
  var today = Utilities.formatDate(new Date(now), tz, 'yyyy-MM-dd');
  var nowMin = minutes_(Utilities.formatDate(new Date(now), tz, 'HH:mm'));

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return 'The sheet is busy with uploads. Nothing changed; try again in a minute.';
  var written = 0, tabsDone = 0;
  try {
    for (var d = 0; d < CONFIG.FLAG_DAYS_BACK; d++) {
      var day = Utilities.formatDate(new Date(now - d * 86400000), tz, 'yyyy-MM-dd');
      var tabs = logSheetsFor_(ss, day, '').map(function (sheet) {
        ensureHeaders_(sheet);
        var last = sheet.getLastRow();
        return { sheet: sheet, vals: last < 2 ? [] : sheet.getRange(2, 1, last - 1, HEADERS.length).getDisplayValues() };
      });

      // which students each phone signed in that day, across every class
      var byDevice = {};
      tabs.forEach(function (t) {
        t.vals.forEach(function (r) {
          var dev = text_(r[12]);
          if (text_(r[4]) !== 'SIGN_IN' || !dev) return;
          (byDevice[dev] = byDevice[dev] || {})[studentKey_(r[5], r[7])] = 1;
        });
      });

      tabs.forEach(function (t) {
        if (!t.vals.length) return;
        var flags = flagsFor_(t.vals, timetable, day, day === today ? nowMin : 24 * 60 + CONFIG.FLAG_DELAY_MIN, byDevice);
        if (!flags.changed) return;
        t.sheet.getRange(2, COL_FLAGS, flags.rows.length, 4).setValues(flags.rows);
        written += flags.changed; tabsDone++;
      });
    }
  } finally {
    lock.releaseLock();
  }
  return 'Updated ' + written + ' sign-in row(s) in ' + tabsDone + ' tab(s).';
}

/** Works out X to AA for one tab's rows (display values, columns A..AA). */
function flagsFor_(vals, timetable, day, nowMin, byDevice) {
  var events = {};   // student -> [{ t, type, dist, acc }]
  vals.forEach(function (r) {
    var t = timeMin_(r[3]);
    if (t === null) return;
    (events[studentKey_(r[5], r[7])] = events[studentKey_(r[5], r[7])] || []).push({
      t: t, type: text_(r[4]), dist: Number(r[10]), acc: Number(r[19]) || 0
    });
  });

  var firstSignIn = {}, changed = 0;
  var rows = vals.map(function (r) {
    var keep = [r[23], r[24], r[25], r[26]];
    if (text_(r[4]) !== 'SIGN_IN') return keep;
    var who = studentKey_(r[5], r[7]);
    var sessionNo = text_(r[18]);
    var seenKey = who + '#' + sessionNo;
    if (firstSignIn[seenKey]) return keep;              // a repeat sign-in: the first one carries the flags
    firstSignIn[seenKey] = true;

    var devs = byDevice[text_(r[12])];
    var n = devs ? Object.keys(devs).length : 0;
    var shared = n > 1 ? 'Yes: ' + n + ' students' : '';

    var s = null;
    for (var i = 0; i < timetable.length && sessionNo; i++) {
      var c = timetable[i];
      if (c.date === day && c.sessionNo === sessionNo && c.section.toLowerCase() === text_(r[6]).toLowerCase()) { s = c; break; }
    }
    var out = ['', '', '', shared];
    var w = s ? windowOf_(s) : null;
    if (w && w.end !== null && nowMin >= w.end + CONFIG.FLAG_DELAY_MIN) {
      var until = w.end + CONFIG.CHECKOUT_GRACE_MIN;
      var limit = (isFinite(s.radius) ? s.radius : CONFIG.DEFAULT_RADIUS_M);
      var checkout = null, lastSeen = null;
      (events[who] || []).forEach(function (e) {
        if (e.t < w.open || e.t > until || !SEEN_TYPES[e.type]) return;
        // inside the area, allowing for reported GPS error as the phone does; no location set: any report counts
        var inside = (s.lat === null || s.lng === null) ||
                     (isFinite(e.dist) && e.dist - Math.min(e.acc, CONFIG.GPS_TOLERANCE_MAX) <= limit);
        if (!inside) return;
        if (e.type === 'CHECK_OUT' && (checkout === null || e.t > checkout)) checkout = e.t;
        if (lastSeen === null || e.t > lastSeen) lastSeen = e.t;
      });
      var absent = !!text_(r[17]);
      var early = isFinite(s.earlyMin) ? s.earlyMin : CONFIG.DEFAULT_EARLY_MIN;
      out[0] = checkout !== null ? 'Yes ' + hm_(checkout) : 'No';
      out[1] = lastSeen !== null ? hm_(lastSeen) : '';
      out[2] = absent ? '' : (lastSeen === null || lastSeen < w.end - early ? 'Yes' : 'No');
    }
    if (out.join('|') !== keep.map(text_).join('|')) changed++;
    return out;
  });
  return { rows: rows, changed: changed };
}

/** Attendance menu: turns on updateFlags() every 15 minutes (once is enough; running it again does no harm). */
function installFlagTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'updateFlags') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('updateFlags').timeBased().everyMinutes(15).create();
  return 'Early-leaver and shared-phone flags will now update every 15 minutes.';
}


/* ================================================================
   Roster tools and the Attendance menu
   ================================================================ */

/**
 * Lists what is wrong with the Roster: shared roll numbers, dates and times that cannot be
 * read, sessions with no classroom location, classes with sessions but no students.
 * Returns a list of plain sentences (empty when all is well).
 */
function checkRoster() {
  var p = parseRoster_();
  if (!p.hasSheet) return ['There is no tab called "' + CONFIG.ROSTER_SHEET + '".'];
  var out = [];
  if (p.missing.length) {
    out.push('These Roster columns are missing: ' + p.missing.join(', ') + '. Use Attendance > Add the new Roster columns.');
  }

  var byRoll = {};
  p.students.forEach(function (st) {
    var k = (st[2] + '|' + st[0]).toLowerCase();
    (byRoll[k] = byRoll[k] || { roll: st[0], section: st[2], names: [] }).names.push(st[1]);
  });
  Object.keys(byRoll).forEach(function (k) {
    var g = byRoll[k];
    if (g.names.length > 1) {
      out.push('Roll no ' + g.roll + (g.section ? ' in ' + g.section : '') + ' is shared by ' + g.names.length +
               ' students (' + g.names.slice(0, 4).join(', ') + (g.names.length > 4 ? ', …' : '') +
               '). Give each student their own roll no.');
    }
  });

  out = out.concat(p.issues);

  var withStudents = {}, withSessions = {};
  p.students.forEach(function (st) { if (st[2]) withStudents[st[2].toLowerCase()] = st[2]; });
  p.timetable.forEach(function (t) { if (t.section) withSessions[t.section.toLowerCase()] = t.section; });
  Object.keys(withSessions).forEach(function (k) {
    if (!withStudents[k]) out.push('Class ' + withSessions[k] + ' has sessions but no students.');
  });
  Object.keys(withStudents).forEach(function (k) {
    if (!withSessions[k]) out.push('Class ' + withStudents[k] + ' has students but no sessions.');
  });
  return out;
}

/**
 * Adds the optional Roster columns that are missing, after the last column, and fills the
 * defaults (radius, sign-in, check-out and early-leaver minutes) into every session row
 * where they are blank. Latitude, Longitude and Class Name are left for you to fill in.
 */
function setupRosterColumns() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.ROSTER_SHEET);
  if (!sheet) return 'There is no tab called "' + CONFIG.ROSTER_SHEET + '".';
  var lastCol = Math.max(13, sheet.getLastColumn());
  var header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var col = rosterColumns_(header).col;
  var added = [];
  ROSTER_EXTRAS.forEach(function (x) {
    if (col[x.key] !== undefined) return;
    lastCol++;
    if (sheet.getMaxColumns() < lastCol) sheet.insertColumnsAfter(sheet.getMaxColumns(), lastCol - sheet.getMaxColumns());
    sheet.getRange(1, lastCol).setValue(x.header).setFontWeight('bold');
    col[x.key] = lastCol - 1;
    added.push(x.header);
  });

  var filled = 0, last = sheet.getLastRow();
  if (last > 1) {
    var sessions = sheet.getRange(2, col.sessionNo + 1, last - 1, 1).getDisplayValues();   // Session No
    Object.keys(EXTRA_DEFAULTS).forEach(function (key) {
      var rng = sheet.getRange(2, col[key] + 1, last - 1, 1);
      var vals = rng.getDisplayValues(), change = false;
      for (var i = 0; i < vals.length; i++) {
        if (text_(sessions[i][0]) && !text_(vals[i][0])) { vals[i][0] = CONFIG[EXTRA_DEFAULTS[key]]; change = true; filled++; }
      }
      if (change) rng.setValues(vals);
    });
  }
  clearRosterCache();
  return (added.length ? 'Added: ' + added.join(', ') + '. ' : 'All the columns were already there. ') +
         (filled ? 'Filled ' + filled + ' blank setting(s) with the defaults. ' : '') +
         'Now fill in Latitude and Longitude for every session (and Class Name if you like).';
}

/** Adds the Attendance menu to the spreadsheet. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Attendance')
    .addItem('Check the Roster', 'menuCheckRoster')
    .addItem('Add the new Roster columns', 'menuSetupRoster')
    .addSeparator()
    .addItem('Update early-leaver and shared-phone flags now', 'menuUpdateFlags')
    .addItem('Update flags automatically every 15 min', 'menuInstallFlagTrigger')
    .addSeparator()
    .addItem('Send Roster changes to phones now', 'menuClearRosterCache')
    .addToUi();
}

function menuCheckRoster() {
  var problems = checkRoster();
  SpreadsheetApp.getUi().alert(problems.length
    ? 'Roster: ' + problems.length + ' thing(s) to fix\n\n• ' + problems.slice(0, 30).join('\n• ') +
      (problems.length > 30 ? '\n… and ' + (problems.length - 30) + ' more.' : '')
    : 'The Roster looks fine.');
}
function menuSetupRoster() { SpreadsheetApp.getUi().alert(setupRosterColumns()); }
function menuUpdateFlags() { SpreadsheetApp.getUi().alert(updateFlags()); }
function menuInstallFlagTrigger() { SpreadsheetApp.getUi().alert(installFlagTrigger()); }
function menuClearRosterCache() { clearRosterCache(); SpreadsheetApp.getUi().alert('Phones will get the Roster the next time they open the page with signal.'); }


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
    var cols = sheet.getMaxColumns();   // a new tab has 26 columns; the log needs more
    if (cols < HEADERS.length) sheet.insertColumnsAfter(cols, HEADERS.length - cols);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    CacheService.getScriptCache().put(HEADER_CACHE_PREFIX + name, '1', 21600);
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

var HEADER_CACHE_PREFIX = 'att_hdr3_';   // new prefix: tabs made by the previous version still need X to AA

function ensureHeaders_(sheet, name) {
  var cache = CacheService.getScriptCache();
  var key = HEADER_CACHE_PREFIX + (name || sheet.getName());
  if (cache.get(key)) return;

  var maxCols = sheet.getMaxColumns();
  if (maxCols < HEADERS.length) sheet.insertColumnsAfter(maxCols, HEADERS.length - maxCols);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else if (!(sheet.getRange(1, 1).getValue() instanceof Date)) {   // row 1 is a header row
    // fill in any of the added headers that are still blank, leaving the rest alone
    var extra = sheet.getRange(1, FIRST_NEW_COL, 1, HEADERS.length - FIRST_NEW_COL + 1);
    var have = extra.getValues()[0], changed = false;
    var want = HEADERS.slice(FIRST_NEW_COL - 1).map(function (h, i) {
      if (text_(have[i])) return have[i];
      changed = true;
      return h;
    });
    if (changed) extra.setValues([want]).setFontWeight('bold');
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

/** One student, even when two share a roll no. */
function studentKey_(roll, name) {
  return (text_(roll) + '|' + text_(name)).toLowerCase();
}

/** A date cell as yyyy-MM-dd, whether Sheets kept it as text or turned it into a date. */
function dayText_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz || Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = text_(v);
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return m[1] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);   // the US-style display some spreadsheets use
  if (m) return m[3] + '-' + pad2_(+m[1]) + '-' + pad2_(+m[2]);
  return s;
}

/** "18:45:03", "6:45:03 PM" -> minutes of the day, or null */
function timeMin_(v) {
  return minutes_(clock_(text_(v)));
}

function hm_(mins) {
  return pad2_(Math.floor(mins / 60)) + ':' + pad2_(mins % 60);
}

function hash_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 12);
}