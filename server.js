'use strict';

const path = require('path');
const express = require('express');

const { loadGtfs, getNextDepartures } = require('./lib/gtfs');
const {
  STOPS,
  GTFS_URL,
  GTFS_REFRESH_HOURS,
  DEPARTURES_PER_STOP,
} = require('./lib/config');

const PORT = process.env.PORT || 3000;
const app = express();

// ---------------------------------------------------------------------------
// State + GTFS lifecycle
// ---------------------------------------------------------------------------

let gtfsIndex = null;
let lastError = null;
let lastSuccessfulLoad = null;

async function refreshGtfs() {
  console.log(`[gtfs] Loading from ${GTFS_URL}`);
  try {
    const idx = await loadGtfs(GTFS_URL);
    gtfsIndex = idx;
    lastError = null;
    lastSuccessfulLoad = idx.loadedAt;

    console.log('[gtfs] Loaded:', idx.counts);
    for (const s of STOPS) {
      const platforms = (idx.stopsByName.get(s.stopName) || []).length;
      const routes = (idx.routesByShortName.get(s.routeShortName) || []).length;
      console.log(
        `[gtfs] config "${s.id}" → stop "${s.stopName}": ${platforms} platform(s); ` +
        `route ${s.routeShortName}: ${routes} match(es).`
      );
      if (platforms === 0) {
        console.warn(`[gtfs] WARNING: stopName "${s.stopName}" not found. ` +
          `Try /api/debug/stops?q=... to find the right name.`);
      }
    }
  } catch (err) {
    console.error('[gtfs] Refresh failed:', err.message);
    lastError = err.message;
    if (!gtfsIndex) {
      // Bootstrapping failure — try again soon so the display isn't stuck.
      setTimeout(refreshGtfs, 60_000);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider abstraction
//
// Path A (current): GTFS only.
// Path B (future):  add a realtime provider returning the same shape, call it
// first here, fall back to GTFS on failure. Frontend stays unchanged — it
// only knows about /api/departures.
// ---------------------------------------------------------------------------

async function getDepartures() {
  if (!gtfsIndex) {
    return { ok: false, error: 'gtfs_not_loaded', stops: [] };
  }

  const stops = STOPS.map(s => ({
    id: s.id,
    label: s.label,
    stopName: s.stopName,
    departures: getNextDepartures(gtfsIndex, s, { limit: DEPARTURES_PER_STOP }),
  }));

  return {
    ok: true,
    source: 'gtfs',
    gtfsLoadedAt: gtfsIndex.loadedAt,
    serverTime: new Date().toISOString(),
    stops,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/departures', async (_req, res) => {
  try {
    const data = await getDepartures();
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: !!gtfsIndex,
    gtfsLoadedAt: lastSuccessfulLoad,
    lastError,
  });
});

// Helper for finding stop names if your GTFS spelling differs.
// Example: /api/debug/stops?q=slovany
app.get('/api/debug/stops', (req, res) => {
  if (!gtfsIndex) return res.status(503).json({ error: 'gtfs_not_loaded' });
  const q = (req.query.q || '').toLowerCase();
  const matches = [];
  for (const [name, list] of gtfsIndex.stopsByName) {
    if (!q || name.toLowerCase().includes(q)) {
      matches.push({ stop_name: name, platforms: list.length });
    }
    if (matches.length >= 50) break;
  }
  res.json({ matches });
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  await refreshGtfs();
  setInterval(refreshGtfs, GTFS_REFRESH_HOURS * 3600 * 1000);
  app.listen(PORT, () => {
    console.log(`[server] Listening on :${PORT}`);
  });
})();
