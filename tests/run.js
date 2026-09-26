/**
 * Offline tests for apps-script/Code.gs.
 * Runs the Apps Script file in Node with the Google services stubbed out and
 * every network call answered by a mock, so nothing is fetched and no quota is used.
 *
 *   node tests/run.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      got: ' + JSON.stringify(detail) : '')); }
}

/** In-memory spreadsheet: enough of SpreadsheetApp for Code.gs (tabs, ranges, checkboxes, validation). */
function fakeSpreadsheet(initial) {
  const sheets = {}, toasts = [];
  const blank = v => v === '' || v === null || v === undefined;
  function makeSheet(name, data) {
    const d = data || [];
    const sh = {
      _data: d, _validations: {}, _checkboxes: {},
      getName: () => name,
      getLastRow: () => { for (let i = d.length; i > 0; i--) if ((d[i - 1] || []).some(v => !blank(v))) return i; return 0; },
      getLastColumn: () => d.reduce((m, r) => { let n = 0; (r || []).forEach((v, i) => { if (!blank(v)) n = i + 1; }); return Math.max(m, n); }, 0),
      getRange: (row, col, nr = 1, nc = 1) => makeRange(sh, d, row, col, nr, nc),
      setFrozenRows() {}, setColumnWidth() {},
      appendRow: r => { d[sh.getLastRow()] = r.slice(); },
      deleteRows() {}
    };
    return sh;
  }
  function makeRange(sh, d, row, col, nr, nc) {
    const each = f => { for (let i = 0; i < nr; i++) { d[row - 1 + i] = d[row - 1 + i] || []; for (let j = 0; j < nc; j++) f(row - 1 + i, col - 1 + j); } };
    const r = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (d[row - 1 + i] || [])[col - 1 + j]; return v === undefined ? '' : v; })),
      setValues: vals => { vals.forEach((rv, i) => { d[row - 1 + i] = d[row - 1 + i] || []; rv.forEach((v, j) => { d[row - 1 + i][col - 1 + j] = v; }); }); return r; },
      setValue: v => r.setValues([[v]]),
      setFontWeight: () => r, setNumberFormat: () => r, setWrap: () => r,
      setDataValidation: v => { sh._validations[row + ',' + col] = v; return r; },
      insertCheckboxes: () => { each((i, j) => { d[i][j] = false; sh._checkboxes[(i + 1) + ',' + (j + 1)] = true; }); return r; },
      clearContent: () => { each((i, j) => { d[i][j] = ''; }); return r; },
      getSheet: () => sh
    };
    return r;
  }
  Object.keys(initial).forEach(n => { sheets[n] = makeSheet(n, initial[n]); });
  return {
    _sheets: sheets, _toasts: toasts,
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n, [])),
    toast: m => { toasts.push(m); }
  };
}

