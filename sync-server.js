/**
 * Anaya's Calendar — Sync Server (v2)
 * Multi-key storage: each key gets its own slot in the JSON file.
 * GET /load?key=xxx  returns data for that specific key
 * POST /save         { key, data, savedBy } saves under that key
 * GET /keys          lists all stored keys + metadata (admin debug)
 */
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app     = express();
const PORT    = process.env.PORT || 3000;
const DATA_DIR  = fs.existsSync('/data') ? '/data' : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'anaya-calendar.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Helpers ──────────────────────────────────────────────────────────────────

function readStore() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Migrate: if old format (has top-level .key and .data), wrap it
    if (parsed.key && parsed.data) {
      console.log(`[migrate] Converting old single-key format (key="${parsed.key}") to multi-key store`);
      return { [parsed.key]: { data: parsed.data, savedBy: parsed.savedBy || 'Unknown', savedAt: parsed.savedAt } };
    }
    return parsed;
  } catch(e) {
    console.error('[readStore] Parse error:', e.message);
    return {};
  }
}

function writeStore(store) {
  // Rolling backups before every write
  try {
    if (fs.existsSync(DATA_FILE + '.bak1')) fs.copyFileSync(DATA_FILE + '.bak1', DATA_FILE + '.bak2');
    if (fs.existsSync(DATA_FILE + '.bak0')) fs.copyFileSync(DATA_FILE + '.bak0', DATA_FILE + '.bak1');
    if (fs.existsSync(DATA_FILE))           fs.copyFileSync(DATA_FILE,           DATA_FILE + '.bak0');
  } catch(e) {}
  fs.writeFileSync(DATA_FILE, JSON.stringify(store));
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const store = readStore();
  const keys  = Object.keys(store);
  const size  = fs.existsSync(DATA_FILE) ? (fs.statSync(DATA_FILE).size / 1024).toFixed(1) + ' KB' : 'empty';
  res.json({
    status: 'online',
    app: "Anaya's Calendar Sync Server v2",
    dataFile: `anaya-calendar.json (${size})`,
    persistent: fs.existsSync('/data'),
    storedKeys: keys.map(k => ({
      key: k,
      savedAt: store[k].savedAt,
      savedBy: store[k].savedBy,
    })),
    endpoints: { save: 'POST /save  {key,data,savedBy}', load: 'GET /load?key=xxx', keys: 'GET /keys' }
  });
});

// List all keys (handy for debugging)
app.get('/keys', (req, res) => {
  const store = readStore();
  res.json(Object.entries(store).map(([k, v]) => ({
    key: k,
    savedAt: v.savedAt,
    savedBy: v.savedBy,
    sizeKB: (JSON.stringify(v.data).length / 1024).toFixed(1),
  })));
});

