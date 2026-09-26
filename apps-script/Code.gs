/**
 * ============================================================================
 *  GeoJobs Map — backend (Google Apps Script, bound to a Google Sheet)
 * ============================================================================
 *  • Pulls geospatial jobs from public job-board APIs / RSS feeds
 *  • Filters by GIS keywords, dedupes across boards
 *  • Classifies: job type (permanent / contract / freelance / internship)
 *                work mode (onsite / hybrid / remote-country / remote-worldwide)
 *                language of the post
 *  • Geocodes with Google (primary, your key) or OpenStreetMap Nominatim (free),
 *    cached. No city → the country's capital, from OSM's capital tag via Overpass.
 *  • Stores everything in the "Jobs" sheet, removes old posts automatically
 *  • Serves the job data as JSONP (?callback=) and JSON (?format=json) for the
 *    map on GitHub Pages (docs/index.html)
 *
 *  Setup: see README.md. Short version:
 *    1. Extensions → Apps Script → paste Code.gs (and appsscript.json)
 *    2. Run setup() once (authorize)  → creates sheets + time triggers
 *    3. Run runFetch() once to fill the sheet
 *    4. Deploy → New deployment → Web app (Execute as: Me, Access: Anyone)
 * ============================================================================
 */

// ─────────────────────────────── CONFIG ─────────────────────────────────────
// DEFAULTS ONLY. Edit the live values in the sheet's settings tabs (see
// "SETTINGS IN THE SHEET" below); setup() creates them from these defaults.
const CFG = {
  JOBS_SHEET: 'Jobs',
  GEO_SHEET: 'GeoCache',
  LOG_SHEET: 'Log',
  MAX_AGE_DAYS: 45,            // jobs older than this are removed
  DESC_CHARS: 900,             // description excerpt stored per job
  // Geocoding. 'google' (key in Script property GOOGLE_MAPS_KEY) or 'nominatim' (free).
  // Google falls back to Nominatim by itself if the key is missing or refused.
  GEOCODER: 'google',
  GOOGLE_GAP_MS: 100,          // Google allows ~50 requests/second; 10/s is plenty
  NOMINATIM_GAP_MS: 15000,     // Nominatim policy for recurring scripts: max 4 requests/minute
  OVERPASS_GAP_MS: 2000,
  GEO_TIME_BUDGET_MS: 240000,  // geocode for up to 4 min per run (Apps Script stops at 6)
  APP_REFERER: 'https://YOUR-USER.github.io/geojobs-map/',  // identifies the app to OpenStreetMap: your map's URL
  FETCH_EVERY_HOURS: 6,        // trigger frequency for runFetch
  USER_AGENT: 'GeoJobsMap/1.0 (personal geospatial job map; Google Apps Script)',

  // Keyword regexes (case-insensitive). A job is kept when the TITLE or TAGS
  // hit one of these, or the DESCRIPTION hits at least 2 of them.
  KEYWORDS: [
    '\\bgis\\b', 'geospatial', 'geo-spatial', 'arcgis', '\\bqgis', 'postgis', '\\besri\\b',
    'remote sensing', 'earth observation', 'geomatic', 'geoinformati', 'geo-informati',
    'cartograph', 'photogrammetr', '\\blidar\\b', '\\bgdal\\b', 'geoserver', 'openlayers',
    'leaflet\\.?js', '\\bmapbox', 'maplibre', 'cesium', 'spatial data', 'spatial analy',
    'location intelligence', '\\bgeodata', 'geo data', 'web mapping', 'surveying',
    'satellite imagery', '\\bsar\\b imagery', 'geoai', 'geodatabase', '\\bfme\\b',
    // other languages
    'geoinformatik', 'système d.information géographique', '\\bsig\\b', 'géomatique',
    'información geográfica', 'sistemas de información geográfica', 'geoprocessamento',
    'نظم المعلومات الجغرافية', 'מערכות מידע גאוגרפי', 'ממ"ג'
  ],

  // Generic RSS feeds — add more rows any time (filter:true = apply keyword filter)
  RSS_FEEDS: [
    { name: 'GIS Jobs Clearinghouse', url: 'https://www.gjc.org/cgi-bin/rssjobs.pl', home: 'https://www.gjc.org', filter: false, remote: null },
    { name: 'We Work Remotely', url: 'https://weworkremotely.com/remote-jobs.rss', home: 'https://weworkremotely.com', filter: true, remote: true }
  ],

  // Adzuna (optional, free key at developer.adzuna.com). Put ADZUNA_APP_ID and
  // ADZUNA_APP_KEY in Project Settings → Script properties to enable.
  ADZUNA_COUNTRIES: ['gb', 'us', 'de', 'fr', 'nl', 'au', 'ca', 'in', 'sg', 'za', 'pl', 'es', 'it', 'at', 'ch', 'be', 'nz'],
  ADZUNA_QUERIES: ['gis', 'geospatial'],

  // JSearch (LinkedIn, Indeed, Glassdoor, ZipRecruiter… via Google for Jobs).
  // Free plan = 200 requests/month → runs ONCE A DAY, 1 request per query.
  // 6 queries × 30 days = 180 requests. Stay under your plan's monthly limit.
  // Key goes in Script properties: JSEARCH_RAPIDAPI_KEY (from rapidapi.com)
  // or JSEARCH_API_KEY (from openwebninja.com).
  // A query is text, or { query, country } — country is ISO2 and defaults to the US
  // on JSearch's side, so set it for anything outside the US.
  JSEARCH_QUERIES: [
    'GIS developer',
    'geospatial developer',
    'ArcGIS developer',
    'GIS architect',
    'remote sensing engineer',
    { query: 'GIS developer', country: 'ae' }
  ],
  JSEARCH_ENDPOINT: 'search-v2',  // JSearch retired /search in 2026; change here if it moves again
  JSEARCH_DATE_POSTED: '3days',   // today | 3days | week | month (daily run → 3days is enough overlap)
  JSEARCH_HOUR: 7,                // hour of day for the daily JSearch run

  // Words the geocoder doesn't understand → names it does (text only, no coordinates)
  REGION_WORDS: {
    emea: 'Europe', eu: 'Europe', 'european union': 'Europe', eea: 'Europe', 'europe only': 'Europe',
    latam: 'South America', 'latin america': 'South America', apac: 'Asia', 'asia pacific': 'Asia', 'asia-pacific': 'Asia',
    gcc: 'Arabian Peninsula', mena: 'Middle East', nordics: 'Scandinavia', na: 'North America'
  },

  DISABLED_SOURCES: [],           // names from SOURCES switched off in the Sources tab

  // Map display settings, sent to the page with the data (MapConfig tab)
  MAP: {
    WORLD_ANCHOR: [-33, 16], ZOOM_CITY: 10, ZOOM_STATE: 6.2, ZOOM_COUNTRY: 5, ZOOM_REGION: 3.4, ZOOM_WORLDWIDE: 4.6,
    DEFAULT_THEME: 'dark', DEFAULT_GROUP: 'date'
  }
};

const HEADERS = [
  'id', 'dedupeKey', 'title', 'company', 'source', 'sourceHome', 'url', 'postedAt', 'fetchedAt',
  'locationRaw', 'city', 'country', 'countryCode', 'lat', 'lng', 'geoLevel',
  'jobType', 'workMode', 'remoteScope', 'language', 'salary', 'tags', 'description', 'alsoOn'
];

// Keyword regexes, compiled from the live CFG.KEYWORDS (re-compiled when settings change)
let _kwFor = null, _kwRes = [];
function kwRes_() {
  if (_kwFor !== CFG.KEYWORDS) {
    _kwFor = CFG.KEYWORDS;
    _kwRes = CFG.KEYWORDS.map(k => { try { return new RegExp(k, 'i'); } catch (e) { return null; } }).filter(Boolean);
  }
  return _kwRes;
}

// ─────────────────────────────── SOURCES ────────────────────────────────────
// Each source returns an array of "raw" jobs:
// { source, sourceHome, title, company, url, postedAt:Date, locationRaw,
//   description, jobTypeHint, remoteHint, remoteScopeHint, salary, tags[],
//   lat, lng, countryCodeHint, skipFilter }

const SOURCES = [
  { name: 'Himalayas', fn: src_himalayas_ },
  { name: 'Remotive', fn: src_remotive_ },
  { name: 'RemoteOK', fn: src_remoteok_ },
  { name: 'Jobicy', fn: src_jobicy_ },
  { name: 'Arbeitnow', fn: src_arbeitnow_ },
  { name: 'RSS feeds', fn: src_rss_ },
  { name: 'Adzuna', fn: src_adzuna_, enabled: () => !!prop_('ADZUNA_APP_ID') },
  // daily:true → skipped by the 6-hourly runFetch, run by runJSearch once a day
  { name: 'JSearch', fn: src_jsearch_, daily: true, enabled: () => !!(prop_('JSEARCH_RAPIDAPI_KEY') || prop_('JSEARCH_API_KEY')) }
];

// Original board → link shown as the source reference
const PUBLISHER_HOMES = {
  linkedin: 'https://www.linkedin.com/jobs', indeed: 'https://www.indeed.com', glassdoor: 'https://www.glassdoor.com',
  ziprecruiter: 'https://www.ziprecruiter.com', monster: 'https://www.monster.com', bayt: 'https://www.bayt.com',
  naukrigulf: 'https://www.naukrigulf.com', gulftalent: 'https://www.gulftalent.com', dice: 'https://www.dice.com'
};

