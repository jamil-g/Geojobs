# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

GeoJobs Map: a public, worldwide map of geospatial jobs (GIS, remote sensing, EO, web mapping, geomatics). A Google Sheet is the database, Google Apps Script is the scraper and API, and one static HTML page on GitHub Pages is the map. No server, no build step, no npm dependencies in shipped code.

```
job boards ──► Apps Script (triggers) ──► Google Sheet ──► /exec?callback= (JSONP) ──► docs/index.html on GitHub Pages
```

## Layout

| Path | Role |
|---|---|
| `apps-script/Code.gs` | Entire backend, one file. Runs in Apps Script (V8). Deployed by pasting or `clasp push` |
| `apps-script/appsscript.json` | Manifest: V8, web app `ANYONE_ANONYMOUS`, `USER_DEPLOYING` |
| `docs/index.html` | Entire frontend, one self-contained file (MapLibre from jsDelivr, CARTO basemap). Served by GitHub Pages from `/docs` |
| `docs/.nojekyll` | Stops Pages running Jekyll |
| `tests/run.js` | Offline tests: runs `Code.gs` in a Node `vm` with Apps Script services stubbed and all HTTP mocked |
| `tests/fixtures/` | Synthetic API responses (never commit real scraped job data) |

## Commands

```bash
node tests/run.js      # all backend tests; also catches syntax errors in Code.gs. No network, no quota
clasp push             # upload apps-script/ (needs a local .clasp.json with rootDir "apps-script"; gitignored)
```

After `clasp push` or pasting, the live web app does **not** change until a new version is deployed: Apps Script → Deploy → Manage deployments → edit → Version: **New version** → Deploy. The `/exec` URL stays the same. This is the most common cause of "the map shows old behaviour / fails to load".

`node --check` refuses the `.gs` extension; the test runner compiles the file instead.

There is no build for the frontend. Open `docs/index.html` directly: with `CONFIG.API_URL` empty it runs on built-in demo data (`demoJobs()`).

## Backend architecture (`apps-script/Code.gs`)

Top of file: `CFG` holds the **defaults** for every setting; the live values come from the sheet's settings tabs (see "Settings in the Google Sheet"). Prefer a setting over a literal in a function. Private helpers end in `_` (Apps Script hides them from the Run menu).

Flow per run: `runFetch()` (every 6 h, regular sources) and `runJSearch()` (daily, quota-limited sources) both call `ingest_(label, pick)`:

1. **Collect:** each entry in `SOURCES` has `fn` returning "raw" jobs `{ source, sourceHome, title, company, url, postedAt, locationRaw, description, jobTypeHint, remoteHint, remoteScopeHint, workArrangement?, salary, tags[], lat?, lng?, countryCodeHint?, skipFilter? }`. `daily: true` sources run only in `runJSearch`. `enabled()` gates keyed sources.
2. **Filter:** `isGeoJob_` (title/tags match one keyword, or description matches two).
3. **Normalize:** `normalize_` → `classifyJobType_`, `classifyWorkMode_`, `detectLang_`, dedupe key = slug(title)|slug(company). Same job on another board goes into `alsoOn`, not a new row.
4. **Geocode:** `geolocate_(job, geo)` with one `Geo_` instance per run.
5. **Write** rows to the `Jobs` sheet in `HEADERS` order; `enrichManualRows_` completes rows pasted by hand and rows a previous run couldn't geocode (`geoLevel` empty).

Other entry points: `cleanupOld` (daily, drops rows older than `CFG.MAX_AGE_DAYS`), `setup` (data tabs, settings tabs, triggers; safe to re-run), `applySchedule`, `checkSettings`, `testSources`, `testJSearch` (1 request), `onOpen` menu, `onEdit` (clears the settings cache), `doGet`, `getJobs`.

### Sheets

- `Jobs`: columns = `HEADERS` (`id, dedupeKey, title, company, source, sourceHome, url, postedAt, fetchedAt, locationRaw, city, country, countryCode, lat, lng, geoLevel, jobType, workMode, remoteScope, language, salary, tags, description, alsoOn`). Changing `HEADERS` changes the sheet layout: append new columns at the end, never reorder.
- `GeoCache`: `query → JSON result`. Keys: plain lowercased place, `remote:<place>` for remote scopes, `capital:<ISO2>`. `null` results are cached too (means "looked up, not found").
- `Log`: `log_()` output, trimmed to ~500 rows. Settings warnings are logged under `settings`.
- Settings tabs: see "Settings in the Google Sheet".