/** Fresh sandbox with Apps Script globals stubbed. `net(url, opts)` answers every fetch. */
function sandbox({ props = {}, net = () => ({ code: 404, body: '' }), tabs = {} } = {}) {
  const logs = [];
  let clock = 1_800_000_000_000;
  const ss = fakeSpreadsheet(Object.assign({
    Jobs: [['id', 'dedupeKey', 'title']], GeoCache: [['query', 'result']], Log: [['time', 'what', 'message']]
  }, tabs));
  const cacheStore = {}, triggers = [];
  const validation = () => {
    const b = { requireValueInList(l) { b.list = l; return b; }, requireCheckbox() { b.checkbox = true; return b; },
      setAllowInvalid() { return b; }, build() { return { list: b.list, checkbox: !!b.checkbox }; } };
    return b;
  };
  const ctx = {
    console: { log() {} },
    Date: class extends Date {
      constructor(...a) { a.length ? super(...a) : super(clock); }
      static now() { return clock; }
    },
    Utilities: {
      sleep: ms => { clock += ms; },
      DigestAlgorithm: { MD5: 'md5' },
      computeDigest: (_a, s) => [...crypto.createHash('md5').update(String(s)).digest()].map(b => (b > 127 ? b - 256 : b))
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
    SpreadsheetApp: { getActive: () => ss, newDataValidation: validation },
    CacheService: { getScriptCache: () => ({
      get: k => (k in cacheStore ? cacheStore[k] : null), put: (k, v) => { cacheStore[k] = v; }, remove: k => { delete cacheStore[k]; },
      putAll: values => { Object.keys(values).forEach(k => { cacheStore[k] = values[k]; }); },
      removeAll: keys => { keys.forEach(k => { delete cacheStore[k]; }); } }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: fn => {
        const t = { fn, getHandlerFunction: () => fn };
        const b = { timeBased: () => b, everyHours: n => { t.everyHours = n; return b; }, everyDays: n => { t.everyDays = n; return b; },
          atHour: h => { t.atHour = h; return b; }, create: () => { triggers.push(t); return t; } };
        return b;
      }
    },
    UrlFetchApp: {
      fetch: (url, opts = {}) => {
        clock += 50;
        const r = net(url, opts) || { code: 404, body: '' };
        const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        return { getResponseCode: () => r.code || 200, getContentText: () => body };
      }
    },
    ContentService: {
      MimeType: { JSON: 'json', JAVASCRIPT: 'javascript' },
      createTextOutput: text => ({ text, setMimeType(m) { this.mime = m; return this; } })
    },
    HtmlService: { createHtmlOutputFromFile: () => { throw new Error('no Index file'); } }
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: 'Code.gs' });
  ctx.log_ = (what, msg) => logs.push(what + ' | ' + msg);
  ctx.hash_ = s => crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 14);
  ctx._logs = logs;
  ctx._ss = ss;
  ctx._cache = cacheStore;
  ctx._triggers = triggers;
  return ctx;
}
const run = (ctx, src) => vm.runInContext(src, ctx);

// ───────────────────────────────────────────────────────────────────────────
console.log('\nClassification');
{
  const c = sandbox();
  const cls = r => {
    const d = r.description || '';
    const w = c.classifyWorkMode_(r, d);
    return { type: c.classifyJobType_(r.jobTypeHint, r.title + ' ' + d), mode: w.mode, scope: w.scope,
      lang: c.detectLang_(r.title + ' ' + d), geo: c.isGeoJob_(r) };
  };
  let x = cls({ title: 'Senior GIS Developer', description: 'Join our team in Dubai. Full time.', locationRaw: 'Dubai, UAE' });
  check('on-site permanent GIS job', x.type === 'permanent' && x.mode === 'onsite' && x.geo, x);
  x = cls({ title: 'Geospatial Engineer', description: 'Remote, USA only. 6 month contract', remoteHint: true, remoteScopeHint: 'USA' });
  check('remote in one country, contract', x.type === 'contract' && x.mode === 'remote-country' && x.scope === 'USA', x);
  x = cls({ title: 'GIS-Entwickler (m/w/d)', description: 'Wir suchen für unser Team in München einen Entwickler mit ArcGIS. Hybrid, 2 Tage im Büro.' });
  check('German hybrid post', x.lang === 'de' && x.mode === 'hybrid', x);
  x = cls({ title: 'Freelance QGIS plugin dev', description: 'hourly rate, work from anywhere', remoteHint: true, remoteScopeHint: 'Worldwide' });
  check('freelance, remote worldwide', x.type === 'freelance' && x.mode === 'remote-worldwide', x);
  x = cls({ title: 'مطور نظم المعلومات الجغرافية', description: 'نبحث عن مطور نظم المعلومات الجغرافية للعمل في الرياض' });
  check('Arabic post detected and kept', x.lang === 'ar' && x.geo, x);
  x = cls({ title: 'Frontend developer', description: 'React and TypeScript' });
  check('non-GIS job filtered out', x.geo === false, x);
  x = cls({ title: 'GIS Analyst', description: 'Great team.', workArrangement: 'hybrid', remoteHint: true });
  check('JSearch work_arrangement=hybrid wins over remote flag', x.mode === 'hybrid', x);
}