// ───────────────────────────── SETTINGS IN THE SHEET ─────────────────────────
// Everything in CFG above is a DEFAULT. The live values are edited in the
// sheet's settings tabs (setup() creates them, pre-filled with these defaults):
//   Config · Keywords · Feeds · JSearchQueries · Sources · RegionWords · MapConfig
// loadConfig_() overlays those tabs onto CFG at the start of every run and web
// request. A bad value is reported in the Log tab and the default is kept.
// API keys NEVER live in the sheet (it may be public): they stay in Script
// properties, and any secret-looking setting found in a tab is ignored.

const TABS = {
  config: 'Config', keywords: 'Keywords', feeds: 'Feeds', jsearch: 'JSearchQueries',
  sources: 'Sources', regions: 'RegionWords', map: 'MapConfig'
};
const CONFIG_CACHE_KEY = 'geojobs:settings:v1';
const CONFIG_CACHE_SECONDS = 300;           // edits also clear the cache at once (onEdit)
const SECRET_NAME_RE = /(^|_)(API_?)?(KEY|SECRET|TOKEN|PASSWORD|APP_ID)(_|$)/i;

// Settings in the Config tab. type: number | text | list | json
const CONFIG_FIELDS = {
  MAX_AGE_DAYS:        { type: 'number', min: 1, max: 365, integer: true, desc: 'Jobs older than this many days are removed by the daily clean-up.' },
  DESC_CHARS:          { type: 'number', min: 100, max: 5000, integer: true, desc: 'Characters of each job description to store.' },
  FETCH_EVERY_HOURS:   { type: 'number', oneOf: [1, 2, 4, 6, 8, 12], desc: 'Hours between regular fetches: 1, 2, 4, 6, 8 or 12. After changing it, use GeoJobs → Apply schedule.' },
  GEOCODER:            { type: 'text', oneOf: ['google', 'nominatim'], desc: 'google (needs GOOGLE_MAPS_KEY in Script properties) or nominatim (free, 4 lookups a minute). Google falls back to Nominatim by itself.' },
  GOOGLE_GAP_MS:       { type: 'number', min: 20, max: 60000, desc: 'Milliseconds between Google geocoding requests.' },
  NOMINATIM_GAP_MS:    { type: 'number', min: 15000, max: 600000, desc: 'Milliseconds between Nominatim requests. OpenStreetMap policy for recurring scripts: at least 15000 (4 a minute).' },
  OVERPASS_GAP_MS:     { type: 'number', min: 1000, max: 600000, desc: 'Milliseconds between Overpass requests (capital-city lookups).' },
  GEO_TIME_BUDGET_MS:  { type: 'number', min: 10000, max: 300000, desc: 'Milliseconds each run may spend geocoding. Apps Script stops a run at 6 minutes, so keep this at 300000 or less.' },
  APP_REFERER:         { type: 'text', desc: 'Your map\'s public URL. Sent to OpenStreetMap to identify the app.' },
  USER_AGENT:          { type: 'text', desc: 'Identifies the app to job boards and OpenStreetMap.' },
  ADZUNA_COUNTRIES:    { type: 'list', desc: 'Adzuna country codes, comma-separated. Used only when ADZUNA_APP_ID is set in Script properties.' },
  ADZUNA_QUERIES:      { type: 'list', desc: 'Adzuna search words, comma-separated.' },
  JSEARCH_ENDPOINT:    { type: 'text', desc: 'JSearch endpoint. JSearch retired "search" in 2026; the current one is "search-v2".' },
  JSEARCH_DATE_POSTED: { type: 'text', oneOf: ['all', 'today', '3days', 'week', 'month'], desc: 'How far back each daily JSearch run looks.' },
  JSEARCH_HOUR:        { type: 'number', min: 0, max: 23, integer: true, desc: 'Hour of the day (0-23, script time zone) for the daily JSearch run. After changing it, use GeoJobs → Apply schedule.' }
};

// Settings in the MapConfig tab: sent to the map with the job data
const MAP_FIELDS = {
  WORLD_ANCHOR:   { type: 'json', check: v => Array.isArray(v) && v.length === 2 && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 85 ? '' : 'must be [longitude, latitude], e.g. [-33, 16]', desc: '[longitude, latitude] where "remote worldwide" jobs gather.' },
  ZOOM_CITY:      { type: 'number', min: 0, max: 20, desc: 'Zoom when flying to a job pinned to a city.' },
  ZOOM_STATE:     { type: 'number', min: 0, max: 20, desc: 'Zoom for a job pinned to a state or province.' },
  ZOOM_COUNTRY:   { type: 'number', min: 0, max: 20, desc: 'Zoom for a job pinned to a country (its capital).' },
  ZOOM_REGION:    { type: 'number', min: 0, max: 20, desc: 'Zoom for a job pinned to a region such as Europe.' },
  ZOOM_WORLDWIDE: { type: 'number', min: 0, max: 20, desc: 'Zoom for the "remote worldwide" cluster.' },
  DEFAULT_THEME:  { type: 'text', oneOf: ['dark', 'light'], desc: 'Map colours when the page opens.' },
  DEFAULT_GROUP:  { type: 'text', oneOf: ['date', 'country', 'type', 'mode'], desc: 'How the job list is grouped when the page opens (type = contract, mode = work mode).' }
};

const CFG_DEFAULTS = JSON.parse(JSON.stringify(CFG));
let _cfgLoaded = false;

/**
 * Overlay the settings tabs onto CFG. Cached for CONFIG_CACHE_SECONDS.
 * opts.fresh: ignore the cache. opts.quiet: don't write warnings to the Log (web requests).
 * Returns { overrides, warnings }.
 */
function loadConfig_(opts) {
  opts = opts || {};
  if (_cfgLoaded && !opts.fresh) return _cfgLoaded;
  const cache = scriptCache_();
  let parsed = null;
  if (!opts.fresh && cache) { try { parsed = JSON.parse(cache.get(CONFIG_CACHE_KEY) || 'null'); } catch (e) { parsed = null; } }
  if (!parsed) {
    try { parsed = readConfigSheets_(); }
    catch (e) { parsed = { overrides: {}, warnings: ['could not read the settings tabs (' + e.message + '); using defaults'] }; }
    if (!opts.quiet) parsed.warnings.forEach(w => log_('settings', w));
    if (cache) { try { cache.put(CONFIG_CACHE_KEY, JSON.stringify(parsed), CONFIG_CACHE_SECONDS); } catch (e) { } }
  }
  Object.keys(CFG_DEFAULTS).forEach(k => { CFG[k] = JSON.parse(JSON.stringify(CFG_DEFAULTS[k])); });
  Object.keys(parsed.overrides).forEach(k => {
    CFG[k] = k === 'MAP' ? Object.assign({}, CFG.MAP, parsed.overrides.MAP) : parsed.overrides[k];
  });
  _cfgLoaded = parsed;
  return parsed;
}

function readConfigSheets_() {
  const ss = SpreadsheetApp.getActive();
  const out = {}, warnings = [];
  const warn = (tab, row, msg) => warnings.push(tab + (row ? ' row ' + row : '') + ': ' + msg);

  // Config + MapConfig: key / value rows
  [[TABS.config, CONFIG_FIELDS, out], [TABS.map, MAP_FIELDS, null]].forEach(([tab, fields, target]) => {
    const rows = readTab_(ss, tab);
    if (!rows) return;
    const t = target || (out.MAP = {});
    rows.forEach(r => {
      const key = String(r.key === undefined ? '' : r.key).trim().toUpperCase();
      if (!key) return;
      if (SECRET_NAME_RE.test(key)) return warn(tab, r._row, key + ' looks like a secret. API keys belong in Script properties, never in the sheet (it may be public). Ignored.');
      const f = fields[key];
      if (!f) return warn(tab, r._row, 'unknown setting "' + key + '", ignored.');
      const v = parseSetting_(r.value, f, msg => warn(tab, r._row, key + ' ' + msg + '; using the default.'));
      if (v !== undefined) t[key] = v;
    });
  });

  // Keywords
  const kw = readTab_(ss, TABS.keywords);
  if (kw) {
    const list = [];
    kw.forEach(r => {
      if (!bool_(r.enabled, true)) return;
      const p = String(r.pattern === undefined ? '' : r.pattern).trim();
      if (!p) return;
      try { new RegExp(p, 'i'); list.push(p); }
      catch (e) { warn(TABS.keywords, r._row, 'pattern "' + p + '" is not a valid regular expression; skipped.'); }
    });
    if (list.length) out.KEYWORDS = list;
    else if (kw.length) warn(TABS.keywords, 0, 'no enabled patterns, so the default keywords are used.');
  }

  // Feeds (all rows disabled = no RSS feeds, on purpose)
  const feeds = readTab_(ss, TABS.feeds);
  if (feeds && feeds.length) {
    out.RSS_FEEDS = [];
    feeds.forEach(r => {
      if (!bool_(r.enabled, true)) return;
      const url = String(r.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return warn(TABS.feeds, r._row, 'url must start with http:// or https://; row skipped.');
      out.RSS_FEEDS.push({
        name: String(r.name || '').trim() || url.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0],
        url: url,
        home: String(r.home || '').trim() || originOf_(url),
        filter: bool_(r.keyword_filter, true),
        remote: bool_(r.all_remote, false) ? true : null
      });
    });
  }

  // JSearch queries (all rows disabled = no JSearch calls)
  const js = readTab_(ss, TABS.jsearch);
  if (js && js.length) {
    out.JSEARCH_QUERIES = [];
    js.forEach(r => {
      if (!bool_(r.enabled, true)) return;
      const q = String(r.query || '').trim();
      if (!q) return;
      const c = String(r.country || '').trim().toLowerCase();
      if (c && !/^[a-z]{2}$/.test(c)) return warn(TABS.jsearch, r._row, 'country must be a 2-letter code such as ae; row skipped.');
      out.JSEARCH_QUERIES.push(c ? { query: q, country: c } : q);
    });
    const perMonth = out.JSEARCH_QUERIES.length * 31;
    if (perMonth > 200) warn(TABS.jsearch, 0, out.JSEARCH_QUERIES.length + ' enabled queries ≈ ' + perMonth + ' requests a month; the free JSearch plan allows 200.');
  }

  // Sources on/off
  const src = readTab_(ss, TABS.sources);
  if (src) {
    out.DISABLED_SOURCES = [];
    src.forEach(r => {
      const n = String(r.name || '').trim();
      if (!n) return;
      const s = SOURCES.find(x => x.name.toLowerCase() === n.toLowerCase());
      if (!s) return warn(TABS.sources, r._row, 'unknown source "' + n + '". Known: ' + SOURCES.map(x => x.name).join(', ') + '.');
      if (!bool_(r.enabled, true)) out.DISABLED_SOURCES.push(s.name);
    });
  }

  // Region words
  const rw = readTab_(ss, TABS.regions);
  if (rw && rw.length) {
    out.REGION_WORDS = {};
    rw.forEach(r => {
      const w = String(r.word || '').trim().toLowerCase(), a = String(r.geocode_as || '').trim();
      if (!w || !a) return warn(TABS.regions, r._row, 'needs both word and geocode_as; skipped.');
      out.REGION_WORDS[w] = a;
    });
  }

  return { overrides: out, warnings: warnings };
}