### Enumerations (shared with the frontend, keep in sync)

- `jobType`: `permanent | contract | freelance | internship`
- `workMode`: `onsite | hybrid | remote-country | remote-worldwide`
- `geoLevel`: `city | state | country | region | worldwide | unknown | ''` (`''` = not geocoded yet, retried next run; `country` = pinned to the capital)
- `language`: ISO 639-1 (`en de fr es pt it nl pl sv ar he ru ja ko zh`)

### Geocoding rules (deliberate, don't regress)

- **No hard-coded coordinates, cities or capitals.** Everything comes from a geocoder and is cached. The owner explicitly rejected a static country/capital table.
- `GEOCODER = 'google'` in the `Config` tab (primary, key in Script property `GOOGLE_MAPS_KEY`, Geocoding API only). If the key is missing or Google returns `REQUEST_DENIED` / `OVER_*` / `INVALID*`, `Geo_.lookup_` switches that run to Nominatim and logs it. `'nominatim'` makes OSM primary.
- Country-only locations are pinned to the capital from OSM's `capital=yes` via Overpass (`Geo_.overpassCapital_`), whichever geocoder is active. Fallback: the country's own point.
- Region words (EMEA, LATAM, GCC…) are mapped to geocodable names in `REGION_WORDS` (text only, no coordinates).
- A remote job limited to a state stays at state level, not the capital.
- **Nominatim policy:** max 4 requests/minute for recurring scripts, identify the app (`CFG.USER_AGENT`, `CFG.APP_REFERER`), cache everything. Enforced by `Geo_.wait_` with `CFG.NOMINATIM_GAP_MS` (15 s) and `CFG.GEO_TIME_BUDGET_MS` (4 min per run). Work that doesn't fit is left with `geoLevel ''` and **not cached**, so it's retried. On HTTP 403/429 set `blocked`, stop geocoding for the run, never mark jobs `unknown`.
- `Geo_` methods return `undefined` for "ran out of time / blocked" and `null` for "not found". Keep that distinction.

### Sources: constraints

