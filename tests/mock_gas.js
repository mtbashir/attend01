// Minimal Apps Script mocks, enough to run Code.gs
(function (G) {
  var TZ = 'Asia/Karachi';

  function fmt(d, tz, pattern) {
    var parts = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long', hourCycle: 'h23' })
      .formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
    return pattern.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
      .replace('EEEE', parts.weekday).replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
  }

  function Sheet(name, raw, shown) {
    this.name = name; this.raw = raw; this.shown = shown || raw.map(function (r) { return r.map(String); });
    this.maxCols = 26; this.frozen = 0; this.getRangeCalls = 0;
  }
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.getLastRow = function () { charge('sheetMeta', COST.call); return this.raw.length; };
  Sheet.prototype.getLastColumn = function () { return this.raw.reduce(function (m, r) { return Math.max(m, r.length); }, 0); };
  Sheet.prototype.getMaxColumns = function () { return this.maxCols; };
  Sheet.prototype.insertColumnsAfter = function (a, n) { this.maxCols += n; };
  Sheet.prototype.setFrozenRows = function (n) { this.frozen = n; };
  Sheet.prototype.setFrozenColumns = function (n) { this.frozenCols = n; };
  Sheet.prototype.getMaxRows = function () { return Math.max(1000, this.raw.length); };
  Sheet.prototype.insertRowsAfter = function () {};
  Sheet.prototype.clear = function () { this.raw.length = 0; this.shown.length = 0; this.bg = null; };
  Sheet.prototype.getRange = function (r, c, nr, nc) {
    var sh = this; nr = nr || 1; nc = nc || 1; sh.getRangeCalls++;
    if (c + nc - 1 > sh.maxCols) throw new Error('Range out of bounds');
    function grid(src, blank) {
      var out = [];
      for (var i = 0; i < nr; i++) {
        var row = [];
        for (var j = 0; j < nc; j++) {
          var v = src[r - 1 + i] ? src[r - 1 + i][c - 1 + j] : undefined;
          row.push(v === undefined ? blank : v);
        }
        out.push(row);
      }
      return out;
    }
    var rng = {
      getValues: function () { charge('sheetRead', COST.call + nr * nc * COST.cell, nr * nc); return grid(sh.raw, ''); },
      getDisplayValues: function () { charge('sheetRead', COST.call + nr * nc * COST.cell, nr * nc); return grid(sh.shown, ''); },
      getValue: function () { charge('sheetRead', COST.call + COST.cell, 1); return grid(sh.raw, '')[0][0]; },
      setValues: function (vals) {
        charge('sheetWrite', COST.call + nr * nc * COST.cell, nr * nc);
        if (vals.length !== nr || vals[0].length !== nc) throw new Error('setValues size mismatch');
        for (var i = 0; i < nr; i++) {
          sh.raw[r - 1 + i] = sh.raw[r - 1 + i] || [];
          sh.shown[r - 1 + i] = sh.shown[r - 1 + i] || [];
          for (var j = 0; j < nc; j++) { sh.raw[r - 1 + i][c - 1 + j] = vals[i][j]; sh.shown[r - 1 + i][c - 1 + j] = String(vals[i][j]); }
        }
        return rng;
      },
      setValue: function (v) { return rng.setValues([[v]]); },
      setBackgrounds: function (b) { sh.bg = b; return rng; },
      setFontWeight: function () { return rng; }
    };
    return rng;
  };

  // Rough Apps Script latencies (seconds), used to estimate how long a class rush takes.
  var COST = { call: 0.08, cell: 0.00004, flush: 0.15, drive: 1.2, cache: 0.02, cacheMany: 0.05, lock: 0.05, exec: 0.40 };
  function charge(kind, seconds, cells) {
    var m = G.__gas.meter;
    if (!m) return;
    m.total += seconds;
    if (G.__gas.lockHeld) m.inLock += seconds;
    m.ops[kind] = (m.ops[kind] || 0) + 1;
    if (cells) m.cells[kind] = (m.cells[kind] || 0) + cells;
  }
  /** Every logged row across the day tabs (and the old single tab), for tests. */
  G.__logRows = function () {
    var out = [];
    sheetOrder.forEach(function (n) {
      if (n === 'Roster' || !sheets[n]) return;
      sheets[n].raw.forEach(function (r, i) { if (i > 0 && r && r.length) out.push(r); });
    });
    return out;
  };
  G.__meterReset = function () { G.__gas.meter = { total: 0, inLock: 0, ops: {}, cells: {} }; return G.__gas.meter; };

  var sheets = {};
  var cacheStore = {};
  var props = {};
  var files = [];

  G.__gas = { sheets: sheets, cache: cacheStore, files: files, lockHeld: false, meter: null, COST: COST };

  var sheetOrder = [];
  G.SpreadsheetApp = {
    getActiveSpreadsheet: function () {
      return {
        getSheetByName: function (n) { return sheets[n] || null; },
        getSheets: function () { return sheetOrder.map(function (n) { return sheets[n]; }).filter(Boolean); },
        getNumSheets: function () { return sheetOrder.length; },
        insertSheet: function (name, index) {
          charge('sheetWrite', COST.call);
          if (sheets[name]) throw new Error('A sheet with the name "' + name + '" already exists.');
          var sh = new Sheet(name, [], []);
          sheets[name] = sh;
          sheetOrder.splice(index === undefined ? sheetOrder.length : index, 0, name);
          return sh;
        },
        getSpreadsheetTimeZone: function () { return TZ; }
      };
    },
    getActive: function () { return G.SpreadsheetApp.getActiveSpreadsheet(); },
    flush: function () { charge('flush', COST.flush); }
  };
  G.Session = { getScriptTimeZone: function () { return TZ; } };
  G.CacheService = { getScriptCache: function () {
    return {
      get: function (k) { charge('cache', COST.cache); return cacheStore.hasOwnProperty(k) ? cacheStore[k] : null; },
      put: function (k, v) { charge('cache', COST.cache); if (String(v).length > 100000) throw new Error('Argument too large'); cacheStore[k] = String(v); },
      getAll: function (keys) {
        charge('cacheMany', COST.cacheMany);
        if (keys.length > 1000) throw new Error('Too many keys');
        var out = {};
        keys.forEach(function (k) { if (cacheStore.hasOwnProperty(k)) out[k] = cacheStore[k]; });
        return out;
      },
      putAll: function (map) {
        charge('cacheMany', COST.cacheMany);
        var keys = Object.keys(map);
        if (keys.length > 1000) throw new Error('Too many keys');
        keys.forEach(function (k) { cacheStore[k] = String(map[k]); });
      },
      remove: function (k) { delete cacheStore[k]; }
    };
  } };
  G.LockService = { getScriptLock: function () {
    return {
      waitLock: function () { charge('lock', COST.lock); if (G.__gas.lockHeld) throw new Error('Lock timeout'); G.__gas.lockHeld = true; },
      tryLock: function () { charge('lock', COST.lock); if (G.__gas.lockHeld) return false; G.__gas.lockHeld = true; return true; },
      hasLock: function () { return !!G.__gas.lockHeld; },
      releaseLock: function () { G.__gas.lockHeld = false; }
    };
  } };
  G.PropertiesService = { getScriptProperties: function () {
    return { getProperty: function (k) { return props[k] || null; }, setProperty: function (k, v) { props[k] = v; } };
  } };
  var folder = {
    getId: function () { return 'FOLDER1'; }, isTrashed: function () { return false; },
    createFile: function (blob) {
      charge('drive', COST.drive);
      var f = { name: blob.name, bytes: blob.bytes.length, getUrl: function () { return 'https://drive.mock/' + blob.name; },
        setSharing: function () { f.shared = true; } };
      files.push(f); return f;
    }
  };
  G.DriveApp = {
    getFolderById: function () { return folder; },
    getFoldersByName: function () { var used = false; return { hasNext: function () { return !used; }, next: function () { used = true; return folder; } }; },
    createFolder: function () { return folder; },
    Access: { ANYONE_WITH_LINK: 1 }, Permission: { VIEW: 1 }
  };
  G.Utilities = {
    formatDate: fmt,
    getUuid: function () { return 'u' + Math.random().toString(36).slice(2); },
    DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
    computeDigest: function (alg, s) {
      var h = 2166136261, out = [];
      for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      for (var k = 0; k < 16; k++) { out.push((h >>> ((k % 4) * 8)) & 255); h = Math.imul(h ^ k, 16777619) >>> 0; }
      return out;
    },
    base64EncodeWebSafe: function (bytes) {
      return btoa(String.fromCharCode.apply(null, bytes.map(function (b) { return b & 255; }))).replace(/\+/g, '-').replace(/\//g, '_');
    },
    base64Decode: function (b64) { var s = atob(b64); var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i)); return a; },
    newBlob: function (bytes, type, name) { return { bytes: bytes, type: type, name: name }; }
  };
  G.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: function (text) {
      var o = { mime: 'text/plain', getContent: function () { return text; }, setMimeType: function (m) { o.mime = m; return o; } };
      return o;
    }
  };
  G.HtmlService = { createHtmlOutputFromFile: function () { var o = { setTitle: function () { return o; }, addMetaTag: function () { return o; }, setXFrameOptionsMode: function () { return o; } }; return o; },
    XFrameOptionsMode: { ALLOWALL: 1 } };

  // ---- Test roster: time cells come back from getValues() as 1899 Dates, as in real Sheets ----
  G.__setupSheets = function (todayKey) {
    var t1899 = function (h, m) { return new Date(Date.UTC(1899, 11, 30, h - 5, m - 28)); };  // deliberately odd, like real LMT offsets
    var today = new Date(todayKey + 'T00:00:00+05:00');
    var raw = [
      ['Section', 'Roll No', 'Name', '', 'Session', 'Day', 'Date', 'Section', 'Start', 'End', 'Rules'],
      ['BSCS-A', '101', 'Ayesha Khan', '', 1, 'Tuesday', today, 'BSCS-A', t1899(9, 0), t1899(10, 30), ''],
      ['BSCS-A', '102', 'Bilal Ahmed', '', 2, 'Tuesday', today, 'BSCS-A', t1899(14, 0), t1899(15, 0), '5/7/15'],
      ['BSCS-B', '201', 'Hira Malik', '', 3, 'Tuesday', today, 'BSCS-B', t1899(11, 0), t1899(12, 0), 5, 10, 20],
      ['BSCS-B', '202', '=HYPERLINK("x")', '', '', '', '', '', '', '', '']
    ];
    var shown = [
      raw[0],
      ['BSCS-A', '101', 'Ayesha Khan', '', '1', 'Tuesday', todayKey, 'BSCS-A', '9:00 AM', '10:30 AM', ''],
      ['BSCS-A', '102', 'Bilal Ahmed', '', '2', 'Tuesday', todayKey, 'BSCS-A', '14:00:00', '15:00:00', '5/7/15'],
      ['BSCS-B', '201', 'Hira Malik', '', '3', 'Tuesday', todayKey, 'BSCS-B', '18:30 PM', '20:30 PM', '5', '10', '20'],
      ['BSCS-B', '202', '=HYPERLINK("x")', '', '', '', '', '', '', '', '']
    ];
    for (var name in sheets) delete sheets[name];
    sheetOrder.length = 0;
    sheets.Roster = new Sheet('Roster', raw, shown);
    sheetOrder.push('Roster');
    var hdr = ['Server Sync Time','Device Date','Device Day','Device Time','Event Type','Roll No','Section','Student Name','Latitude','Longitude','Distance (m)','Photo Drive Link','Device ID','Late vs Schedule (Mins)','On Time','Fined','Late','Absent'];
    sheets.Sheet2 = new Sheet('Sheet2', [hdr.slice()], [hdr.slice()]);   // the old single tab, kept for the transition
    sheetOrder.push('Sheet2');
    for (var k in cacheStore) delete cacheStore[k];
  };
})(typeof window !== 'undefined' ? window : globalThis);