/** One setting value → typed value, or undefined (blank or invalid; invalid calls bad()). */
function parseSetting_(raw, f, bad) {
  if (raw === '' || raw === null || raw === undefined) return undefined;
  let v;
  if (f.type === 'number') {
    v = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
    if (!isFinite(v)) { bad('must be a number'); return undefined; }
    if (f.integer && v % 1) { bad('must be a whole number'); return undefined; }
    if (f.min !== undefined && v < f.min) { bad('must be at least ' + f.min); return undefined; }
    if (f.max !== undefined && v > f.max) { bad('must be at most ' + f.max); return undefined; }
  } else if (f.type === 'list') {
    v = String(raw).split(/[,;\n]/).map(s => s.trim()).filter(String);
    if (!v.length) return undefined;
  } else if (f.type === 'json') {
    try { v = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (e) { bad('is not valid JSON'); return undefined; }
  } else {
    v = String(raw).trim();
    if (f.oneOf) v = v.toLowerCase();
  }
  if (f.oneOf && f.oneOf.indexOf(v) < 0) { bad('must be one of: ' + f.oneOf.join(', ')); return undefined; }
  if (f.check) { const msg = f.check(v); if (msg) { bad(msg); return undefined; } }
  return v;
}

/** Rows of a tab as objects keyed by lower-cased header; null if the tab doesn't exist. */
function readTab_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) return null;
  const last = sh.getLastRow(), cols = sh.getLastColumn();
  if (last < 2 || cols < 1) return [];
  const vals = sh.getRange(1, 1, last, cols).getValues();
  const head = vals[0].map(h => String(h).trim().toLowerCase());
  return vals.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { if (h) o[h] = r[j]; });
    return o;
  }).filter(o => Object.keys(o).some(k => k !== '_row' && o[k] !== '' && o[k] !== null && o[k] !== undefined));
}

/** Checkbox / yes / no / 1 / 0 → boolean; blank → dflt. */
function bool_(v, dflt) {
  if (v === true || v === false) return v;
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  if (!s) return dflt;
  if (['true', 'yes', 'y', '1', 'x', 'on', '✓', '✔'].indexOf(s) >= 0) return true;
  if (['false', 'no', 'n', '0', 'off'].indexOf(s) >= 0) return false;
  return dflt;
}

function scriptCache_() { try { return CacheService.getScriptCache(); } catch (e) { return null; } }

/** Create the settings tabs, pre-filled with the defaults. Never overwrites what's there. */
function ensureConfigSheets_() {
  const ss = SpreadsheetApp.getActive();
  const d = CFG_DEFAULTS;
  kvTab_(ss, TABS.config, CONFIG_FIELDS, d);
  kvTab_(ss, TABS.map, MAP_FIELDS, d.MAP);
  listTab_(ss, TABS.keywords, ['pattern', 'enabled', 'note'],
    d.KEYWORDS.map(p => [p, true, '']), ['enabled'], ['pattern'],
    'Regular expressions, case-insensitive. A job is kept when its title or tags match one, or its description matches two.');
  listTab_(ss, TABS.feeds, ['name', 'url', 'home', 'keyword_filter', 'all_remote', 'enabled'],
    d.RSS_FEEDS.map(f => [f.name, f.url, f.home, !!f.filter, f.remote === true, true]), ['keyword_filter', 'all_remote', 'enabled'], ['url', 'home'],
    'RSS feeds. keyword_filter: keep only GIS matches. all_remote: every job in the feed is remote.');
  listTab_(ss, TABS.jsearch, ['query', 'country', 'enabled'],
    d.JSEARCH_QUERIES.map(q => typeof q === 'string' ? [q, '', true] : [q.query, q.country || '', true]), ['enabled'], ['query', 'country'],
    'One JSearch request per enabled row per day. country: 2-letter code (blank = United States). Free plan: 200 requests a month.');
  listTab_(ss, TABS.sources, ['name', 'enabled', 'note'],
    SOURCES.map(s => [s.name, true, s.daily ? 'Runs once a day (quota)' : (s.enabled ? 'Needs a key in Script properties' : '')]), ['enabled'], [],
    'Switch a job board off by unticking it.');
  listTab_(ss, TABS.regions, ['word', 'geocode_as'],
    Object.keys(d.REGION_WORDS).map(k => [k, d.REGION_WORDS[k]]), [], ['word', 'geocode_as'],
    'Words the geocoder doesn\'t understand, and the place name to look up instead.');
}

function kvTab_(ss, name, fields, defaults) {
  let sh = ss.getSheetByName(name);
  const fresh = !sh;
  if (fresh) {
    sh = newTab_(ss, name, ['key', 'value', 'type', 'description']);
    sh.setColumnWidth(1, 190); sh.setColumnWidth(2, 240); sh.setColumnWidth(4, 560);
    sh.getRange(2, 2, Object.keys(fields).length + 20, 1).setNumberFormat('@');   // keep values as typed
  }
  const have = new Set(fresh ? [] : (readTab_(ss, name) || []).map(r => String(r.key || '').trim().toUpperCase()));
  const rows = Object.keys(fields).filter(k => !have.has(k)).map(k => {
    const f = fields[k], v = defaults[k];
    return [k, f.type === 'list' ? v.join(', ') : f.type === 'json' ? JSON.stringify(v) : v, f.type, f.desc];
  });
  if (!rows.length) return;
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, 4).setValues(rows);
  rows.forEach((r, i) => {
    const f = fields[r[0]];
    if (f.oneOf) sh.getRange(start + i, 2).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(f.oneOf.map(String), true).setAllowInvalid(false).build());
  });
  sh.getRange(start, 4, rows.length, 1).setWrap(true);
}