console.log('\nLocation splitting');
{
  const c = sandbox();
  check('remote scope list is split', JSON.stringify(c.splitLocations_('USA, Canada', true)) === JSON.stringify(['USA', 'Canada', 'USA, Canada']), c.splitLocations_('USA, Canada', true));
  check('on-site address kept whole', JSON.stringify(c.splitLocations_('Austin, TX', false)) === JSON.stringify(['Austin, TX']), c.splitLocations_('Austin, TX', false));
  check('multiple locations split on ;', c.splitLocations_('London, UK; Berlin, Germany', false).length === 2);
}

// ───────────────────────────────────────────────────────────────────────────
// Mock geocoders
const C = (t, l, s) => ({ long_name: l, short_name: s || l, types: [t, 'political'] });
const GOOGLE = {
  'dubai, uae': { types: ['locality'], address_components: [C('locality', 'Dubai'), C('country', 'United Arab Emirates', 'AE')], geometry: { location: { lat: 25.2, lng: 55.27 } } },
  'usa': { types: ['country', 'political'], address_components: [C('country', 'United States', 'US')], geometry: { location: { lat: 38.8, lng: -98.5 } } },
  'europe': { types: ['continent', 'political'], address_components: [C('continent', 'Europe')], formatted_address: 'Europe', geometry: { location: { lat: 54.5, lng: 15.2 } } },
  'california': { types: ['administrative_area_level_1'], address_components: [C('administrative_area_level_1', 'California', 'CA'), C('country', 'United States', 'US')], geometry: { location: { lat: 36.7, lng: -119.4 } } }
};
const OVERPASS = {
  US: [{ type: 'area', tags: { 'name:en': 'United States' } }, { type: 'node', lat: 38.8948, lon: -77.0365, tags: { name: 'Washington', population: '689545' } }],
  AE: [{ type: 'area', tags: { 'name:en': 'United Arab Emirates' } }, { type: 'node', lat: 24.4539, lon: 54.3773, tags: { name: 'Abu Dhabi', population: '1500000' } }]
};
function geoNet(state) {
  return (url, opts) => {
    if (url.includes('overpass')) {
      state.overpass = (state.overpass || 0) + 1;
      const cc = opts.payload.data.match(/"ISO3166-1"="(\w+)"/)[1];
      return { body: { elements: OVERPASS[cc] || [] } };
    }
    if (url.includes('maps.googleapis.com')) {
      state.google = (state.google || 0) + 1;
      if (state.googleStatus) return { body: { status: state.googleStatus, error_message: 'mock' } };
      const q = new URL(url);
      const r = GOOGLE[(q.searchParams.get('address') || '').toLowerCase()];
      return { body: r ? { status: 'OK', results: [r] } : { status: 'ZERO_RESULTS', results: [] } };
    }
    if (url.includes('nominatim')) {
      state.nominatim = (state.nominatim || 0) + 1;
      return { body: [{ lat: '48.85', lon: '2.35', addresstype: 'city', name: 'Paris', address: { city: 'Paris', country: 'France', country_code: 'fr' } }] };
    }
    if (url.includes('jsearch') || url.includes('openwebninja')) {
      state.jsearchUrls = (state.jsearchUrls || []).concat(url);
      return { body: fs.readFileSync(path.join(__dirname, 'fixtures', 'jsearch-search-v2.json'), 'utf8') };
    }
    return { code: 404, body: '' };
  };
}
const place = (c, job) => { job.lat = job.lat ?? ''; job.lng = job.lng ?? ''; c.geolocate_(job, c._geo); return job; };

