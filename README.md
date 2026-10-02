# GeoJobs Map

A worldwide map of geospatial jobs: GIS, remote sensing, earth observation, web mapping and geomatics roles, collected from public job boards and placed where they are.

**Live map:** https://jamil-g.github.io/Geojobs/

- Jobs from Himalayas, Remotive, RemoteOK, Jobicy, Arbeitnow, GIS Jobs Clearinghouse and We Work Remotely, plus LinkedIn, Indeed and Glassdoor through JSearch.
- Every job is classified by contract type (permanent, contract, freelance, internship), work mode (on-site, hybrid, remote in one country, remote worldwide) and the language of the post.
- A post that names only a country is pinned to that country's capital. Worldwide-remote jobs gather around a marker in the mid-Atlantic.
- Filter by contract, work mode, language, board, date or free text. Group the list by date, country, contract or work mode. Scrolling the list flies the map to each job.
- Each job links back to the board it came from.

**How it runs:** no server and no database to host. A Google Sheet stores the jobs, Apps Script fetches, classifies and geocodes them on a schedule and serves them as JSON, and a single HTML page on GitHub Pages draws the map with MapLibre.

```
job boards ──► Apps Script (every 6 h) ──► Google Sheet ──► /exec?callback= ──► docs/index.html (GitHub Pages)
                  classify · dedupe · geocode                  (JSONP, no CORS)      MapLibre map
```

## Repository

| Path | What it is |
|---|---|
| `apps-script/Code.gs` | The whole backend: sources, classification, geocoding, storage, web endpoint |
| `apps-script/appsscript.json` | Apps Script manifest (V8 runtime, web-app access) |
| `docs/index.html` | The map. GitHub Pages serves this folder |
| `tests/run.js` | Offline tests for `Code.gs` (`node tests/run.js`, no network, no quota used) |
| `CLAUDE.md` | Notes for working on the project with Claude Code |

## Set up your own copy

Want your own map with your own data? Everything runs in your Google account, so nobody else's quotas or keys are involved. There are two ways to get the backend; the map part (steps 2 and 3) is the same for both.

### 1a. Copy the template sheet (quickest)