function listTab_(ss, name, headers, rows, checkboxCols, textCols, note) {
  if (ss.getSheetByName(name)) return;
  const sh = newTab_(ss, name, headers);
  if (note) sh.getRange(1, headers.length + 2).setValue('ℹ ' + note).setFontWeight('normal');
  sh.setColumnWidth(1, 260);
  textCols.forEach(c => sh.getRange(2, headers.indexOf(c) + 1, rows.length + 100, 1).setNumberFormat('@'));
  if (!rows.length) return;
  // insertCheckboxes() resets values, so it goes first and the values are written after
  checkboxCols.forEach(c => sh.getRange(2, headers.indexOf(c) + 1, rows.length, 1).insertCheckboxes());
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

function newTab_(ss, name, headers) {
  const sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

/** Simple trigger: editing a settings tab clears the cached settings, so the next run uses them. */
function onEdit(e) {
  try {
    const tab = e && e.range && e.range.getSheet().getName();
    if (Object.keys(TABS).some(k => TABS[k] === tab)) CacheService.getScriptCache().remove(CONFIG_CACHE_KEY);
  } catch (err) { }
}

/** Menu: re-read the settings tabs and say whether anything is wrong. */
function checkSettings() {
  const p = loadConfig_({ fresh: true });
  toast_(p.warnings.length
    ? p.warnings.length + ' setting(s) need attention; details are in the Log tab.'
    : 'Settings OK: ' + CFG.KEYWORDS.length + ' keywords, ' + CFG.RSS_FEEDS.length + ' feeds, ' + CFG.JSEARCH_QUERIES.length + ' JSearch queries.');
}

/** Menu: rebuild the triggers from FETCH_EVERY_HOURS and JSEARCH_HOUR. */
function applySchedule() {
  loadConfig_({ fresh: true });
  installTriggers_();
  toast_('Schedule applied: fetch every ' + CFG.FETCH_EVERY_HOURS + ' h, JSearch daily at ' + CFG.JSEARCH_HOUR + ':00.');
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['runFetch', 'runJSearch', 'cleanupOld'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runFetch').timeBased().everyHours(CFG.FETCH_EVERY_HOURS).create();
  ScriptApp.newTrigger('runJSearch').timeBased().everyDays(1).atHour(CFG.JSEARCH_HOUR).create();
  ScriptApp.newTrigger('cleanupOld').timeBased().everyDays(1).atHour(3).create();
  log_('setup', 'triggers installed: runFetch every ' + CFG.FETCH_EVERY_HOURS + 'h, runJSearch daily at ' + CFG.JSEARCH_HOUR + ':00, cleanupOld daily at 3:00');
}

function toast_(msg) {
  log_('settings', msg);
  try { SpreadsheetApp.getActive().toast(msg, 'GeoJobs', 8); } catch (e) { }
}

function src_jsearch_() {
  const rapidKey = prop_('JSEARCH_RAPIDAPI_KEY'), ninjaKey = prop_('JSEARCH_API_KEY');
  // The RapidAPI host must match the listing you subscribed to (see "X-RapidAPI-Host" in its code snippet).
  const host = prop_('JSEARCH_RAPIDAPI_HOST') || 'jsearch.p.rapidapi.com';
  const base = (rapidKey ? 'https://' + host : (prop_('JSEARCH_BASE_URL') || 'https://api.openwebninja.com/jsearch')) + '/' + CFG.JSEARCH_ENDPOINT;
  const headers = rapidKey
    ? { 'X-RapidAPI-Key': rapidKey, 'X-RapidAPI-Host': host }
    : { 'x-api-key': ninjaKey };
  const out = [];
  CFG.JSEARCH_QUERIES.forEach(item => {
    const q = typeof item === 'string' ? item : item.query;
    const country = typeof item === 'string' ? '' : (item.country || '');
    try {
      // First page only (1 request). search-v2 pages with a cursor; we don't follow it, to save quota.
      const u = base + '?query=' + enc_(q) + '&date_posted=' + CFG.JSEARCH_DATE_POSTED + (country ? '&country=' + enc_(country) : '');
      const j = JSON.parse(http_(u, headers));
      jsearchJobs_(j).forEach(x => {
        const publisher = String(x.job_publisher || 'JSearch').trim();
        const pubKey = publisher.toLowerCase().replace(/[^a-z]/g, '');
        const home = Object.keys(PUBLISHER_HOMES).find(k => pubKey.indexOf(k) === 0);
        const types = [].concat(x.job_employment_types || x.job_employment_type || []).join(' ');
        const loc = x.job_location || [x.job_city, x.job_state, x.job_country].filter(String).join(', ');
        out.push({
          source: publisher, sourceHome: home ? PUBLISHER_HOMES[home] : originOf_(x.job_apply_link),
          title: x.job_title, company: x.employer_name, url: x.job_apply_link || x.job_google_link,
          postedAt: toDate_(x.job_posted_at_datetime_utc || (x.job_posted_at_timestamp && x.job_posted_at_timestamp * 1000)),
          locationRaw: loc, description: stripHtml_(x.job_description),
          jobTypeHint: types.replace(/CONTRACTOR/i, 'contract').replace(/INTERN/i, 'intern'),
          // newer API versions report work_arrangement (remote | hybrid | onsite) next to job_is_remote
          workArrangement: String(x.work_arrangement || '').toLowerCase(),
          remoteHint: (x.job_is_remote || /remote/i.test(x.work_arrangement || '')) ? true : null,
          remoteScopeHint: (x.job_is_remote || /remote/i.test(x.work_arrangement || '')) ? (x.job_country || '') : '',
          salary: salary_(x.job_min_salary, x.job_max_salary, x.job_salary_currency, String(x.job_salary_period || '').toLowerCase().replace('year', 'annual')),
          tags: [].concat(x.required_technologies || []).slice(0, 8).concat(['via JSearch']),
          lat: x.job_latitude, lng: x.job_longitude, countryCodeHint: x.job_country || ''
        });
      });
    } catch (e) { log_('JSearch "' + q + '"', 'ERROR ' + e.message); }
  });
  return out;
}

/** The job list, wherever this API version puts it: data[], data.jobs[], jobs[] or results[]. */
function jsearchJobs_(j) {
  if (!j) return [];
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.data)) return j.data;
  if (j.data && typeof j.data === 'object') {
    for (const k of ['jobs', 'results', 'items', 'data']) if (Array.isArray(j.data[k])) return j.data[k];
  }
  for (const k of ['jobs', 'results', 'items']) if (Array.isArray(j[k])) return j[k];
  log_('JSearch', 'unexpected response shape, top-level keys: ' + Object.keys(j).join(', '));
  return [];
}

function originOf_(url) { const m = String(url || '').match(/^https?:\/\/[^/]+/); return m ? m[0] : ''; }

function src_himalayas_() {
  // Free, no key. Attribution: link back to himalayas.app (the map shows source links).
  const out = [];
  ['gis', 'geospatial', 'remote sensing', 'arcgis'].forEach(q => {
    for (let page = 1; page <= 2; page++) {
      const j = json_('https://himalayas.app/jobs/api/search?sort=recent&q=' + enc_(q) + '&page=' + page);
      (j.jobs || []).forEach(x => {
        const locs = (x.locationRestrictions || []).map(l => (typeof l === 'string' ? l : l.name)).filter(String);
        out.push({
          source: 'Himalayas', sourceHome: 'https://himalayas.app',
          title: x.title, company: x.companyName, url: x.applicationLink || ('https://himalayas.app/jobs/' + x.guid),
          postedAt: toDate_(x.pubDate), locationRaw: locs.join(', '),
          description: stripHtml_(x.description || x.excerpt),
          jobTypeHint: x.employmentType, remoteHint: true,
          remoteScopeHint: locs.length ? locs.join(', ') : 'Worldwide',
          salary: salary_(x.minSalary, x.maxSalary, x.currency, x.salaryPeriod),
          tags: (x.categories || []).slice(0, 8)
        });
      });
      if (!j.jobs || j.jobs.length < 20) break;
    }
  });
  return out;
}

function src_remotive_() {
  // Remotive asks for max ~4 calls/day → only 2 queries, and runs every 6 h.
  const out = [];
  ['gis', 'geospatial'].forEach(q => {
    const j = json_('https://remotive.com/api/remote-jobs?search=' + enc_(q));
    (j.jobs || []).forEach(x => out.push({
      source: 'Remotive', sourceHome: 'https://remotive.com',
      title: x.title, company: x.company_name, url: x.url, postedAt: toDate_(x.publication_date),
      locationRaw: x.candidate_required_location || '', description: stripHtml_(x.description),
      jobTypeHint: x.job_type, remoteHint: true, remoteScopeHint: x.candidate_required_location || 'Worldwide',
      salary: x.salary || '', tags: x.tags || []
    }));
  });
  return out;
}

function src_remoteok_() {
  // Terms: link back to Remote OK and name it as the source (done in the popup).
  const arr = json_('https://remoteok.com/api');
  return (arr || []).filter(x => x && x.position).map(x => ({
    source: 'RemoteOK', sourceHome: 'https://remoteok.com',
    title: x.position, company: x.company, url: x.url || x.apply_url,
    postedAt: toDate_(x.date || (x.epoch * 1000)), locationRaw: x.location || '',
    description: stripHtml_(x.description), jobTypeHint: '', remoteHint: true,
    remoteScopeHint: x.location || 'Worldwide',
    salary: salary_(x.salary_min, x.salary_max, 'USD'), tags: x.tags || []
  }));
}

function src_jobicy_() {
  const out = [];
  ['gis', 'geospatial'].forEach(tag => {
    const j = json_('https://jobicy.com/api/v2/remote-jobs?count=50&tag=' + enc_(tag));
    (j.jobs || []).forEach(x => out.push({
      source: 'Jobicy', sourceHome: 'https://jobicy.com',
      title: x.jobTitle, company: x.companyName, url: x.url, postedAt: toDate_(x.pubDate),
      locationRaw: x.jobGeo || '', description: stripHtml_(x.jobDescription || x.jobExcerpt),
      jobTypeHint: [].concat(x.jobType || []).join(' '), remoteHint: true,
      remoteScopeHint: x.jobGeo || 'Worldwide',
      salary: salary_(x.annualSalaryMin || x.salaryMin, x.annualSalaryMax || x.salaryMax, x.salaryCurrency),
      tags: [].concat(x.jobIndustry || [])
    }));
  });
  return out;
}

function src_arbeitnow_() {
  // Europe-heavy (lots of German-language posts → good for the language filter)
  const out = [];
  for (let page = 1; page <= 4; page++) {
    const j = json_('https://www.arbeitnow.com/api/job-board-api?page=' + page);
    (j.data || []).forEach(x => out.push({
      source: 'Arbeitnow', sourceHome: 'https://www.arbeitnow.com',
      title: x.title, company: x.company_name, url: x.url, postedAt: toDate_(x.created_at * 1000),
      locationRaw: x.location || '', description: stripHtml_(x.description),
      jobTypeHint: (x.job_types || []).join(' '), remoteHint: x.remote ? true : null,
      remoteScopeHint: x.remote ? (x.location || '') : '', salary: '', tags: x.tags || []
    }));
  }
  return out;
}

function src_rss_() {
  const out = [];
  CFG.RSS_FEEDS.forEach(f => {
    try {
      const xml = XmlService.parse(http_(f.url));
      const root = xml.getRootElement();
      const channel = root.getChild('channel');
      const items = channel ? channel.getChildren('item') : [];
      items.forEach(it => {
        const t = childText_(it, 'title');
        const desc = stripHtml_(childText_(it, 'description'));
        let company = '', title = t;
        const m = t.match(/^([^:]{2,60}):\s*(.+)$/);           // "Company: Title" (WWR style)
        if (m && f.name === 'We Work Remotely') { company = m[1]; title = m[2]; }
        const region = childText_(it, 'region') || childText_(it, 'location') ||
          ((desc.match(/Location:\s*([^\n|•]{2,80})/i) || [])[1] || '');
        out.push({
          source: f.name, sourceHome: f.home, title: title, company: company,
          url: childText_(it, 'link'), postedAt: toDate_(childText_(it, 'pubDate')),
          locationRaw: region.trim(), description: desc, jobTypeHint: childText_(it, 'type'),
          remoteHint: f.remote, remoteScopeHint: f.remote ? (region || 'Worldwide') : '',
          salary: '', tags: [], skipFilter: !f.filter
        });
      });
    } catch (e) { log_('RSS ' + f.name, 'ERROR ' + e.message); }
  });
  return out;
}

function src_adzuna_() {
  const id = prop_('ADZUNA_APP_ID'), key = prop_('ADZUNA_APP_KEY');
  const out = [];
  CFG.ADZUNA_COUNTRIES.forEach(cc => CFG.ADZUNA_QUERIES.forEach(q => {
    try {
      const u = 'https://api.adzuna.com/v1/api/jobs/' + cc + '/search/1?app_id=' + id + '&app_key=' + key +
        '&results_per_page=50&max_days_old=' + CFG.MAX_AGE_DAYS + '&what=' + enc_(q) + '&content-type=application/json';
      const j = json_(u);
      (j.results || []).forEach(x => out.push({
        source: 'Adzuna', sourceHome: 'https://www.adzuna.com',
        title: stripHtml_(x.title), company: (x.company || {}).display_name || '', url: x.redirect_url,
        postedAt: toDate_(x.created), locationRaw: (x.location || {}).display_name || '',
        description: stripHtml_(x.description),
        jobTypeHint: [x.contract_type, x.contract_time].filter(String).join(' '),
        remoteHint: null, salary: salary_(x.salary_min, x.salary_max, ''), tags: [x.category && x.category.label].filter(String),
        lat: x.latitude, lng: x.longitude, countryCodeHint: cc.toUpperCase()
      }));
    } catch (e) { log_('Adzuna ' + cc, 'ERROR ' + e.message); }
  }));
  return out;
}

// ─────────────────────────────── MAIN JOBS ──────────────────────────────────

/** Fetch the regular sources (every 6 h). JSearch runs separately, once a day. */
function runFetch() { ingest_('runFetch', s => !s.daily); }

/** Daily run for quota-limited sources (JSearch). */
function runJSearch() { ingest_('runJSearch', s => !!s.daily); }

/** Collect from the chosen sources, filter, classify, geocode, append. */
function ingest_(label, pick) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  const t0 = Date.now();
  try {
    loadConfig_();
    const sh = ensureSheets_();
    const existing = readRows_(sh);
    const ids = new Set(existing.map(r => r.id));
    const keyRow = new Map(existing.map((r, i) => [r.dedupeKey, i]));
    const cutoff = Date.now() - CFG.MAX_AGE_DAYS * 864e5;

    // 1. collect
    let raws = [];
    const stats = {};
    SOURCES.filter(pick).forEach(s => {
      if (CFG.DISABLED_SOURCES.indexOf(s.name) >= 0) return;   // switched off in the Sources tab
      if (s.enabled && !s.enabled()) return;
      try { const r = s.fn(); stats[s.name] = r.length; raws = raws.concat(r); }
      catch (e) { stats[s.name] = 'ERR'; log_(s.name, 'ERROR ' + e.message); }
    });

    // 2. filter + normalize + dedupe
    const geo = new Geo_();
    const fresh = [], alsoOnUpdates = new Map();
    raws.forEach(r => {
      if (!r.title || !r.url) return;
      if (r.postedAt && r.postedAt.getTime() < cutoff) return;
      if (!r.skipFilter && !isGeoJob_(r)) return;
      const job = normalize_(r);
      if (ids.has(job.id)) return;
      if (keyRow.has(job.dedupeKey)) {                    // same job, other board
        const i = keyRow.get(job.dedupeKey);
        if (i >= 0) {
          const row = existing[i];
          const list = (alsoOnUpdates.get(i) || row.alsoOn || '').split(' | ').filter(String);
          if (row.source !== job.source && list.indexOf(job.source + ' ' + job.url) < 0) list.push(job.source + ' ' + job.url);
          alsoOnUpdates.set(i, list.join(' | '));
        }
        return;
      }
      ids.add(job.id); keyRow.set(job.dedupeKey, -1);
      fresh.push(job);
    });

    // 3. geocode new ones
    fresh.forEach(j => geolocate_(j, geo));
    geo.flush();

    // 4. write
    if (fresh.length) {
      const rows = fresh.map(j => HEADERS.map(h => j[h] === undefined || j[h] === null ? '' : j[h]));
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    }
    const col = HEADERS.indexOf('alsoOn') + 1;
    alsoOnUpdates.forEach((v, i) => sh.getRange(i + 2, col).setValue(v));

    // 5. rows you add by hand (e.g. from LinkedIn) get classified + geocoded too
    enrichManualRows_(sh, geo);

    invalidateJobsCache_();   // public getJobs() must not serve last run's data

    log_(label, 'new=' + fresh.length + ' raw=' + raws.length + ' ' + JSON.stringify(stats) +
      ' geocodes=' + geo.calls + ' ' + Math.round((Date.now() - t0) / 1000) + 's');
  } finally {
    lock.releaseLock();
  }
}

