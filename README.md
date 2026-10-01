# Class Sign-In (offline-first student attendance)

A Google Apps Script web app that students open on their phones to sign in to class. One copy serves every class: each class's timetable, classroom location, radius and timing rules live in the Roster tab of the Google Sheet, so a new class or a changed rule never needs a code change. It is built for places with little or no mobile signal. The page can be opened from its Apps Script link or hosted on GitHub Pages. Everything is saved on the phone first and uploaded to a Google Sheet when a connection appears, without losing or duplicating records.

## How it works

The student enters a roll number. Name and section fill in from a roster saved on the phone (if two students share a roll number, the name is left for them to type). They press **Sign in**. The phone finds that class's session for today and checks:

- **Sign-in is open:** from the Roster's *Sign-in Opens* minutes before the start (30 by default) until the end of class. Outside that, the phone says when sign-in opens or that class has ended.
- **They are in that class's room:** within the Roster's *Radius* of its *Latitude* / *Longitude*. A class with no location in the Roster cannot be signed in to.

It then works out on the spot whether they are on time, fined, late or absent, and puts the record into a local queue (IndexedDB, with a localStorage fallback). The server works the status and the distance out again when the record arrives; a sign-in that matches no session is recorded as **No session found**, never as On Time.

While the session is open, the phone checks the student's location every 2 minutes. Leaving the area and coming back are recorded straight away. After 10 minutes outside, the student is signed out and counted as leaving early (GPS indoors can drift, so this never turns a student who came into an absentee).

**Check-out.** A *Check out* button appears in the last 10 minutes of class (Roster: *Check-out Opens*) and stays until 30 minutes after the end. It needs a location inside the classroom area, like sign-in. Until then the page says when check-out opens.

**Early leavers and shared phones.** Once a class has ended (plus 15 minutes for late uploads), the server fills four columns on each sign-in row: *Checked Out*, *Last Seen In Class*, *Early Leaver* (not seen inside the area in the last 30 minutes of class; Roster: *Early Leaver if Not Seen*) and *Shared Device* (one phone signed in several students that day; flagged, never blocked). A check-out counts as being seen.

A web page cannot read the location while it is closed or the screen is off. So a student who keeps the page closed and does not check out is flagged as an early leaver even if they stayed. Tell students to check out: it is what keeps them off the list.

The queue uploads whenever there is signal. Text records go first, in batches of up to 40 per call, and photos follow one per call. Each record carries a unique event ID, so if a reply is lost and the phone sends again, the server skips anything it already wrote. A record is only removed from the phone once the server confirms it.

Other ways the app keeps network use low:

- **Roster:** re-sent only when the Roster tab changes. Otherwise the server answers "not modified" in about 70 bytes.
- **Photos:** compressed on the phone to at most 800 px (an 8.5 MB test photo became about 157 KB).
- **Location checks:** only 1 in 5 in-range checks is uploaded.

## The summary at the bottom

The tiles and the list show **today's whole class**, not just the phone in your hand:

- The figures come from the sheet, so every phone shows the same picture. They are rebuilt at most twice a minute, so a class all looking at once causes two reads, not sixty.
- Only sign-in events are listed, one row per student, the first of the day. Location checks, photos and sign-outs never appear.
- Present counts students who signed in and were not marked absent. Absent is the rest of the section's roster.
- A sign-in made on this phone shows immediately, before it has reached the sheet.
- With no signal, the last figures fetched stay on screen, with this phone's own records added. The line under the heading always says where the figures came from and how old they are, for example "BSCS-A, whole class · updated 3 mins ago (offline)".

Which class it shows follows the student signed in on that phone, or the last one used on it. `SUMMARY_CACHE_SECONDS` in `Code.gs` and `SUMMARY_REFRESH_MS` in `index.html` control how fresh the figures are.

## A whole class signing in at once

Apps Script lets one script hold the write lock at a time, so whatever happens while the lock is held decides how many phones can be served per minute. Three things keep that section short:

- **Duplicate checking comes from the script cache**, not from reading the sheet. A phone marks a record as a resend when it sends it again, and only then is the sheet read.
- **Photos go to Drive before the lock is taken**, and the file's link is remembered by event id, so a resend never creates a second file.
- **The next free row is kept in the cache**, so an upload doesn't wait for the previous writer's rows to appear. The sheet's own last row is still checked, outside the lock, in case rows were added by hand.

When the sheet is busy anyway, the server replies "busy" with a wait time instead of failing. The phone keeps the records, shows that it's waiting, and tries again. Phones also spread their uploads over half a minute, so a class doesn't call the server all in the same second.