1. Open **[the template](https://docs.google.com/spreadsheets/d/1v9E-BjbIEMgSl9b3GSNSZ_2VmU-nEIQuxn-pZu5gDq0/copy)** and click **Make a copy**.
   You get the sheet with all its settings tabs, the current jobs, and the Apps Script code already inside.
   **Not copied:** API keys, scheduled runs and the web app. Those are yours to set up, which also means the original owner's keys never reach your copy.
2. In your copy: **Extensions → Apps Script → Project Settings → Script properties**, add your own keys. All are optional:
   - `GOOGLE_MAPS_KEY`: a Google Maps Platform key with the **Geocoding API** enabled. Without it, geocoding uses OpenStreetMap Nominatim (free, slower).
   - `JSEARCH_RAPIDAPI_KEY` or `JSEARCH_API_KEY`: LinkedIn, Indeed and Glassdoor jobs (see [Adding JSearch](#adding-jsearch-linkedin-indeed-glassdoor)).
   - `ADZUNA_APP_ID` + `ADZUNA_APP_KEY`: Adzuna jobs.
3. Select `setup` in the function dropdown and click **Run**, then approve the permissions.
   Google shows "Google hasn't verified this app" because the script is your own copy, not a published app: click **Advanced → Go to … (unsafe)**. The script only touches this spreadsheet and the job boards listed below.
4. In the `Config` tab, set `APP_REFERER` to your own map's URL.
5. Run `runFetch` to pull fresh jobs. Old jobs from the template disappear on their own after `MAX_AGE_DAYS`; you can also delete the rows in `Jobs` and `Log` to start clean.

Then continue with [2. Data endpoint](#2-data-endpoint).

### 1b. Start from an empty sheet

1. Create a new Google Sheet, for example "GeoJobs DB".
2. **Extensions → Apps Script**.
3. Replace the contents of `Code.gs` with `apps-script/Code.gs`. In **Project Settings**, tick "Show appsscript.json" and replace it with `apps-script/appsscript.json`.
   (Or push both with [clasp](https://github.com/google/clasp): `clasp clone <scriptId> --rootDir apps-script`, then `clasp push`.)
4. **Project Settings → Script properties**: add your keys, as in 1a step 2. Google is the primary geocoder (the `GEOCODER` setting in the `Config` tab); without a key, or if Google refuses a request, runs switch to Nominatim by themselves and say so in the `Log` tab.
5. Select `setup` and click **Run**. Approve the permissions (same "unverified app" note as above).
   This creates the data tabs (`Jobs`, `GeoCache`, `Log`), the **settings tabs** (see [Settings](#settings)), and three triggers:
   - `runFetch` every 6 hours (collect new jobs)
   - `runJSearch` daily at 07:00 (LinkedIn, Indeed, Glassdoor via JSearch; does nothing until you add a key)
   - `cleanupOld` daily at 03:00 (remove posts older than 45 days)
6. In the `Config` tab, set `APP_REFERER` to your map's URL; OpenStreetMap asks apps to identify themselves.
7. Run `testSources` once and open the `Log` tab. Each board should report "N raw, M geo matches".
8. Run `runFetch`. The `Jobs` tab fills up.

After reloading the sheet you also get a **🗺️ GeoJobs** menu: fetch now, test sources, **Check settings**, **Apply schedule**, setup.

### Keep your copy safe

- Share your sheet as **Viewer** at most. Anyone with **edit** access can open the script, read your API keys and change the code that your scheduled runs execute under your account.
- Keys go in Script properties only, never in a tab.

### 2. Data endpoint

**Deploy → New deployment → Web app**, Execute as **Me**, access **Anyone** (not "Anyone with a Google account").
Copy the URL ending in `/exec`.

> Apps Script deployments are frozen to a version. After changing `Code.gs`, go to **Deploy → Manage deployments → edit → Version: New version → Deploy**. The URL stays the same.

Check it: `…/exec?callback=test` should answer `test({"updatedAt":…`.

### 3. The map on GitHub Pages

1. Fork this repository (or push your own copy), and in `docs/index.html` set `CONFIG.API_URL` to your `/exec` URL.
2. Push, then **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/docs`**.
3. The map appears at `https://<your-user>.github.io/<repo-name>/` within a minute or two.

The page loads data with JSONP (`/exec?callback=…`), so there is no CORS to configure. Opened with no `API_URL`, it runs on built-in demo data.

## Sources

| Board | Type | Notes |
|---|---|---|
| Himalayas | JSON API, no key | Remote jobs. Attribution link required (shown in the popup). Data refreshes daily. |
| Remotive | JSON API, no key | Asks for no more than about 4 calls a day; the script uses 2 queries per run. |
| RemoteOK | JSON API, no key | Requires naming and linking Remote OK as the source (done). |
| Jobicy | JSON API, no key | Remote jobs by tag. |
| Arbeitnow | JSON API, no key | Europe, many German-language posts. |
| GIS Jobs Clearinghouse | RSS | GIS-only, mostly US on-site. |
| We Work Remotely | RSS | Filtered by GIS keywords. |
| Adzuna (optional) | JSON API, free key | 17 countries, on-site jobs with coordinates. Script properties `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`. |
| JSearch (optional) | JSON API, free key | LinkedIn, Indeed, Glassdoor, ZipRecruiter and company sites via Google for Jobs. Each job shows its original board as the source. Runs once a day. |

### Adding JSearch (LinkedIn, Indeed, Glassdoor)

LinkedIn, Indeed and Glassdoor have no public API for reading jobs and forbid scraping, so they come in through JSearch.

1. Sign up for JSearch on RapidAPI (by OpenWeb Ninja) or directly at openwebninja.com. The free plan is 200 requests a month.
2. Script properties: `JSEARCH_RAPIDAPI_KEY` (RapidAPI) **or** `JSEARCH_API_KEY` (OpenWeb Ninja). If your RapidAPI listing shows an `X-RapidAPI-Host` other than `jsearch.p.rapidapi.com`, add `JSEARCH_RAPIDAPI_HOST` too.
3. Run `testJSearch` (one request).
4. Run `setup` again to install the daily trigger.

The script calls `/search-v2` (JSearch retired `/search` in 2026; change `JSEARCH_ENDPOINT` in the `Config` tab if it moves again). Queries are rows in the `JSearchQueries` tab; leave `country` blank for the United States. Each enabled row costs one request a day, and the default 6 use about 180 of the 200 free requests a month (`Check settings` warns above 200). `testSources` skips JSearch to save quota.

For a role no source finds, paste a row into the `Jobs` sheet with at least `title`, `url`, `company` and `locationRaw`. The next run classifies and geocodes it.

## How classification works

- **Keep or drop:** the title or tags must match a GIS keyword, or the description must match at least two (the `Keywords` tab, including Arabic, Hebrew, German, French, Spanish and Portuguese terms).
- **Contract type:** the board's own field first, then text patterns.
- **Work mode:** hybrid, then on-site, then remote in a country or region, then remote worldwide. JSearch's `work_arrangement` is used when present.
- **Language:** script detection (Hebrew, Arabic, Cyrillic, CJK) plus stop-word voting for 9 Latin-script languages.
- **Location:** no hard-coded coordinates. Google's Geocoding API (or Nominatim) handles cities, states and region words (the `RegionWords` tab). A country-only post goes to its capital, read from OpenStreetMap's `capital=yes` tag through the free Overpass API. Every answer is cached in the `GeoCache` sheet, so each place is looked up once; correct a row there by hand if needed.
- **Duplicates:** the same title and company on another board is stored once and listed under "Also posted on".

## Limits

- Apps Script stops an execution at 6 minutes; a normal run takes well under that.
- Google geocoding: about 100 new places in roughly 15 seconds, well within the free monthly usage thanks to the cache.
- Nominatim (backup): 4 requests a minute for recurring scripts, so about 16 new places per run; the rest are placed on later runs.
- If a geocoder rate-limits or blocks, geocoding pauses until the next run; nothing is marked as not found.

## Settings

Every setting lives in the Google Sheet, so you can change it without touching code or redeploying. `setup` creates these tabs, pre-filled with the defaults:

| Tab | What you set there |
|---|---|
| `Config` | Retention days, fetch interval, geocoder (google or nominatim), rate limits, `APP_REFERER`, JSearch endpoint, date range and hour, Adzuna countries and words. Each row has a description; choices have a dropdown |
| `Keywords` | The GIS keywords (regular expressions) that decide whether a job is kept. Untick to disable, add rows for your own |
| `Feeds` | RSS feeds: add any job feed, choose whether to keyword-filter it and whether all its jobs are remote |
| `JSearchQueries` | The daily LinkedIn/Indeed/Glassdoor searches, each with an optional country code |
| `Sources` | Switch any job board on or off |
| `RegionWords` | Words the geocoder doesn't understand (EMEA, LATAM, GCC…) and the place to look up instead |
| `MapConfig` | The map: zoom levels, default light/dark theme, default list order (newest first or by country) |

- Changes apply on the next run (edits clear the settings cache at once). **GeoJobs → Check settings** re-reads everything and tells you if a value is wrong; details go to the `Log` tab and the default is kept.
- After changing `FETCH_EVERY_HOURS` or `JSEARCH_HOUR`, use **GeoJobs → Apply schedule**.
- Re-running `setup` never overwrites your values; it only adds settings that are missing (for example after a code update).
- **API keys never go in the sheet.** They stay in Script properties, and a key found in a settings tab is ignored with a warning, because the sheet may be public.

The defaults themselves are in `CFG` at the top of `apps-script/Code.gs`. The only setting in `docs/index.html` is `CONFIG.API_URL`, the address of your data.

## Credits

Map data © OpenStreetMap contributors, basemap © CARTO, rendering by MapLibre GL JS. Job data belongs to the boards it links to.


## Project identity and attribution

GeoJobs is an open-source project created and maintained by **Jamil Garzuzi**.

The source code is licensed under the MIT License. If you copy, modify, distribute, sublicense, or sell copies or substantial portions of the software, the copyright and permission notice in `LICENSE` must be retained.

The MIT License covers the source code; it does not grant rights to impersonate the original project or its author. Forks and derivative projects should make their origin clear and should not imply endorsement by, or affiliation with, the original GeoJobs project or Jamil Garzuzi.

For the canonical project and live deployment, use the links at the top of this README.

## License

MIT, see `LICENSE`.