/** Remove posts older than MAX_AGE_DAYS. Runs daily on a trigger. */
function cleanupOld() {
  loadConfig_();
  const sh = ensureSheets_();
  const rows = readRows_(sh);
  const cutoff = Date.now() - CFG.MAX_AGE_DAYS * 864e5;
  const keep = rows.filter(r => {
    const d = toDate_(r.postedAt) || toDate_(r.fetchedAt);
    return !d || d.getTime() >= cutoff;
  });
  if (keep.length === rows.length) return log_('cleanupOld', 'nothing to remove');
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, HEADERS.length).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, HEADERS.length).setValues(keep.map(r => HEADERS.map(h => r[h])));
  invalidateJobsCache_();
  log_('cleanupOld', 'removed ' + (rows.length - keep.length));
}

/** Setup: data sheets, settings tabs (pre-filled with defaults) and triggers. Safe to re-run. */
function setup() {
  ensureSheets_();
  ensureConfigSheets_();
  loadConfig_({ fresh: true });
  installTriggers_();
}

/** Checks the JSearch key with ONE request (the first query) and logs a sample. */
function testJSearch() {
  loadConfig_();
  if (!CFG.JSEARCH_QUERIES.length) return log_('test JSearch', 'no enabled rows in the JSearchQueries tab');
  if (!(prop_('JSEARCH_RAPIDAPI_KEY') || prop_('JSEARCH_API_KEY')))
    return log_('test JSearch', 'no key: add JSEARCH_RAPIDAPI_KEY or JSEARCH_API_KEY in Script properties');
  const keep = CFG.JSEARCH_QUERIES;
  CFG.JSEARCH_QUERIES = keep.slice(0, 1);
  try {
    const r = src_jsearch_();
    const boards = [...new Set(r.map(x => x.source))].join(', ');
    log_('test JSearch', '[' + CFG.JSEARCH_ENDPOINT + ' @ ' + (prop_('JSEARCH_RAPIDAPI_KEY') ? (prop_('JSEARCH_RAPIDAPI_HOST') || 'jsearch.p.rapidapi.com') : 'openwebninja') + '] ' + r.length + ' jobs for "' + (keep[0].query || keep[0]) + '" from: ' + (boards || '-') + '. e.g. ' + (r[0] ? r[0].title + ' @ ' + r[0].locationRaw : '-'));
  } finally { CFG.JSEARCH_QUERIES = keep; }
}

/** Quick health check for each source (see the Log sheet). */
function testSources() {
  loadConfig_();
  SOURCES.forEach(s => {
    if (CFG.DISABLED_SOURCES.indexOf(s.name) >= 0) return log_('test ' + s.name, 'switched off in the Sources tab');
    if (s.daily) return log_('test ' + s.name, 'skipped to save quota: run testJSearch (1 request)');
    if (s.enabled && !s.enabled()) return log_('test ' + s.name, 'disabled');
    try {
      const r = s.fn();
      const hits = r.filter(x => x.skipFilter || isGeoJob_(x)).length;
      log_('test ' + s.name, r.length + ' raw, ' + hits + ' geo matches. e.g. ' + (r[0] ? r[0].title : '-'));
    } catch (e) { log_('test ' + s.name, 'ERROR ' + e.message); }
  });
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🗺️ GeoJobs')
    .addItem('Fetch new jobs now', 'runFetch')
    .addItem('Fetch JSearch now (LinkedIn, Indeed, Glassdoor)', 'runJSearch')
    .addItem('Test JSearch key (1 request)', 'testJSearch')
    .addItem('Remove old jobs', 'cleanupOld')
    .addItem('Test sources', 'testSources')
    .addSeparator()
    .addItem('Check settings', 'checkSettings')
    .addItem('Apply schedule', 'applySchedule')
    .addItem('Setup (sheets, settings tabs, triggers)', 'setup')
    .addToUi();
}