console.log('\nGeocoding: Google primary');
{
  const s = {};
  const c = sandbox({ props: { GOOGLE_MAPS_KEY: 'test' }, net: geoNet(s) });
  c._geo = new c.Geo_();
  check('provider is google', c._geo.provider === 'google');
  let j = place(c, { workMode: 'onsite', locationRaw: 'Dubai, UAE' });
  check('city → city pin', j.city === 'Dubai' && j.countryCode === 'AE' && j.geoLevel === 'city', j);
  j = place(c, { workMode: 'remote-country', remoteScope: 'USA' });
  check('country only → capital from Overpass', j.city === 'Washington' && j.geoLevel === 'country' && j.lat === 38.8948, j);
  j = place(c, { workMode: 'remote-country', remoteScope: 'EMEA' });
  check('region word → region', j.geoLevel === 'region' && j.country === 'Europe', j);
  j = place(c, { workMode: 'remote-country', remoteScope: 'California' });
  check('state stays a state (not the capital)', j.geoLevel === 'state' && j.city === 'California', j);
  j = place(c, { workMode: 'remote-country', remoteScope: 'US', locationRaw: 'US', lat: 37.09, lng: -95.71, countryCode: 'US' });
  check('board coords with no city → capital, scope expanded', j.city === 'Washington' && j.remoteScope === 'United States', j);
  check('capital looked up once and cached', s.overpass === 1, s);
  j = place(c, { workMode: 'remote-worldwide' });
  check('worldwide has no coordinates', j.geoLevel === 'worldwide' && j.lat === '', j);
}

console.log('\nGeocoding: fallback to Nominatim');
{
  const s = { googleStatus: 'REQUEST_DENIED' };
  const c = sandbox({ props: { GOOGLE_MAPS_KEY: 'bad' }, net: geoNet(s) });
  c._geo = new c.Geo_();
  const j = place(c, { workMode: 'onsite', locationRaw: 'Paris' });
  check('refused key → switches to Nominatim and still places the job', c._geo.provider === 'nominatim' && j.city === 'Paris', j);
  check('switch is logged', c._logs.some(l => /switching to Nominatim/.test(l)), c._logs);

  const c2 = sandbox({ props: {}, net: geoNet({}) });
  const g2 = new c2.Geo_();
  check('no key → Nominatim', g2.provider === 'nominatim');
}

console.log('\nGeocoding: Nominatim rate limit and time budget');
{
  const s = {};
  const c = sandbox({ props: {}, net: geoNet(s) });
  run(c, 'CFG.GEOCODER = "nominatim"');
  c._geo = new c.Geo_();
  let done = 0, left = 0;
  for (let i = 0; i < 20; i++) {
    const j = place(c, { workMode: 'onsite', locationRaw: 'Town ' + i });
    j.geoLevel === '' ? left++ : done++;
  }
  check('4-minute budget at 4/min: ~16 lookups, the rest wait for the next run', done >= 15 && done <= 17 && left === 20 - done, { done, left });
  check('unfinished places are not cached (retried next run)', !c._geo.cache.has('town 19'));
}

console.log('\nJSearch (search-v2)');
{
  const s = {};
  const c = sandbox({ props: { JSEARCH_RAPIDAPI_KEY: 'test' }, net: geoNet(s) });
  const raws = c.src_jsearch_();
  const q = run(c, 'CFG.JSEARCH_QUERIES.length');
  check('one request per query', s.jsearchUrls.length === q, s.jsearchUrls.length);
  check('calls /search-v2', s.jsearchUrls.every(u => u.includes('/search-v2?')), s.jsearchUrls[0]);
  check('country is sent for non-US queries', s.jsearchUrls.some(u => /[?&]country=ae\b/.test(u)), s.jsearchUrls);
  const first = raws.filter(r => r.url.includes('0000000001'))[0];
  check('publisher becomes the source', first.source === 'LinkedIn' && first.sourceHome.includes('linkedin.com'), first);
  const kept = raws.filter(r => c.isGeoJob_(r)).map(r => r.title);
  check('GIS filter keeps the geo jobs and drops the frontend one', kept.includes('Senior GIS Developer') && !kept.includes('Frontend Developer'), kept);
  const eng = c.normalize_(raws.find(r => /Geospatial Data Engineer/.test(r.title)));
  check('contract + remote via work_arrangement', eng.jobType === 'contract' && eng.workMode === 'remote-country', { type: eng.jobType, mode: eng.workMode });
  check('hourly salary formatted', /USD 60–80 \/ hour/.test(eng.salary), eng.salary);
  check('nested data.jobs response also parses', c.jsearchJobs_({ data: { jobs: [1, 2] } }).length === 2);
}