`tests/load_test.js` measures this. It counts the Sheets, Drive and Cache work an upload causes and turns it into an estimate using the latencies in `tests/mock_gas.js`:

```
npm run load          # 60 students
node tests/load_test.js 200
```

| 60 students, 2 uploads each | Before | After |
|---|---|---|
| Cells read from the sheet | 736,264 | 94 |
| Time holding the lock | 57 s | 15 s |
| Students served per minute of lock time | ~63 | ~245 |

## Files

| Path | Goes where |
|---|---|
| `src/Code.gs` | Apps Script editor, file `Code.gs` |
| `docs/index.html` | The page. GitHub Pages serves it from `docs/`. For the Apps Script link, paste it into an HTML file named `Index` |
| `docs/config.json` | The web app link, on one line. The only file to change when the link changes |
| `docs/sw.js`, `docs/manifest.webmanifest`, `docs/icon-*.png` | GitHub Pages only: keep the page on the phone so it opens with no signal, and let students add it to the home screen |
| `tests/` | Local tests with Apps Script mocks (Node.js, no dependencies) |

## Spreadsheet setup

**Roster tab**

Every column is found by its header, so columns can be inserted or moved (the live sheet has *Class/Course* at E and *LAT / LONG / Radius* at O–Q). If row 1 has no recognisable headers, columns A to M are read by position, as in this standard layout:

| Col | Content | Col | Content |
|---|---|---|---|
| A | Section | E | Session No |
| B | Roll No | F | Day |
| C | Student Name | G | Date |
| D | (unused, or Class Name) | H | Section |
| | | I | Start Time (24-hour, e.g. 18:30) |
| | | J | End Time |
| | | K, L, M | Fined / late / absent after this many minutes (e.g. 5, 10, 20), or all three in K as `5,10,20` |

Optional columns. *Class/Course*, *LAT* and *LONG* are recognised as well as the names below. **Attendance → Add the new Roster columns** adds the missing ones after the last column and fills the defaults into every session row:

| Header | Per session row | Default |
|---|---|---|
| Class Name | Name shown to students, e.g. *LUMS ECOM Sep-2026* (optional) | the section |
| Latitude, Longitude | The classroom. **Required**: a session without them cannot be signed in to | — |
| Radius (m) | How far from that point counts as in class | 100 |
| Sign-in Opens (min before start) | | 30 |
| Check-out Opens (min before end) | | 10 |
| Early Leaver if Not Seen (min before end) | | 30 |

To find a classroom's latitude and longitude: in Google Maps, press and hold on the room, and copy the two numbers shown.

Give every student their own roll number. Two students sharing one are kept apart by name, but the phone cannot fill in their name for them.

**Attendance menu** (appears when the spreadsheet is opened)

| Item | What it does |
|---|---|
| Check the Roster | Lists shared roll numbers, dates and times that cannot be read, sessions with no location, classes with sessions but no students |
| Add the new Roster columns | Adds the columns above and fills the defaults. Running it again adds nothing |
| Update early-leaver and shared-phone flags now | Fills the four flag columns for classes that have ended |
| Update flags automatically every 15 min | Turns on a timer that does the above. Do this once |
| Update the attendance register now | Rebuilds the *Attendance Register* tab (also rebuilt every 15 minutes by the timer) |
| Open the Corrections tab | Where you set a student's status by hand (see below) |
| Send Roster changes to phones now | Phones pick up Roster edits within 5 minutes anyway |

**Attendance Register tab**

One row per student in the Roster, one column per session. The three header rows give the class, the session number and the date. Each cell holds that student's status: **Present**, **Fined**, **Late** (late and fined) or **Absent**, with the reason for an absence: *Absent · 25 min late* or *Absent · no sign-in*. *· Left early* is added when the Early Leaver flag is Yes, and *· Left early (out of area 19:12)* when the page signed the student out for 10 minutes outside the area during class (counted as leaving early, not absent). Columns D to H total each student's Present, Fined, Late, Absent and Left Early.

- A session still to come is blank.
- A session of another class is grey.
- A past session nobody in the class signed in to shows **No data** (the app was not used that day) and is left out of the totals.

The tab is rebuilt from the log tabs every time, so anything typed into it is overwritten. Rows recorded before the per-class tabs, in `Sheet2`, are included, matched by name when their roll number is not the student's.

**Corrections tab**

For students who could not sign in (dead phone, location blocked, no GPS indoors) or any other status you need to set by hand. Created automatically, one row per correction:

| Date | Section | Roll No | Student Name | Session No | Status | Note |
|---|---|---|---|---|---|---|
| 22-Sep-2026 | ECOM-SEP-26 | 1 | | | Present | Phone died |

- **Status** is Present, Fined, Late or Absent (P, F, L, A also work; there is a drop-down).
- **Section** can be left blank when the roll no is unique; **Student Name** can be used instead of the roll no, with a section.
- **Session No** is only needed when a class meets twice on the same day.
- A correction replaces the app's record for that student and session, shows as e.g. *Present · corrected*, and counts in the totals. It also works on a "No data" day.
- Rows that cannot be applied (unknown roll no, no session that day, unreadable status) are listed under the register with the reason.

**One tab per class per day**

Records go into a tab named after the date and the class, for example `2026-09-30 ECOM-SEP-26`. The tab is created the first time that class meets, with the full headers: columns A–R are the original layout, then S Session No, T GPS Accuracy (m), U Upload Delay (mins), V Clock Check, W Event ID, X Checked Out, Y Last Seen In Class, Z Early Leaver, AA Shared Device. Two sessions of the same class on one day share the tab.

Change `LOG_SHEET_PATTERN` in `Code.gs` to `'{date}'` for one tab per day with every class together.

The class is named as the **Roster** spells it, so phones sending `bscs-a` and `BSCS-A` still land in the same tab.

**Rows recorded before this change** stay in `Sheet2`. They are still read, so old days still appear in the summary, and nothing new is added there. To split them into per-class tabs, run `splitLegacyLog` once from the editor: it copies rows across, never deletes, and running it twice changes nothing. The old tab is yours to remove once you are happy.

A tab per class per day adds up. A spreadsheet holds 10 million cells in total and slows down after a few hundred tabs, so move a finished term into its own spreadsheet at the end of it.

## Deploying

### 1. The script (always needed)

1. Open the attendance spreadsheet (the one with the Roster tab), then go to **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with `src/Code.gs`.
3. Replace the contents of the `Index` HTML file with `docs/index.html`.
4. Go to **Deploy → Manage deployments** and edit the web app:
   - **Execute as:** Me
   - **Who has access:** Anyone
   - **Version:** New version

   Keeping the same deployment keeps the same `/exec` link. Clicking **New deployment** instead creates a different link, which then has to go into `config.json`.
5. Reload the spreadsheet. An **Attendance** menu appears. Run **Add the new Roster columns**, fill in Latitude and Longitude, run **Check the Roster** until it is clean, then **Update flags automatically every 15 min** (Google asks for permission the first time).
6. To check the link, open `YOUR_EXEC_LINK?action=roster` in a browser. You should see your class list as JSON. If you see a Google sign-in page instead, "Who has access" is not set to **Anyone**.

### 2a. Students use the Apps Script link

Give students the `/exec` link. Nothing else is needed.

### 2b. Students use GitHub Pages

A page on GitHub cannot use `google.script.run`, so it calls the script through its `/exec` link instead.

1. Put your `/exec` link in `docs/config.json`:

   ```json
   { "apiUrl": "https://script.google.com/macros/s/AKfycb.../exec" }
   ```

   Commit and push. This is the only file to change if the link ever changes; phones pick it up on their next visit and remember it, so they keep working offline. If `config.json` is missing, the page falls back to `API_URL` at the top of `docs/index.html`.
2. On GitHub, open the `attend01` repository and go to **Settings → Pages**. Under **Deploy from a branch**, choose `main` and the `/docs` folder.
3. Give students `https://mtbashir.github.io/attend01/`, and only ever that address. It never changes, so a new `/exec` link only means editing `config.json`. After the first visit, the page opens even with no signal.

   Ask them to open it once and add it to the home screen (iPhone: Share → Add to Home Screen; Android: ⋮ → Add to Home screen). On iPhone this also stops Safari deleting their saved records after a week without use.
4. After you push a change, each phone picks it up on its second visit: the first visit loads the new copy in the background.

On a free GitHub account, Pages only works from a **public** repository. The class coordinates and the `/exec` link are then visible to anyone, though any student could already see both in the page source.

### Notes for both

Phones still running the old page keep working. Records they had queued are migrated and uploaded when they load the new version.

If you edit the Roster in bulk (for example by pasting a whole list), run `clearRosterCache` once from the editor so phones get the change immediately. Hand edits clear the cache automatically.

## The class list on a phone's first run

`docs/roster.json` holds a copy of the class list next to the page, so a phone opening it for the first time has the list even if the script is slow or unreachable. The sheet's own copy replaces it as soon as one arrives, so it only has to be roughly right.

