'use strict';

const path = require('path');
const express = require('express');

const { loadGtfs, getNextDepartures, findStopsByName, normalizeStopName } = require('./lib/gtfs');
const weather = require('./lib/weather');
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
      const stopMatch = findStopsByName(idx, s.stopName);
      const platforms = stopMatch.stops.length;
      const routes = (idx.routesByShortName.get(s.routeShortName) || []).length;

      // How many trips on this route actually pass the direction filter at
      // any of the matched platforms? This is what determines whether the UI
      // shows "žádný spoj" — the place we want surfaced clearly in logs.
      let tripsThroughDirection = 0;
      const routeIds = new Set(
        (idx.routesByShortName.get(s.routeShortName) || []).map(r => r.route_id)
      );
      const headsignNeedle = s.headsignContains ? normalizeStopName(s.headsignContains) : null;
      const viaNeedle = s.directionVia ? normalizeStopName(s.directionVia) : null;
      const platformIds = new Set(stopMatch.stops.map(p => p.stop_id));

      for (const trip of idx.tripsById.values()) {
        if (!routeIds.has(trip.route_id)) continue;
        // Trip must visit one of our platforms…
        const tripStops = idx.stopTimesByTrip.get(trip.trip_id) || [];
        const myIdx = tripStops.findIndex(t => platformIds.has(t.stop_id));
        if (myIdx === -1) continue;
        // …and pass the direction filter (matching getNextDepartures' logic).
        if (headsignNeedle && !normalizeStopName(trip.trip_headsign).includes(headsignNeedle)) continue;
        if (viaNeedle) {
          let via = false;
          for (let i = myIdx + 1; i < tripStops.length; i++) {
            if (normalizeStopName(idx.stopNameById.get(tripStops[i].stop_id)).includes(viaNeedle)) {
              via = true; break;
            }
          }
          if (!via) continue;
        }
        tripsThroughDirection++;
      }

      const matchedNote = stopMatch.strategy === 'normalized'
        ? ` (matched as "${stopMatch.matchedName}" via normalization)`
        : stopMatch.strategy === 'exact' ? '' : ' (NOT FOUND)';

      console.log(
        `[gtfs] config "${s.id}" → stop "${s.stopName}"${matchedNote}: ` +
        `${platforms} platform(s); route ${s.routeShortName}: ${routes} match(es); ` +
        `trips matching direction filter: ${tripsThroughDirection}.`
      );
      if (platforms === 0) {
        console.warn(`[gtfs] WARNING: stopName "${s.stopName}" not found. ` +
          `Try /api/debug/stops?q=... to find the right name.`);
      } else if (tripsThroughDirection === 0) {
        const filt = s.headsignContains
          ? `headsignContains: "${s.headsignContains}"`
          : `directionVia: "${s.directionVia}"`;
        console.warn(`[gtfs] WARNING: 0 trips match direction filter ${filt} ` +
          `at "${s.stopName}". Try /api/debug/headsigns?route=${s.routeShortName}.`);
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
  const wx = weather.getCached();

  if (!gtfsIndex) {
    return { ok: false, error: 'gtfs_not_loaded', stops: [], weather: wx };
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
    weather: wx,
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

// Helper for finding the right headsignContains / directionVia for a route.
// Lists every unique trip_headsign on the given route with the trip count, so
// you can see exactly what PMDP wrote (e.g. "Světovar" vs "Plzeň, Světovar").
// Example: /api/debug/headsigns?route=2
app.get('/api/debug/headsigns', (req, res) => {
  if (!gtfsIndex) return res.status(503).json({ error: 'gtfs_not_loaded' });
  const route = req.query.route;
  if (!route) return res.json({ error: 'pass ?route=...' });
  const candidateRoutes = gtfsIndex.routesByShortName.get(route) || [];
  if (candidateRoutes.length === 0) {
    return res.json({ route, headsigns: [], note: `no route_short_name=${route}` });
  }
  const routeIds = new Set(candidateRoutes.map(r => r.route_id));
  const headsigns = new Map();
  for (const trip of gtfsIndex.tripsById.values()) {
    if (!routeIds.has(trip.route_id)) continue;
    const h = trip.trip_headsign || '(empty)';
    headsigns.set(h, (headsigns.get(h) || 0) + 1);
  }
  const sorted = [...headsigns.entries()]
    .map(([headsign, trips]) => ({ headsign, trips }))
    .sort((a, b) => b.trips - a.trips);
  res.json({ route, headsigns: sorted });
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  weather.start();
  await refreshGtfs();
  setInterval(refreshGtfs, GTFS_REFRESH_HOURS * 3600 * 1000);
  app.listen(PORT, () => {
    console.log(`[server] Listening on :${PORT}`);
  });
})();