app.post('/save', (req, res) => {
  try {
    const { key, data, savedBy } = req.body;
    if (!key || !data) return res.status(400).json({ error: 'Missing key or data' });

    const store = readStore();
    store[key] = { data, savedBy: savedBy || 'Unknown', savedAt: new Date().toISOString() };
    writeStore(store);

    const sizeKB = (JSON.stringify(data).length / 1024).toFixed(1);
    console.log(`[${new Date().toLocaleTimeString()}] SAVE key="${key}" by ${savedBy || 'Unknown'} — ${sizeKB} KB`);
    res.json({ ok: true, savedAt: store[key].savedAt, savedBy: store[key].savedBy });
  } catch (err) {
    console.error('[save]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/load', (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'Missing ?key= param' });

    const store = readStore();
    if (!store[key]) {
      console.log(`[${new Date().toLocaleTimeString()}] LOAD key="${key}" — NOT FOUND (stored: ${Object.keys(store).join(', ') || 'none'})`);
      return res.json({ ok: false, reason: `No data saved for key "${key}"` });
    }

    const entry = store[key];
    const sizeKB = (JSON.stringify(entry.data).length / 1024).toFixed(1);
    console.log(`[${new Date().toLocaleTimeString()}] LOAD key="${key}" savedAt=${entry.savedAt} — ${sizeKB} KB`);
    res.json({ ok: true, data: entry.data, savedAt: entry.savedAt, savedBy: entry.savedBy || 'Unknown' });
  } catch (err) {
    console.error('[load]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Property Lookup — server-side proxy to avoid CORS ────────────────────────
// GET /property?address=123+Main+St&zip=92505
const https = require('https');
const http  = require('http');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'AnayaPropertyLookup/1.0', 'Accept': 'application/json, text/plain, */*' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Some APIs return 200 with error text instead of JSON
        const trimmed = data.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
          reject(new Error('Non-JSON: ' + trimmed.slice(0, 80)));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse failed: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function detectCounty(zip, addr) {
  const z = zip || '';
  const a = (addr || '').toLowerCase();
  if (/^92[2-5]/.test(z) || /^928[0-3]/.test(z)) return 'riverside';
  if (/^92[6-9]/.test(z)) return 'orange';
  if (/^917/.test(z) || (/^92[3-5]/.test(z) && (
    a.includes('san bernardino') || a.includes('fontana') || a.includes('ontario') ||
    a.includes('rancho cucamonga') || a.includes('rialto') || a.includes('victorville')
  ))) return 'sanbernardino';
  if (/^90/.test(z) || /^91[0-8]/.test(z)) return 'la';
  return 'riverside';
}

// Mirrors the client-side lookupArcGIS exactly
async function arcgisLookup(baseUrl, layer, streetField, streetAddr) {
  const houseNum   = streetAddr.replace(/\D/g, '').slice(0, 6);
  const streetName = streetAddr.replace(/^\d+\s*/, '').trim().toUpperCase();
  const firstWord  = streetName.split(' ')[0];
  const where      = `${streetField} LIKE '${houseNum} ${firstWord}%'`;
  // Match client: baseUrl + layer + '/query?' + URLSearchParams
  const params = new URLSearchParams({ where, outFields: '*', f: 'json', resultRecordCount: 1 });
  const url = baseUrl + layer + '/query?' + params.toString();
  const data = await fetchUrl(url);
  const feat = (data.features || [])[0];
  return (feat && feat.attributes) ? feat.attributes : null;
}

app.get('/property', async (req, res) => {
  const { address, zip } = req.query;
  if (!address) return res.status(400).json({ error: 'Missing address param' });

  const county = detectCounty(zip, address);
  console.log(`[property] address="${address}" zip="${zip}" → county=${county}`);

  let det = {};
  let source = '';

  try {
    if (county === 'la') {
      // Mirrors client-side lookupLA exactly
      const params = new URLSearchParams({
        houseNum:    address.replace(/[^0-9]/g, '').slice(0, 6),
        streetName:  address.replace(/^[0-9]+\s*/, '').split(' ')[0],
        unitNum:     '',
        searchType:  'address'
      });
      const url = 'https://assessor.lacounty.gov/commondata/OutputData/SearchExistingAccounts?' + params.toString();
      const data = await fetchUrl(url);
      const rec = (data.Data || [])[0];
      if (rec) {
        if (rec.SQFTmain)                     det.sqft      = parseInt(rec.SQFTmain);
        if (rec.SQFTtotal)                    det.sqftTotal = parseInt(rec.SQFTtotal);
        if (rec.LotSqFt || rec.LotSize)       det.lotSqft   = parseInt(rec.LotSqFt || rec.LotSize);
        if (rec.YrBlt   || rec.YearBuilt)     det.yearBuilt = parseInt(rec.YrBlt || rec.YearBuilt);
        if (rec.Stories || rec.NoOfStories)   det.stories   = parseInt(rec.Stories || rec.NoOfStories);
        if (rec.Bedrooms|| rec.Beds)          det.bedrooms  = parseInt(rec.Bedrooms || rec.Beds);
        if (rec.Bathrooms||rec.Baths)         det.bathrooms = parseFloat(rec.Bathrooms || rec.Baths);
        if (rec.RoofType || rec.RoofCover)    det.roofType  = rec.RoofType || rec.RoofCover;
        if (rec.ExtWall  || rec.ExteriorWall) det.extWall   = rec.ExtWall  || rec.ExteriorWall;
        if (rec.Pool)                         det.pool      = rec.Pool === 'Y' || rec.Pool === 1;
        if (rec.UseType  || rec.UseCode)      det.useType   = rec.UseType  || rec.UseCode;
        if (rec.APN      || rec.AssessorParcelNum) det.apn  = rec.APN || rec.AssessorParcelNum;
        if (rec.Garage   || rec.GarageType)   det.garage    = rec.Garage || rec.GarageType;
        if (rec.FirePlace|| rec.Fireplaces)   det.fireplaces= rec.FirePlace || rec.Fireplaces;
        source = 'LA County Assessor';
      }
    } else {
      // ArcGIS counties — try each URL candidate in order
      const CANDIDATES = {
        riverside: [
          ['https://gis.rctlma.org/arcgis/rest/services/Assessor/Parcels/MapServer/', '0', 'SITUS_ADDR'],
          ['https://mapping.rctlma.org/arcgis/rest/services/Assessor/Parcels/MapServer/', '0', 'SITUS_ADDR'],
        ],
        orange: [
          ['https://services1.arcgis.com/P5Mv5GY5S66M8Z1Q/arcgis/rest/services/Parcels_Public/FeatureServer/', '0', 'SitusAddress'],
        ],
        sanbernardino: [
          ['https://gis.sbcounty.gov/sbcgis/rest/services/Assessor/Parcels/MapServer/', '0', 'SITE_ADDRESS'],
        ],
      };

      const list = CANDIDATES[county] || [];
      for (const [base, layer, field] of list) {
        try {
          const attrs = await arcgisLookup(base, layer, field, address);
          if (attrs) {
            // Try every common field name variant
            const g = (keys) => { for (const k of keys) { const v = attrs[k]; if (v != null && v !== 0 && v !== '') return v; } return undefined; };
            det.sqft      = parseInt(g(['SQ_FOOTAGE','BldgSqFt','BLDG_SQFT','SQFT','BUILDING_SQ_FT'])||0)||undefined;
            det.lotSqft   = parseInt(g(['LOT_SQFT','LotSqFt','LOTSQFT','LOT_SIZE_SQ_FT','LOT_SIZE'])||0)||undefined;
            det.yearBuilt = parseInt(g(['YR_BLT','YearBuilt','YEAR_BUILT','BUILT_YEAR','YR_BUILT'])||0)||undefined;
            det.bedrooms  = parseInt(g(['BEDROOMS','Bedrooms','BED_ROOMS','BEDRMS'])||0)||undefined;
            det.bathrooms = parseFloat(g(['BATHROOMS','Bathrooms','BATH','BATHRMS'])||0)||undefined;
            det.stories   = parseInt(g(['STORIES','Stories','NO_STORIES','NUM_STORIES'])||0)||undefined;
            det.apn       = String(g(['APN','PARCEL_NO','PARCELNO','PARCEL_ID','APN_FORMATTED'])||'').trim()||undefined;
            det.useType   = g(['USECODE','UseCode','USE_CODE','LAND_USE','USE_TYPE']);
            det.extWall   = g(['EXT_WALL','ExtWall','EXTERIOR_WALL']);
            det.roofType  = g(['ROOF_TYPE','RoofType','ROOF_COVER']);
            det.garage    = g(['GARAGE','GarageType','GARAGE_TYPE']);
            det.fireplaces= g(['FIREPLACES','FirePlace','FIRE_PLACES']);
            // Clean undefined
            Object.keys(det).forEach(k => det[k] === undefined && delete det[k]);
            if (Object.keys(det).length > 0) {
              source = county.charAt(0).toUpperCase() + county.slice(1) + ' County ArcGIS';
              break;
            }
          }
        } catch(e) {
          console.log('[property] ArcGIS candidate failed:', base, e.message);
        }
      }
    }
  } catch(err) {
    console.error('[property] outer error:', err.message);
  }

  if (Object.keys(det).length > 0) {
    res.json({ ok: true, data: det, county, source });
  } else {
    res.json({ ok: true, data: null, county, source: 'not_found' });
  }
});


// ── Debug endpoint — shows raw county API response ──────────────────────────
app.get('/debug-property', async (req, res) => {
  const { address, zip } = req.query;
  if (!address) return res.json({ error: 'Need ?address=&zip=' });
  const county = detectCounty(zip || '', address);
  const houseNum   = address.replace(/\D/g, '').slice(0, 6);
  const streetName = address.replace(/^\d+\s*/, '').trim().toUpperCase();
  const firstWord  = streetName.split(' ')[0];
  const results = { county, houseNum, streetName, firstWord };

  if (county === 'la') {
    const params = new URLSearchParams({
      houseNum: address.replace(/[^0-9]/g, '').slice(0, 6),
      streetName: address.replace(/^[0-9]+\s*/, '').split(' ')[0],
      unitNum: '', searchType: 'address'
    });
    const url = 'https://assessor.lacounty.gov/commondata/OutputData/SearchExistingAccounts?' + params.toString();
    results.url = url;
    try { results.rawResponse = await fetchUrl(url); }
    catch(e) { results.error = e.message; }
  } else {
    const base = 'https://gis.rctlma.org/arcgis/rest/services/Assessor/Parcels/MapServer/';
    const where = `SITUS_ADDR LIKE '${houseNum} ${firstWord}%'`;
    const params = new URLSearchParams({ where, outFields: '*', f: 'json', resultRecordCount: 5 });
    const url = base + '0/query?' + params.toString();
    results.url = url;
    try { results.rawResponse = await fetchUrl(url); }
    catch(e) { results.error = e.message; }

    // Also try without house number
    const where2 = `SITUS_ADDR LIKE '%${firstWord}%'`;
    const params2 = new URLSearchParams({ where: where2, outFields: 'SITUS_ADDR,APN,SQ_FOOTAGE', f: 'json', resultRecordCount: 3 });
    const url2 = base + '0/query?' + params2.toString();
    results.url2 = url2;
    try { results.sampleRecords = await fetchUrl(url2); }
    catch(e) { results.error2 = e.message; }
  }
  res.json(results);
});


app.listen(PORT, () => {
  console.log(`Anaya Sync Server v2 running on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Persistent volume: ${fs.existsSync('/data') ? 'YES (/data)' : 'NO — add a volume on Railway!'}`);
  const store = readStore();
  const keys = Object.keys(store);
  if (keys.length > 0) {
    console.log(`Stored keys: ${keys.map(k => `"${k}" (saved ${store[k].savedAt})`).join(', ')}`);
  } else {
    console.log('No data stored yet.');
  }
});