- LinkedIn, Indeed and Glassdoor have no public read API and forbid scraping. Don't add scrapers for them; they come in through **JSearch** (`src_jsearch_`), which reads Google for Jobs.
- **JSearch:** endpoint is `/search-v2` (`CFG.JSEARCH_ENDPOINT`; `/search` was retired in 2026 and returns 404 "Endpoint '/search' does not exist"). Free plan = 200 requests/month; the daily run makes one request per `CFG.JSEARCH_QUERIES` entry, first page only (don't follow the cursor). A query is text or `{ query, country }`; JSearch defaults to the US. `jsearchJobs_` accepts `data[]`, `data.jobs[]`, `jobs[]`, `results[]`; an unknown shape logs its top-level keys. Keys: `JSEARCH_RAPIDAPI_KEY` (+ optional `JSEARCH_RAPIDAPI_HOST`) or `JSEARCH_API_KEY` (OpenWeb Ninja direct).
- Remotive asks for ~4 calls/day; RemoteOK and Himalayas require a visible link back (the popup's "Source" link satisfies this). Keep `source` + `sourceHome` on every job.
- `testSources` must keep skipping `daily` sources so testing never burns JSearch quota.

### Web endpoint (`doGet`)

- `?callback=name` → JSONP (`text/javascript`). The callback name is sanitized to `[\w$.]`, max 64 chars. This is how the Pages site loads data: a `<script>` tag is not subject to CORS, and Apps Script can't set CORS headers anyway.
- `?format=json` → JSON. No parameters → the `Index` HTML file if one exists in the Apps Script project, otherwise JSON.
- Web app access must be **Anyone** (anonymous). "Anyone with a Google account" redirects to a login page and breaks JSONP.

## Frontend (`docs/index.html`)

- Single file, vanilla JS, MapLibre GL 4.7.1 from jsDelivr, CARTO `dark-matter` / `positron` styles. Symbol layers must use fonts that exist on CARTO's glyph server: `Montserrat Medium`, `Open Sans Bold` (others fail silently and can blank the GeoJSON layer).
- `CONFIG.API_URL` = the `/exec` URL. Data load order in `loadJobs`: `google.script.run` (when served by Apps Script) → `jsonp(API_URL)` → demo data. On JSONP failure `diagnose()` fetches `?format=json` to tell the user *why* (old deployment, sign-in required, error page).
- `applyServerConfig(data.config)` runs before `prepare`: `MapConfig` values (anchor, zooms, default theme and grouping) override `CONFIG`; malformed values are ignored.
- Theme changes use `map.setStyle(url, { diff: false })`. With the default diffing, MapLibre removes the page's own layers and never fires `style.load`, so the markers vanish. Keep `diff: false`.
- Pipeline: `prepare` (timestamps, worldwide spiral around `CONFIG.WORLD_ANCHOR`, golden-angle fan-out for jobs sharing a point) → `applyFilters` → `updateMap` / `renderList` / `renderStats` / `renderLegend`.
- Scroll-follow: an `IntersectionObserver` on list rows (`onRowsCross`) calls `flyToJob`. `silentUntil` suppresses it after programmatic scrolls and re-renders; keep that guard or the map fights the user.
- Work-mode colours are CSS variables (`--onsite --hybrid --rcountry --rworld`) read into MapLibre paint via `cssVar()`; theme switch re-adds layers on `style.load`.
- Everything user-provided goes through `esc()` before `innerHTML`. Keep it that way: job titles and descriptions are third-party text.
- Mobile (≤760 px): the list becomes a bottom sheet and filters start folded (`#filtersBtn`).

## Secrets and publishing

This repository is public.
- API keys live only in Apps Script **Script properties** (`GOOGLE_MAPS_KEY`, `JSEARCH_RAPIDAPI_KEY`, `JSEARCH_API_KEY`, `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`). Never put a key in `Code.gs`, `index.html`, tests, fixtures or commit messages. `http_` masks `key=` / `app_key=` in logged URLs; keep that.
- `.clasp.json` / `.clasprc.json` are gitignored.
- The `/exec` URL in `docs/index.html` is public by design (read-only job data).
- Fixtures are synthetic. Don't commit real API responses.

## Settings in the Google Sheet

Owner requirement: every setting lives in the sheet, editable without code changes or redeploys. Implemented in the `SETTINGS IN THE SHEET` section of `Code.gs`.

**Tabs** (`TABS`; `setup()` → `ensureConfigSheets_()` creates missing ones pre-filled from `CFG_DEFAULTS` and never overwrites values; for `Config`/`MapConfig` it only appends settings that are missing):

| Tab | Columns | Feeds |
|---|---|---|
| `Config` | `key`, `value`, `type`, `description` | Scalars in `CONFIG_FIELDS` (type, min/max/integer/oneOf, description). Dropdown validation on `oneOf` fields |
| `MapConfig` | same | `CFG.MAP` via `MAP_FIELDS`; returned by `getJobs()` as `config` and applied by the page's `applyServerConfig()` |
| `Keywords` | `pattern`, `enabled`, `note` | `CFG.KEYWORDS` (invalid regex rows skipped; no enabled rows → defaults) |
| `Feeds` | `name`, `url`, `home`, `keyword_filter`, `all_remote`, `enabled` | `CFG.RSS_FEEDS` (all disabled → no feeds, on purpose) |
| `JSearchQueries` | `query`, `country`, `enabled` | `CFG.JSEARCH_QUERIES` (warns above 200 requests/month) |
| `Sources` | `name`, `enabled`, `note` | `CFG.DISABLED_SOURCES`, checked in `ingest_` and `testSources` |
| `RegionWords` | `word`, `geocode_as` | `CFG.REGION_WORDS` |

**How it works**
- `CFG` is the defaults and the documentation. `CFG_DEFAULTS` is a deep copy taken at load. `loadConfig_(opts)` resets `CFG` to the defaults, then overlays the parsed tabs. Called at the start of `ingest_`, `cleanupOld`, `setup`, `applySchedule`, `checkSettings`, `testSources`, `testJSearch` and `getJobs`.
- Parsed settings are cached in `CacheService` (`CONFIG_CACHE_KEY`, 5 min). The simple trigger `onEdit` clears the cache when a settings tab is edited. `opts.fresh` skips the cache; `opts.quiet` (web requests) doesn't write warnings to `Log`, so public traffic can't flood it.
- Bad values: `parseSetting_` rejects them, the default stays, and a warning like `Config row 5: FETCH_EVERY_HOURS must be one of: 1, 2, 4, 6, 8, 12; using the default.` goes to `Log`. Menu **Check settings** shows the count as a toast.
- Keyword regexes compile lazily in `kwRes_()`, keyed on the identity of `CFG.KEYWORDS`. Don't reintroduce a module-level compiled list.
- Schedule settings (`FETCH_EVERY_HOURS`, `JSEARCH_HOUR`) take effect through `installTriggers_()`: menu **Apply schedule** or `setup`. `installTriggers_` only replaces this project's three triggers.
- `bool_()` reads checkboxes, `yes/no`, `1/0`, `x`; blank `enabled` means enabled.
- **Secrets never come from the sheet:** keys matching `SECRET_NAME_RE` (`…_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `APP_ID`) are ignored with a warning. Keys stay in Script properties.
- Adding a setting: add the default to `CFG`, add a field to `CONFIG_FIELDS` or `MAP_FIELDS` with type, limits and a plain-language `desc`, use `CFG.X` in code, and add a test. `setup` adds the new row to existing sheets.
- `API_URL` stays in `docs/index.html`: the page needs it to reach the sheet.

## Public sheet model

The owner intends to make the Google Sheet public. Design every change with that in mind:
- The sheet is shared "Anyone with the link: Viewer". Viewers can read every tab and can **view the bound script's code** (already public on GitHub), but **cannot see Script properties**. "Make a copy" copies the sheet and the script but **not** Script properties or triggers, so each copy needs its own keys and `setup()`.
- Editors of the sheet can open the script and **can see Script properties**. Edit access is for trusted maintainers only; for people who should only tune settings, use protected ranges.
- Nothing personal or secret goes into any tab: no keys, no emails, no unmasked URLs in `Log`.
- The web app and triggers run as the account that deployed them, so public map traffic uses that account's Apps Script quotas. `getJobs()` caches its payload in `CacheService` (`JOBS_CACHE_KEY`, chunked at `JOBS_CACHE_CHUNK_CHARS` to stay under the 100 KB per-value limit), so a full sheet read happens at most once per `JOBS_CACHE_SECONDS`. `ingest_` and `cleanupOld` call `invalidateJobsCache_()` once they actually change the `Jobs` sheet, so visitors never wait longer than one run for fresh data.
- **The owner's sheet is also the public template.** The README links to `https://docs.google.com/spreadsheets/d/<id>/copy` (placeholder `SHEET-ID`). A copy brings the code, all tabs and the current data, but not Script properties, triggers or the web app; the new owner adds keys and runs `setup`. Consequences:
  - Keep the template sheet shared as "Anyone with the link: Viewer" with "viewers can download, print and copy" enabled, or `/copy` stops working. Never share it as editor.
  - After changing `apps-script/Code.gs` in the repo, also update the code inside the template sheet (paste or `clasp push`), or new copies get old code.
  - Everything in the tabs, including `Log`, travels to every copy: keep log messages free of keys and personal data (`http_` already masks `key=`).
  - `setup()` must work on a copy that already has all tabs and data (it does: it only adds what's missing and replaces this project's triggers).
- The `Jobs` tab can also be published as CSV (File → Share → Publish to web) for reuse in QGIS or Excel. Keep its columns stable (`HEADERS`: append only).

## Testing conventions

- Every backend change gets a case in `tests/run.js`. The harness is `sandbox({ props, net, tabs })`: `props` = Script properties, `net(url, opts)` = mock returning `{ code?, body }`, `tabs` = initial sheet contents. `fakeSpreadsheet` implements the ranges, checkboxes, validation and toasts `Code.gs` uses; `ctx._ss`, `ctx._cache`, `ctx._triggers`, `ctx._logs` expose state for assertions. Reset the per-execution memo with `run(ctx, '_cfgLoaded = false')` to simulate a new execution. `Date.now` and `Utilities.sleep` share a fake clock, so rate-limit and time-budget logic is testable instantly.
- Top-level `const` in `Code.gs` (e.g. `CFG`) is reachable with `vm.runInContext('CFG…', ctx)`; function declarations are properties of the context and can be overridden (`ctx.http_ = …`).
- Run `node tests/run.js` before committing; it exits non-zero on failure.

## Style

- Plain language in UI copy and logs; errors say what to do next (e.g. which Apps Script menu to open).
- Keep both files self-contained. No bundlers, no frameworks, no new CDNs beyond jsDelivr / Google Fonts.
- Comments explain *why* (policies, quotas, API quirks), not what.