To fill it, open `YOUR_EXEC_LINK?action=roster` in a browser, copy what you see, and paste it into `docs/roster.json`, then push. Refresh it when the class list changes a lot; day to day it does not matter, because phones take the live copy from the sheet.

## Offline: what has to be true

The page can only open without signal when it is served from GitHub Pages. The Apps Script `/exec` link is fetched from Google every time, so it can never open offline.

Three things must hold:

1. **The phone opened the page once with signal.** The first visit is what saves it.
2. **The address ends in a slash:** `https://mtbashir.github.io/attend01/`. Without the slash the browser treats it as a different place, outside what the saved copy covers, and it will not open offline. Hand out the link with the slash, or let students add it to the home screen, which always uses the right one.
3. **The saved copy has not been cleared.** iPhones delete it after 7 days without a visit, unless the page was added to the home screen.

The line at the bottom of the page says which state the phone is in: "Saved on this phone: this page opens without signal", or a warning that it is not saved yet.

To check it yourself: open the page, wait for that line to turn green, switch the phone to flight mode, and reload. The page should open and still list your students.

If you would rather not depend on the trailing slash at all, publish from a repository named `YOUR-USERNAME.github.io` instead. The app then lives at `https://YOUR-USERNAME.github.io/`, where the problem cannot arise.

## Settings

Settings are in `CONFIG` at the top of `Code.gs` and at the top of the script in `docs/index.html`.

| Setting | File | Default | Meaning |
|---|---|---|---|
| `apiUrl` | config.json | empty | The `/exec` link, used when the page is hosted outside Apps Script |
| `API_URL` | index.html | empty | Fallback link, used only if `config.json` cannot be read |
| Class location, radius, sign-in / check-out / early-leaver minutes | Roster tab | 100 m, 30, 10, 30 | Per session; see Spreadsheet setup |
| `CLASS_LAT`, `CLASS_LNG`, `MAX_RADIUS_METERS` | index.html | 0, 0, 100 | Fallback location for a session with none in the Roster. 0, 0 = none |
| `CHECKOUT_GRACE_MIN` | Code.gs | 30 | How long after the end check-out is still accepted |
| `FLAG_DELAY_MIN`, `FLAG_DAYS_BACK` | Code.gs | 15, 2 | When flags are worked out after a class, and how many days back they are revisited |
| `PING_UPLOAD_EVERY` | index.html | 5 | Set to `1` to upload every location check |
| `OUT_OF_RANGE_LOGOUT_MS` | index.html | 10 min | Time outside the area before automatic sign-out |
| `PHOTO_MAX_EDGE`, `PHOTO_QUALITY` | index.html | 800, 0.6 | Photo compression |
| `UPLOAD_SPREAD_MS` | index.html | 30 s | How widely phones spread their uploads. Raise it for very large classes |
| `ROSTER_SPREAD_MS` | index.html | 60 s | Same, for the class-list check |
| `DEDUP_CACHE_SECONDS` | Code.gs | 6 h | How long written records are remembered without reading the sheet |
| `BUSY_RETRY_MS`, `LOCK_WAIT_MS` | Code.gs | 15 s, 10 s | How long an upload waits for the sheet, and how long the phone waits after a "busy" reply |
| `DEFAULT_RULES` | both | 5, 7, 15 | Fined / late / absent thresholds when K–M are blank. Keep the two files in step |
| `PHOTO_PUBLIC_LINK` | Code.gs | false | `true` makes photos viewable by anyone with the link |
| `LOG_SHEET`, `ROSTER_SHEET` | Code.gs | Sheet2, Roster | Tab names |

## Tests

```
npm test      # server code against mocked Sheets, Drive, Cache and Lock services
npm run e2e   # the real page in Chromium against the server code (needs Playwright)
npm run load  # how many students a minute of the write lock serves
```

`npm test` covers roster parsing and the new Roster columns, status rules, the sign-in window and session choice, distance worked out on the server, "No session found", duplicate-free retries, photo upload, the JSON API, the class rush, the day summary (including dates Sheets has turned into date cells), per-class tabs, check-out / early-leaver / shared-phone flags, shared roll numbers, and the Roster check and setup.

`npm run e2e` signs in from a browser: refused on the wrong campus, before sign-in opens and with no location set; a shared roll number; check-out in its window; offline sign-in uploaded later; the iPhone location message.

Not covered by either: a real iPhone or Android phone, and the live Google services. Try one of each before a class relies on it, including a sign-in in flight mode.