// ─────────────────────────────── WEB APP ────────────────────────────────────

function doGet(e) {
  const p = (e && e.parameter) || {};
  // ?callback=fn → JSONP: the map loads data as a <script>, so no CORS anywhere
  if (p.callback) {
    const cb = String(p.callback).replace(/[^\w$.]/g, '').slice(0, 64);
    return ContentService.createTextOutput(cb + '(' + JSON.stringify(getJobs()) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  if (p.format === 'json') {
    return ContentService.createTextOutput(JSON.stringify(getJobs()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // The map normally lives on GitHub Pages (docs/index.html). If you also added
  // it to this Apps Script project as a file named "Index", serve it here too.
  try {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('GeoJobs Map')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify(getJobs()))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// getJobs() is public traffic's only door into the sheet, so its payload is kept
// in CacheService: a full sheet read happens at most once per JOBS_CACHE_SECONDS,
// not once per visitor. ingest_ and cleanupOld invalidate it the moment the Jobs
// tab actually changes, so the cache is never more than one run stale by accident.
// A single cache value is capped at 100 KB, so the JSON is split into chunks
// (JOBS_CACHE_CHUNK_CHARS characters each, comfortably under that even for
// Hebrew/Arabic/CJK text) stored under numbered keys, with a ':n' key holding
// the chunk count. Any of that missing or unparsable just falls back to a
// fresh sheet read — the cache is an optimization, never a source of truth.
const JOBS_CACHE_KEY = 'geojobs:jobs:v1';
const JOBS_CACHE_SECONDS = 21600;      // CacheService's own maximum (6 h); a safety net, since ingest_/cleanupOld invalidate it directly
const JOBS_CACHE_CHUNK_CHARS = 20000;  // worst case (4 bytes/char) ≈ 80 KB, safely under the 100 KB per-value cap

/** Split a string into chunks without breaking a surrogate pair (emoji etc.) across two. */
function jobsCacheChunks_(str) {
  const chunks = [];
  let i = 0;
  while (i < str.length) {
    let end = Math.min(i + JOBS_CACHE_CHUNK_CHARS, str.length);
    if (end < str.length) {
      const c = str.charCodeAt(end - 1);
      if (c >= 0xD800 && c <= 0xDBFF) end--;   // high surrogate: keep its pair together in the next chunk
    }
    chunks.push(str.slice(i, end));
    i = end;
  }
  return chunks;
}

function readJobsCache_() {
  const cache = scriptCache_();
  if (!cache) return null;
  try {
    const n = Number(cache.get(JOBS_CACHE_KEY + ':n') || 0);
    if (!n) return null;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const part = cache.get(JOBS_CACHE_KEY + ':' + i);
      if (part === null) return null;   // a chunk expired or was evicted: fall back to a full read
      parts.push(part);
    }
    return JSON.parse(parts.join(''));
  } catch (e) { return null; }
}

function writeJobsCache_(payload) {
  const cache = scriptCache_();
  if (!cache) return;
  try {
    const chunks = jobsCacheChunks_(JSON.stringify(payload));
    const values = {};
    chunks.forEach((c, i) => { values[JOBS_CACHE_KEY + ':' + i] = c; });
    values[JOBS_CACHE_KEY + ':n'] = String(chunks.length);
    cache.putAll(values, JOBS_CACHE_SECONDS);
  } catch (e) { /* best effort: a visitor just gets a fresh read next time */ }
}

/** Call once the Jobs sheet actually changes (ingest_, cleanupOld), so getJobs() never serves stale data. */
function invalidateJobsCache_() {
  const cache = scriptCache_();
  if (!cache) return;
  try {
    const n = Number(cache.get(JOBS_CACHE_KEY + ':n') || 0);
    const keys = [JOBS_CACHE_KEY + ':n'];
    for (let i = 0; i < n; i++) keys.push(JOBS_CACHE_KEY + ':' + i);
    cache.removeAll(keys);
  } catch (e) { }
}

/** Called by the frontend (google.script.run) or via ?format=json */
function getJobs() {
  loadConfig_({ quiet: true });
  const cached = readJobsCache_();
  if (cached) return cached;
  const rows = readRows_(ensureSheets_());
  const jobs = rows.filter(r => r.title).map(r => {
    const o = {};
    HEADERS.forEach(h => {
      let v = r[h];
      if (v instanceof Date) v = v.toISOString();
      if ((h === 'lat' || h === 'lng') && v !== '') v = Number(v);
      o[h] = v === '' ? null : v;
    });
    return o;
  });
  const payload = { updatedAt: new Date().toISOString(), count: jobs.length, config: CFG.MAP, jobs: jobs };
  writeJobsCache_(payload);
  return payload;
}

// ─────────────────────────────── CLASSIFY ───────────────────────────────────

function isGeoJob_(r) {
  const head = (r.title || '') + ' ' + (r.tags || []).join(' ');
  if (kwRes_().some(re => re.test(head))) return true;
  const d = (r.description || '').slice(0, 4000);
  return kwRes_().filter(re => re.test(d)).length >= 2;
}

function normalize_(r) {
  const desc = (r.description || '').replace(/\s+/g, ' ').trim();
  const wm = classifyWorkMode_(r, desc);
  return {
    id: hash_(r.url),
    dedupeKey: slug_(r.title) + '|' + slug_(r.company),
    title: (r.title || '').trim(),
    company: (r.company || '').trim(),
    source: r.source, sourceHome: r.sourceHome, url: r.url,
    postedAt: r.postedAt || new Date(), fetchedAt: new Date(),
    locationRaw: (r.locationRaw || '').slice(0, 200),
    lat: isNum_(r.lat) ? Number(r.lat) : '', lng: isNum_(r.lng) ? Number(r.lng) : '',
    countryCode: r.countryCodeHint || '',
    jobType: classifyJobType_(r.jobTypeHint, r.title + ' ' + desc.slice(0, 600)),
    workMode: wm.mode, remoteScope: wm.scope,
    language: detectLang_(r.title + ' ' + desc),
    salary: r.salary || '',
    tags: (r.tags || []).filter(String).slice(0, 10).join(', '),
    description: desc.slice(0, CFG.DESC_CHARS),
    alsoOn: ''
  };
}

function classifyJobType_(hint, text) {
  const h = String(hint || '').toLowerCase();
  if (/freelanc|hourly/.test(h)) return 'freelance';
  if (/contract|temporar|fixed|befristet/.test(h)) return 'contract';
  if (/intern|praktik|werkstudent/.test(h)) return 'internship';
  const t = String(text || '').toLowerCase();
  if (/\bfreelan|\bper hour\b|hourly rate|\/\s?hr\b|\b1099\b|self-employed|freiberuf|auto-?entrepreneur/.test(t)) return 'freelance';
  if (/\bcontract(or)?\b(?! management)|fixed[- ]term|temporary|\b\d+[- ]months? (contract|assignment|engagement)|befristet|\bcdd\b|interim|zeitarbeit/.test(t)) return 'contract';
  if (/\bintern(ship)?\b|praktikum|werkstudent|\bstagiaire\b|\bstage\b|traineeship/.test(t)) return 'internship';
  return 'permanent';
}

function classifyWorkMode_(r, desc) {
  const loc = String(r.locationRaw || '');
  const t = ((r.title || '') + ' ' + loc + ' ' + desc.slice(0, 1500)).toLowerCase();
  const hybrid = /\bhybrid|hybride|\b\d\s?(days?|x) (a week )?(in|at) (the )?office|teilweise remote|mobiles arbeiten|télétravail partiel/.test(t);
  if (r.workArrangement === 'hybrid') return { mode: 'hybrid', scope: '' };
  if (r.workArrangement === 'onsite' || r.workArrangement === 'on-site') return { mode: 'onsite', scope: '' };
  const remote = r.remoteHint === true ||
    /\bremote\b|work from home|\bwfh\b|télétravail|homeoffice|home office|fully remote|100% remote|teletrabajo|remoto|telecommute/.test(t);
  if (hybrid) return { mode: 'hybrid', scope: '' };
  if (!remote) return { mode: 'onsite', scope: '' };
  const scope = String(r.remoteScopeHint || loc || '').trim();
  if (!scope || /worldwide|anywhere|global|any location|all countries|world|🌍|🌎|🌏/i.test(scope))
    return { mode: 'remote-worldwide', scope: 'Worldwide' };
  return { mode: 'remote-country', scope: scope.slice(0, 120) };
}

/** Tiny language detector: script ranges + stop-word voting. Returns ISO 639-1. */
function detectLang_(s) {
  s = String(s || '').slice(0, 2500);
  const letters = (s.match(/\p{L}/gu) || []).length || 1;
  const share = re => (s.match(re) || []).length / letters;
  if (share(/[\u0590-\u05FF]/g) > 0.3) return 'he';
  if (share(/[\u0600-\u06FF]/g) > 0.3) return 'ar';
  if (share(/[\u0400-\u04FF]/g) > 0.3) return 'ru';
  if (share(/[\u3040-\u30FF]/g) > 0.1) return 'ja';
  if (share(/[\uAC00-\uD7AF]/g) > 0.3) return 'ko';
  if (share(/[\u4E00-\u9FFF]/g) > 0.3) return 'zh';
  const words = s.toLowerCase().match(/\p{L}+/gu) || [];
  const SW = {
    en: 'the and of to in for with you are is our will be this that we have',
    de: 'der die und das mit für wir sie ist ein eine zu von bei auf den dem nicht auch',
    fr: 'le la les et des pour avec nous vous une est du dans sur au aux qui',
    es: 'el los las y para con nosotros que una del en por como tu es se',
    pt: 'o os e para com nós que uma do da em você são na no ao',
    it: 'il di e per con che una del della sono nel alla gli le',
    nl: 'het en een van voor met wij zijn je op te bij ons dat',
    pl: 'i w na z do się jest oraz dla że nie od po',
    sv: 'och att det som är för med vi på av du en till'
  };
  let best = 'en', bestScore = 0;
  Object.keys(SW).forEach(lang => {
    const set = new Set(SW[lang].split(' '));
    let n = 0; words.forEach(w => { if (set.has(w)) n++; });
    if (n > bestScore) { best = lang; bestScore = n; }
  });
  return best;
}

// ─────────────────────────────── GEO ────────────────────────────────────────
// Nothing is hard-coded; every place comes from a geocoder:
//   • Google Geocoding API (primary, CFG.GEOCODER = 'google') — fast.
//   • OpenStreetMap Nominatim (backup, free) — max 4 requests/minute for
//     recurring scripts, so each run geocodes what fits in CFG.GEO_TIME_BUDGET_MS.
//   • Overpass reads OSM's own capital=yes tag, so a post that names only a
//     country is pinned to that country's capital (one lookup per country).
// Every answer is cached in the GeoCache sheet, so each place is looked up once, ever.


/**
 * Fills city/country/countryCode/lat/lng/geoLevel on a job.
 * geoLevel: city | state | country (→ capital) | region | worldwide | '' (not yet, retried next run)
 */
function geolocate_(j, geo) {
  if (j.workMode === 'remote-worldwide') { j.geoLevel = 'worldwide'; j.lat = ''; j.lng = ''; return; }

  if (isNum_(j.lat) && isNum_(j.lng)) {                       // board already gave coords (Adzuna, JSearch)
    const first = String(j.locationRaw || '').split(',')[0].trim();
    const noCity = !first || first.toUpperCase() === String(j.countryCode).toUpperCase();
    const cap = j.countryCode ? geo.capital(j.countryCode) : null;
    if (cap && (noCity || first.toLowerCase() === String(cap.country).toLowerCase()))
      Object.assign(j, { city: cap.city, country: cap.country, lat: cap.lat, lng: cap.lng, geoLevel: cap.level });
    else { j.city = noCity ? '' : first; j.country = cap ? cap.country : j.countryCode; j.geoLevel = noCity ? 'country' : 'city'; }
    fixScope_(j);
    return;
  }

  const remote = j.workMode === 'remote-country';
  const query = remote ? j.remoteScope : j.locationRaw;
  const parts = splitLocations_(query, remote);
  let hit = null;
  for (let i = 0; i < parts.length && !hit; i++) hit = geo.resolve(parts[i], remote);
  if (!hit) {
    if (j.workMode.indexOf('remote') === 0 && !query) { j.geoLevel = 'worldwide'; j.workMode = 'remote-worldwide'; }
    else if (!geo.outOfTime && !geo.blocked) j.geoLevel = 'unknown';   // looked up, not found
    else j.geoLevel = '';                                     // no time left or blocked → next run
    return;
  }
  Object.assign(j, { city: hit.city || '', country: hit.country || '', countryCode: hit.cc || j.countryCode,
    lat: hit.lat, lng: hit.lng, geoLevel: hit.level });
  fixScope_(j);
}

/** "US" as a remote scope → "United States" once we know the country name. */
function fixScope_(j) {
  if (j.workMode === 'remote-country' && j.country && /^[A-Z]{2}$/.test(String(j.remoteScope || '').trim())) j.remoteScope = j.country;
}

function splitLocations_(s, remoteScope) {
  s = String(s || '').replace(/\(.*?\)/g, ' ').replace(/\b(remote|hybrid|on-?site|only|based)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  let parts = s.split(/\s*(?:;|\||\/|•| or | and |\n)\s*/i).filter(p => p.trim().length > 1);
  // A remote scope like "USA, Canada" is a list of places → try each in turn.
  // An on-site "Austin, TX" stays whole so the geocoder gets the full address.
  if (remoteScope) {
    const commas = parts[0].split(/\s*,\s*/).filter(p => p.length > 1);
    if (commas.length > 1) parts = commas.concat(parts);
  }
  return parts.slice(0, 5);
}

/**
 * Geocoder with two providers, a persistent sheet cache and polite rate limiting.
 *   CFG.GEOCODER = 'google'    → Google Geocoding API (key in Script property GOOGLE_MAPS_KEY)
 *   CFG.GEOCODER = 'nominatim' → OpenStreetMap Nominatim (free, max 4 requests/minute)
 * If Google has no key or refuses a request, the run switches to Nominatim by itself.
 * Capitals always come from OSM's capital=yes tag via Overpass (free, one lookup per country).
 */
function Geo_() {
  this.sheet = SpreadsheetApp.getActive().getSheetByName(CFG.GEO_SHEET);
  this.cache = new Map();
  this.pending = [];
  this.calls = 0;
  this.t0 = Date.now();
  this.last = {};                // last request time per service
  this.outOfTime = false;
  this.blocked = false;
  this.key = prop_('GOOGLE_MAPS_KEY');
  this.provider = CFG.GEOCODER === 'google' && this.key ? 'google' : 'nominatim';
  if (CFG.GEOCODER === 'google' && !this.key) log_('geocode', 'GEOCODER is google but GOOGLE_MAPS_KEY is not set → using Nominatim this run');
  const last = this.sheet.getLastRow();
  if (last > 1) this.sheet.getRange(2, 1, last - 1, 2).getValues().forEach(r => {
    try { this.cache.set(String(r[0]), JSON.parse(r[1])); } catch (e) { }
  });
}

/** Wait until the service's minimum gap has passed; false if the run's time budget is spent. */
Geo_.prototype.wait_ = function (service, gapMs) {
  if (this.blocked) return false;
  const since = Date.now() - (this.last[service] || 0);
  const pause = Math.max(0, gapMs - since);
  if (Date.now() - this.t0 + pause > CFG.GEO_TIME_BUDGET_MS) { this.outOfTime = true; return false; }
  if (pause) Utilities.sleep(pause);
  this.last[service] = Date.now();
  this.calls++;
  return true;
};

Geo_.prototype.fetch_ = function (url, opt) {
  const res = UrlFetchApp.fetch(url, Object.assign({
    muteHttpExceptions: true,
    headers: { 'User-Agent': CFG.USER_AGENT, 'Referer': CFG.APP_REFERER, 'Accept-Language': 'en' }
  }, opt || {}));
  const code = res.getResponseCode();
  if (code === 403 || code === 429) {
    this.blocked = true;
    throw new Error('HTTP ' + code + ' (rate-limited or blocked). Geocoding paused until the next run.');
  }
  if (code >= 400) throw new Error('HTTP ' + code);
  return JSON.parse(res.getContentText());
};

/**
 * One lookup with the active provider → normalized place, null (not found)
 * or undefined (out of time / blocked; retried next run).
 * Normalized: { type: country|continent|state|city, name, city, state, country, cc, lat, lng }
 * Pass {q} for free text or {cc} for "this country".
 */
Geo_.prototype.lookup_ = function (p) {
  if (this.provider === 'google') {
    try { return this.google_(p); }
    catch (e) {
      if (this.blocked || /REQUEST_DENIED|OVER_|INVALID/.test(e.message)) {
        log_('geocode', 'Google: ' + e.message + ' → switching to Nominatim for the rest of this run');
        this.provider = 'nominatim'; this.blocked = false;
        return this.nominatim_(p);
      }
      throw e;
    }
  }
  return this.nominatim_(p);
};

Geo_.prototype.google_ = function (p) {
  if (!this.wait_('google', CFG.GOOGLE_GAP_MS)) return undefined;
  let u = 'https://maps.googleapis.com/maps/api/geocode/json?language=en&key=' + enc_(this.key);
  if (p.q) u += '&address=' + enc_(p.q);
  if (p.cc) u += '&components=country:' + enc_(p.cc);
  const j = this.fetch_(u);
  if (j.status === 'ZERO_RESULTS') return null;
  if (j.status !== 'OK') throw new Error(j.status + (j.error_message ? ': ' + j.error_message : ''));
  const g = j.results[0], types = g.types || [];
  const comp = t => (g.address_components || []).find(a => a.types.indexOf(t) >= 0);
  const country = comp('country'), state = comp('administrative_area_level_1');
  const city = comp('locality') || comp('postal_town') || comp('sublocality') || comp('administrative_area_level_2');
  const type = types.indexOf('country') >= 0 ? 'country'
    : !country || types.indexOf('continent') >= 0 ? 'continent'
    : !city && state ? 'state' : 'city';
  return {
    type: type, name: (g.address_components[0] || {}).long_name || g.formatted_address,
    city: city ? city.long_name : '', state: state ? state.long_name : '',
    country: country ? country.long_name : '', cc: country ? country.short_name : '',
    lat: g.geometry.location.lat, lng: g.geometry.location.lng
  };
};

Geo_.prototype.nominatim_ = function (p) {
  if (!this.wait_('nominatim', CFG.NOMINATIM_GAP_MS)) return undefined;
  const qs = p.q ? 'q=' + enc_(p.q) : 'country=' + enc_(p.cc);
  const arr = this.fetch_('https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&accept-language=en&' + qs);
  if (!arr || !arr.length) return null;
  const g = arr[0], a = g.address || {};
  const t = g.addresstype || g.type || '';
  const cc = String(a.country_code || '').toUpperCase();
  const type = t === 'country' ? 'country' : !cc || t === 'continent' ? 'continent'
    : /^(state|province|region|county)$/.test(t) ? 'state' : 'city';
  return {
    type: type, name: g.name, city: a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb || g.name,
    state: a.state || '', country: a.country || '', cc: cc, lat: Number(g.lat), lng: Number(g.lon)
  };
};

Geo_.prototype.remember_ = function (key, val) {
  this.cache.set(key, val);
  this.pending.push([key, JSON.stringify(val)]);
  return val;
};

Geo_.prototype.resolve = function (q, preferCountry) {
  const key = String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!key || key.length < 2) return null;
  const ck = (preferCountry ? 'remote:' : '') + key;
  if (this.cache.has(ck)) return this.cache.get(ck);
  let out = null;
  try {
    const g = this.lookup_({ q: CFG.REGION_WORDS[key] || q });
    if (g === undefined) return null;                        // out of time; not cached → retried next run
    if (g) {
      const at = { lat: g.lat, lng: g.lng };
      if (g.type === 'country') out = this.capital(g.cc, g.country, at);
      else if (g.type === 'continent') out = { level: 'region', city: '', country: g.name || q, cc: '', lat: at.lat, lng: at.lng };
      else if (g.type === 'state') out = { level: 'state', city: g.state || g.name, country: g.country, cc: g.cc, lat: at.lat, lng: at.lng };
      else out = { level: 'city', city: g.city || g.name, country: g.country, cc: g.cc, lat: at.lat, lng: at.lng };
    }
  } catch (e) { log_('geocode', q + ' → ' + e.message); return null; }
  if (out === undefined || (out === null && (this.outOfTime || this.blocked))) return null;   // don't cache half-finished work
  return this.remember_(ck, out);
};

/**
 * Capital of a country (ISO2) from OSM's capital=yes tag via Overpass, cached.
 * Falls back to the country's own point from the geocoder.
 */
Geo_.prototype.capital = function (cc, countryName, fallbackAt) {
  cc = String(cc || '').toUpperCase();
  if (!cc) return null;
  const ck = 'capital:' + cc;
  if (this.cache.has(ck)) return this.cache.get(ck);
  let out;
  try {
    let cap = null;
    try { cap = this.overpassCapital_(cc); }
    catch (e) { log_('capital', cc + ' via Overpass → ' + e.message + ' (using the country point)'); this.blocked = false; }
    if (cap === undefined) return undefined;                 // out of time
    if (cap) out = { level: 'country', city: cap.city, country: cap.country || countryName || cc, cc: cc, lat: cap.lat, lng: cap.lng };
    else {
      let at = fallbackAt, name = countryName;
      if (!at) {
        const g = this.lookup_({ cc: cc });
        if (g === undefined) return undefined;
        if (!g) return this.remember_(ck, null);
        at = { lat: g.lat, lng: g.lng };
        name = name || g.country || g.name;
      }
      out = { level: 'country', city: '', country: name || cc, cc: cc, lat: at.lat, lng: at.lng };
    }
  } catch (e) { log_('capital', cc + ' → ' + e.message); return null; }
  return this.remember_(ck, out);
};

/** Overpass: the country's name and its capital=yes place (largest by population). */
Geo_.prototype.overpassCapital_ = function (cc) {
  if (!this.wait_('overpass', CFG.OVERPASS_GAP_MS)) return undefined;
  const q = '[out:json][timeout:25];' +
    'area["ISO3166-1"="' + cc + '"]["admin_level"="2"]->.a;' +
    '.a out tags;' +
    'node(area.a)["capital"="yes"]["place"];out body 10;';
  const j = this.fetch_('https://overpass-api.de/api/interpreter', { method: 'post', payload: { data: q } });
  const els = j.elements || [];
  const area = els.find(e => e.type === 'area');
  const country = area && area.tags ? (area.tags['name:en'] || area.tags.name) : '';
  const nodes = els.filter(e => e.type === 'node' && e.tags)
    .sort((x, y) => (Number(y.tags.population) || 0) - (Number(x.tags.population) || 0));
  if (!nodes.length) return null;
  const n = nodes[0];
  return { city: n.tags['name:en'] || n.tags.name, country: country, lat: n.lat, lng: n.lon };
};

Geo_.prototype.flush = function () {
  if (!this.pending.length) return;
  this.sheet.getRange(this.sheet.getLastRow() + 1, 1, this.pending.length, 2).setValues(this.pending);
  this.pending = [];
};

// ─────────────────────────────── MANUAL ROWS ────────────────────────────────

/** Rows pasted by hand, and rows not yet geocoded in an earlier run, get completed. */
function enrichManualRows_(sh, geo) {
  const rows = readRows_(sh);
  let changed = 0;
  rows.forEach((r, i) => {
    if (!r.title || r.geoLevel || geo.outOfTime || geo.blocked) return;
    const raw = {
      title: r.title, company: r.company, url: r.url || ('manual-' + i), description: r.description || '',
      locationRaw: r.locationRaw, remoteHint: /remote/i.test(r.workMode || r.locationRaw) ? true : null,
      remoteScopeHint: r.remoteScope || '', source: r.source || 'Manual', postedAt: toDate_(r.postedAt)
    };
    const j = normalize_(raw);
    ['id', 'dedupeKey', 'jobType', 'workMode', 'remoteScope', 'language'].forEach(k => { if (!r[k]) r[k] = j[k]; });
    if (!r.postedAt) r.postedAt = new Date();
    if (!r.fetchedAt) r.fetchedAt = new Date();
    if (!r.source) r.source = 'Manual';
    const tmp = { workMode: r.workMode, remoteScope: r.remoteScope, locationRaw: r.locationRaw, lat: r.lat, lng: r.lng };
    geolocate_(tmp, geo);
    if (!tmp.geoLevel) return;                                  // ran out of time → next run
    Object.assign(r, { city: tmp.city || r.city, country: tmp.country || r.country, countryCode: tmp.countryCode || r.countryCode, lat: tmp.lat, lng: tmp.lng, geoLevel: tmp.geoLevel, workMode: tmp.workMode || r.workMode });
    sh.getRange(i + 2, 1, 1, HEADERS.length).setValues([HEADERS.map(h => r[h] === undefined ? '' : r[h])]);
    changed++;
  });
  geo.flush();
  if (changed) log_('manual rows', 'enriched ' + changed);
}

// ─────────────────────────────── HELPERS ────────────────────────────────────

function ensureSheets_() {
  const ss = SpreadsheetApp.getActive();
  const make = (name, headers) => {
    let sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold'); sh.setFrozenRows(1); }
    return sh;
  };
  make(CFG.GEO_SHEET, ['query', 'result']);
  make(CFG.LOG_SHEET, ['time', 'what', 'message']);
  return make(CFG.JOBS_SHEET, HEADERS);
}

function readRows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues().map(v => {
    const o = {}; HEADERS.forEach((h, i) => o[h] = v[i]); return o;
  });
}

function http_(url, extraHeaders) {
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true, followRedirects: true,
    headers: Object.assign({ 'User-Agent': CFG.USER_AGENT, 'Accept': 'application/json, application/rss+xml, application/xml, */*' }, extraHeaders || {})
  });
  const code = res.getResponseCode();
  if (code >= 400) {
    const why = res.getContentText().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error('HTTP ' + code + ' ← ' + url.replace(/(app_key|key)=[^&]+/g, '$1=***') + (why ? '  ⇒ ' + why : ''));
  }
  return res.getContentText();
}
function json_(url) { return JSON.parse(http_(url)); }
function enc_(s) { return encodeURIComponent(s); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function isNum_(v) { return v !== '' && v !== null && v !== undefined && !isNaN(Number(v)); }
function childText_(el, name) { const c = el.getChild(name); return c ? c.getText() : ''; }
function slug_(s) { return String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

function toDate_(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v < 1e11 ? v * 1000 : v);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function stripHtml_(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&rsquo;/g, "'").replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function salary_(min, max, cur, period) {
  min = Number(min) || 0; max = Number(max) || 0;
  if (!min && !max) return '';
  const f = n => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
  const range = min && max && min !== max ? f(min) + '–' + f(max) : f(min || max);
  return ((cur || '') + ' ' + range + (period && period !== 'annual' ? ' / ' + period : '')).trim();
}

function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s))
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('').slice(0, 14);
}

function log_(what, msg) {
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(CFG.LOG_SHEET);
    if (sh) { sh.appendRow([new Date(), what, String(msg).slice(0, 1000)]); if (sh.getLastRow() > 500) sh.deleteRows(2, 100); }
  } catch (e) { }
  console.log(what + ': ' + msg);
}