console.log('\nWeb endpoint');
{
  const c = sandbox();
  c.getJobs = () => ({ count: 0, jobs: [] });
  let out = c.doGet({ parameter: { callback: 'geojobsData_123' } });
  check('JSONP wraps data in the callback', out.mime === 'javascript' && out.text.startsWith('geojobsData_123('), out.text.slice(0, 40));
  out = c.doGet({ parameter: { callback: 'alert(1)//' } });
  check('callback name is sanitized', out.text.startsWith('alert1('), out.text.slice(0, 20));
  out = c.doGet({ parameter: { format: 'json' } });
  check('?format=json returns JSON', out.mime === 'json');
  out = c.doGet({ parameter: {} });
  check('no Index file → returns JSON instead of an error', out.mime === 'json');
}

// ───────────────────────────────────────────────────────────────────────────
// Settings in the sheet
const tab = (c, name) => c._ss._sheets[name];
const rowsOf = (c, name) => tab(c, name)._data.slice(1).filter(r => r && r.some(v => v !== '' && v !== null && v !== undefined));
function setKV(c, name, key, value) {
  const d = tab(c, name)._data;
  const i = d.findIndex((r, n) => n > 0 && r && String(r[0]).toUpperCase() === key);
  if (i < 0) d.push([key, value]); else d[i][1] = value;
}
const has = (c, re) => c._logs.some(l => re.test(l));

console.log('\nSettings: setup creates the tabs');
{
  const c = sandbox();
  c.setup();
  const names = ['Config', 'Keywords', 'Feeds', 'JSearchQueries', 'Sources', 'RegionWords', 'MapConfig'];
  check('all settings tabs exist', names.every(n => tab(c, n)), Object.keys(c._ss._sheets));
  const cfgKeys = rowsOf(c, 'Config').map(r => r[0]);
  check('Config lists every setting', cfgKeys.includes('MAX_AGE_DAYS') && cfgKeys.includes('JSEARCH_HOUR') && cfgKeys.length === 15, cfgKeys);
  check('Config holds the defaults', rowsOf(c, 'Config').find(r => r[0] === 'GEOCODER')[1] === 'google');
  check('list settings written as text', rowsOf(c, 'Config').find(r => r[0] === 'ADZUNA_QUERIES')[1] === 'gis, geospatial');
  check('dropdown on choice settings', Object.values(tab(c, 'Config')._validations).some(v => v.list && v.list.includes('nominatim')));
  check('keywords seeded, enabled', rowsOf(c, 'Keywords').length === run(c, 'CFG_DEFAULTS.KEYWORDS.length') && rowsOf(c, 'Keywords').every(r => r[1] === true));
  check('checkboxes inserted', Object.keys(tab(c, 'Keywords')._checkboxes).length > 0);
  check('feeds seeded with flags', JSON.stringify(rowsOf(c, 'Feeds')[1].slice(3, 6)) === '[true,true,true]', rowsOf(c, 'Feeds')[1]);
  check('JSearch queries seeded, UAE with country', rowsOf(c, 'JSearchQueries').some(r => r[0] === 'GIS developer' && r[1] === 'ae'));
  check('every source listed', rowsOf(c, 'Sources').length === run(c, 'SOURCES.length'));
  check('MapConfig anchor as JSON text', rowsOf(c, 'MapConfig').find(r => r[0] === 'WORLD_ANCHOR')[1] === '[-33,16]');
  const t = c._triggers.map(x => x.fn + ':' + (x.everyHours || '') + (x.atHour !== undefined ? '@' + x.atHour : '')).sort();
  check('triggers from defaults', JSON.stringify(t) === JSON.stringify(['cleanupOld:@3', 'runFetch:6', 'runJSearch:@7']), t);
  check('no warnings for the defaults', !has(c, /^settings \|.*(unknown|must|invalid|secret)/i), c._logs);

  // edits survive a second setup; a missing setting is added back
  setKV(c, 'Config', 'MAX_AGE_DAYS', 30);
  tab(c, 'Keywords')._data.push(['drone', true, 'mine']);
  const d = tab(c, 'Config')._data; d.splice(d.findIndex(r => r && r[0] === 'DESC_CHARS'), 1);
  c.setup();
  check('re-running setup keeps edited values', rowsOf(c, 'Config').find(r => r[0] === 'MAX_AGE_DAYS')[1] === 30);
  check('re-running setup keeps added rows', rowsOf(c, 'Keywords').some(r => r[0] === 'drone'));
  check('re-running setup restores a deleted setting', rowsOf(c, 'Config').filter(r => r[0] === 'DESC_CHARS').length === 1);
  check('triggers replaced, not duplicated', c._triggers.length === 3, c._triggers.length);
}

console.log('\nSettings: values from the sheet');
{
  const c = sandbox();
  c.setup();
  setKV(c, 'Config', 'MAX_AGE_DAYS', '30');            // typed as text
  setKV(c, 'Config', 'GEOCODER', 'Nominatim');         // any case
  setKV(c, 'Config', 'FETCH_EVERY_HOURS', 5);          // not allowed by Apps Script
  setKV(c, 'Config', 'NOMINATIM_GAP_MS', 1000);        // below the OSM policy
  setKV(c, 'Config', 'ADZUNA_COUNTRIES', 'ae; sa');
  setKV(c, 'Config', 'FOO', 1);                        // unknown
  setKV(c, 'Config', 'GOOGLE_MAPS_KEY', 'AIzaSECRET'); // secret in the sheet
  setKV(c, 'MapConfig', 'DEFAULT_THEME', 'light');
  setKV(c, 'MapConfig', 'WORLD_ANCHOR', '[200, 0]');
  const p = c.loadConfig_({ fresh: true });
  const C = k => run(c, 'CFG.' + k);
  check('number typed as text is accepted', C('MAX_AGE_DAYS') === 30, C('MAX_AGE_DAYS'));
  check('choice is case-insensitive', C('GEOCODER') === 'nominatim');
  check('invalid hours → default kept + warning', C('FETCH_EVERY_HOURS') === 6 && p.warnings.some(w => /FETCH_EVERY_HOURS must be one of/.test(w)), p.warnings);
  check('below OSM policy → default kept', C('NOMINATIM_GAP_MS') === 15000 && p.warnings.some(w => /NOMINATIM_GAP_MS must be at least 15000/.test(w)));
  check('list accepts ; separators', JSON.stringify(C('ADZUNA_COUNTRIES')) === '["ae","sa"]', C('ADZUNA_COUNTRIES'));
  check('unknown setting reported', p.warnings.some(w => /unknown setting "FOO"/.test(w)));
  check('secret in the sheet ignored and reported', p.warnings.some(w => /GOOGLE_MAPS_KEY looks like a secret/.test(w)) && run(c, 'CFG.GOOGLE_MAPS_KEY') === undefined);
  check('warnings written to the Log', has(c, /^settings \| Config row \d+: FOO|^settings \| Config row \d+: unknown setting "FOO"/));
  check('map theme from MapConfig', C('MAP.DEFAULT_THEME') === 'light');
  check('bad anchor → default kept', JSON.stringify(C('MAP.WORLD_ANCHOR')) === '[-33,16]' && p.warnings.some(w => /WORLD_ANCHOR must be/.test(w)));
  const out = c.getJobs();
  check('map settings sent with the data', out.config && out.config.DEFAULT_THEME === 'light' && out.config.ZOOM_CITY === 10, out.config);
}

console.log('\nSettings: list tabs');
{
  const c = sandbox();
  c.setup();
  const kw = tab(c, 'Keywords')._data;
  kw.slice(1).forEach(r => { if (r) r[1] = false; });   // untick every default keyword
  kw.push(['drone', true, '']); kw.push(['([', true, 'broken']);
  const feeds = tab(c, 'Feeds')._data;
  feeds[2][5] = false;                                  // switch off We Work Remotely
  feeds.push(['Broken', 'ftp://nope', '', true, false, true]);
  const js = tab(c, 'JSearchQueries')._data;
  js.push(['GIS analyst', 'uae', true]);                // bad country
  js.push(['GIS analyst', 'sa', true]);
  const src = tab(c, 'Sources')._data;
  src.find(r => r && r[0] === 'Remotive')[1] = false;
  src.push(['Monster', true, '']);
  tab(c, 'RegionWords')._data.push(['dach', 'Germany']);
  const p = c.loadConfig_({ fresh: true });
  check('only enabled keywords are used', run(c, 'CFG.KEYWORDS.join("|")') === 'drone', run(c, 'CFG.KEYWORDS'));
  check('invalid regex skipped and reported', p.warnings.some(w => /"\(\[" is not a valid regular expression/.test(w)));
  check('filter follows the sheet', c.isGeoJob_({ title: 'Drone pilot' }) && !c.isGeoJob_({ title: 'GIS analyst' }));
  check('unticked feed dropped', run(c, 'CFG.RSS_FEEDS.map(f => f.name).join()') === 'GIS Jobs Clearinghouse', run(c, 'CFG.RSS_FEEDS'));
  check('bad feed url reported', p.warnings.some(w => /Feeds row \d+: url must start/.test(w)));
  check('feed flags read from checkboxes', run(c, 'CFG.RSS_FEEDS[0].filter') === false && run(c, 'CFG.RSS_FEEDS[0].remote') === null);
  check('bad country skipped, good one kept', p.warnings.some(w => /country must be a 2-letter code/.test(w)) && run(c, 'JSON.stringify(CFG.JSEARCH_QUERIES[CFG.JSEARCH_QUERIES.length-1])') === '{"query":"GIS analyst","country":"sa"}');
  check('JSearch quota warning over 200/month', p.warnings.some(w => /7 enabled queries ≈ 217 requests a month/.test(w)), p.warnings);
  check('source switched off', run(c, 'CFG.DISABLED_SOURCES.join()') === 'Remotive');
  check('unknown source reported', p.warnings.some(w => /unknown source "Monster"/.test(w)));
  check('region word added', run(c, 'CFG.REGION_WORDS.dach') === 'Germany' && run(c, 'CFG.REGION_WORDS.emea') === 'Europe');
  c.testSources();
  check('switched-off source is skipped by testSources', has(c, /test Remotive \| switched off in the Sources tab/));
}

console.log('\nSettings: cache, edits, schedule');
{
  const c = sandbox();
  c.setup();
  setKV(c, 'Config', 'MAX_AGE_DAYS', 20);
  c.loadConfig_({ fresh: true });                     // reads the sheet, fills the cache
  setKV(c, 'Config', 'MAX_AGE_DAYS', 10);
  run(c, '_cfgLoaded = false');                        // a new execution
  c.loadConfig_();
  check('cached settings are reused', run(c, 'CFG.MAX_AGE_DAYS') === 20);
  c.onEdit({ range: { getSheet: () => ({ getName: () => 'Config' }) } });
  run(c, '_cfgLoaded = false');
  c.loadConfig_();
  check('editing a settings tab clears the cache', run(c, 'CFG.MAX_AGE_DAYS') === 10);
  c.onEdit({ range: { getSheet: () => ({ getName: () => 'Jobs' }) } });
  check('editing the Jobs tab leaves the cache alone', Object.keys(c._cache).length === 1);

  setKV(c, 'Config', 'FOO', 1);
  c._logs.length = 0;
  run(c, '_cfgLoaded = false'); c.onEdit({ range: { getSheet: () => ({ getName: () => 'Config' }) } });
  c.getJobs();
  check('web requests don\'t write warnings to the Log', !has(c, /unknown setting/));

  setKV(c, 'Config', 'FETCH_EVERY_HOURS', 12);
  setKV(c, 'Config', 'JSEARCH_HOUR', 5);
  c.applySchedule();
  const t = c._triggers.map(x => x.fn + ':' + (x.everyHours || '') + (x.atHour !== undefined ? '@' + x.atHour : '')).sort();
  check('Apply schedule rebuilds triggers from the sheet', JSON.stringify(t) === JSON.stringify(['cleanupOld:@3', 'runFetch:12', 'runJSearch:@5']), t);
  check('the user sees a confirmation', c._ss._toasts.some(m => /every 12 h, JSearch daily at 5:00/.test(m)), c._ss._toasts);
  c.checkSettings();
  check('Check settings reports problems', c._ss._toasts.some(m => /1 setting\(s\) need attention/.test(m)), c._ss._toasts);
}

console.log('\nSettings: no tabs yet');
{
  const c = sandbox();
  const p = c.loadConfig_({ fresh: true });
  check('without settings tabs the defaults apply silently', p.warnings.length === 0 && run(c, 'CFG.MAX_AGE_DAYS') === 45 && run(c, 'CFG.KEYWORDS.length') > 30);
}

console.log('\nJobs cache');
{
  const c = sandbox();
  c.setup();
  const H = run(c, 'HEADERS');
  const row = o => H.map(h => (h in o ? o[h] : ''));
  const jd = tab(c, 'Jobs')._data;

  jd.push(row({ id: 'a', dedupeKey: 'a', title: 'GIS Analyst', company: 'Acme', source: 'Board', url: 'https://x/a' }));
  const out1 = c.getJobs();
  check('first call reads the sheet', out1.jobs.length === 1 && out1.jobs[0].title === 'GIS Analyst', out1.jobs);
  check('the payload is cached, chunked', c._cache['geojobs:jobs:v1:n'] === '1' && typeof c._cache['geojobs:jobs:v1:0'] === 'string');

  jd.push(row({ id: 'b', dedupeKey: 'b', title: 'Remote Sensing Engineer', company: 'Orbit', source: 'Board', url: 'https://x/b' }));
  const out2 = c.getJobs();
  check('a second call is served from the cache, not the sheet', out2.jobs.length === 1, out2.jobs.length);

  c.invalidateJobsCache_();
  check('invalidating removes every chunk', !('geojobs:jobs:v1:n' in c._cache));
  const out3 = c.getJobs();
  check('after invalidation the next call re-reads the sheet', out3.jobs.length === 2, out3.jobs.length);

  // cleanupOld invalidates the cache itself once it actually removes a row
  jd[jd.length - 1][H.indexOf('postedAt')] = run(c, 'new Date(Date.now() - 60 * 864e5)');   // 60 days old
  c.cleanupOld();
  const out4 = c.getJobs();
  check('cleanupOld invalidates the cache when it removes a job', out4.jobs.length === 1, out4.jobs.length);

  // a payload bigger than one chunk is split and reassembled correctly
  c.invalidateJobsCache_();
  const bigDesc = 'x'.repeat(30000);
  jd.push(row({ id: 'c', dedupeKey: 'c', title: 'Big Description Job', company: 'Big Co', source: 'Board', url: 'https://x/c', description: bigDesc }));
  const out5 = c.getJobs();
  const n = Number(c._cache['geojobs:jobs:v1:n']);
  check('a large payload is split into more than one chunk', n > 1, n);
  check('every chunk stays under the 100 KB cache limit', Object.keys(c._cache).filter(k => /^geojobs:jobs:v1:\d+$/.test(k)).every(k => Buffer.byteLength(c._cache[k], 'utf8') < 100000));
  check('chunks reassemble into the original payload', out5.jobs.some(j => j.description === bigDesc));

  // a missing/expired chunk falls back to a fresh read instead of throwing
  delete c._cache['geojobs:jobs:v1:1'];
  const out6 = c.getJobs();
  check('a missing chunk falls back to a full read', out6.jobs.some(j => j.description === bigDesc));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
