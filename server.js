'use strict';

const path = require('path');
const express = require('express');

const { loadGtfs, getNextDepartures, findStopsByName, normalizeStopName } = require('./lib/gtfs');
const weather = require('./lib/weather');
const {
  VIEWS,
  DEFAULT_VIEW,
  GEO_RADIUS_M,
  MANUAL_OVERRIDE_MINUTES,
  GTFS_URL,
  GTFS_REFRESH_HOURS,
  DEPARTURES_PER_STOP,
} = require('./lib/config');

// Flat list of every stop config across all views — used by GTFS-loading
// log and the diagnose endpoint, both of which iterate every stop regardless
// of which view it belongs to.
const ALL_STOPS = Object.values(VIEWS).flatMap(v =>
  v.stops.map(s => ({ ...s, _viewId: v.id }))
);

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
    for (const s of ALL_STOPS) {
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
        `[gtfs] [${s._viewId}] "${s.id}" → stop "${s.stopName}"${matchedNote}: ` +
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

async function getDepartures(viewId) {
  const wx = weather.getCached();
  const view = VIEWS[viewId] || VIEWS[DEFAULT_VIEW];

  if (!gtfsIndex) {
    return {
      ok: false,
      error: 'gtfs_not_loaded',
      view: { id: view.id, label: view.label },
      stops: [],
      weather: wx,
    };
  }

  const stops = view.stops.map(s => ({
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
    view: { id: view.id, label: view.label },
    stops,
    weather: wx,
  };
}

// View metadata for the frontend's switcher and geolocation logic. Strips
// any backend-only fields (none currently, but the boundary is explicit).
function getViewsForClient() {
  return {
    views: Object.values(VIEWS).map(v => ({
      id: v.id,
      label: v.label,
      anchor: v.anchor,
    })),
    defaultView: DEFAULT_VIEW,
    geoRadiusM: GEO_RADIUS_M,
    manualOverrideMinutes: MANUAL_OVERRIDE_MINUTES,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/departures', async (req, res) => {
  try {
    // Default to DEFAULT_VIEW if the param is missing or unrecognised, so a
    // stale bookmark or a typo never returns 404 — the user just sees the
    // home view and can switch from the bottom row.
    const viewId = VIEWS[req.query.view] ? req.query.view : DEFAULT_VIEW;
    const data = await getDepartures(viewId);
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// List of available views + geolocation parameters. The client fetches this
// once on boot and uses it to render the bottom switcher and run distance
// math against each view's anchor.
app.get('/api/views', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(getViewsForClient());
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

// One-stop-shop diagnostic. For every configured stop entry, report the full
// chain: did the stop match, did the route match, what trips visit those
// platforms, how their headsigns and downstream stops look, and how many of
// them pass the current direction filter. text/plain for trivial sharing.
//
// Open in browser: /api/diagnose             (all views)
//                  /api/diagnose?view=centrum (one view)
app.get('/api/diagnose', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  if (!gtfsIndex) return res.send('GTFS not loaded.\nlastError: ' + lastError);

  const filter = req.query.view;
  const stops = filter && VIEWS[filter]
    ? VIEWS[filter].stops.map(s => ({ ...s, _viewId: filter }))
    : ALL_STOPS;

  const lines = [];
  lines.push('=== TRAM-TERMINAL DIAGNOSE ===');
  lines.push(`server time: ${new Date().toISOString()}`);
  lines.push(`gtfs loaded at: ${gtfsIndex.loadedAt.toISOString()}`);
  lines.push(`gtfs counts: ${JSON.stringify(gtfsIndex.counts)}`);
  lines.push(`views in scope: ${filter || '(all)'}`);
  lines.push('');

  for (const s of stops) {
    lines.push(`--- [${s._viewId}] ${s.id} ---`);
    lines.push(`config: ${JSON.stringify(s)}`);

    // 1. Stop lookup.
    const m = findStopsByName(gtfsIndex, s.stopName);
    lines.push(`stop match: strategy=${m.strategy}, matchedName=${JSON.stringify(m.matchedName)}, platforms=${m.stops.length}`);
    if (m.stops.length === 0) {
      lines.push('  -> NO STOP MATCHED. Try /api/debug/stops?q=<part of name>');
      lines.push('');
      continue;
    }
    for (const p of m.stops) {
      lines.push(`  platform: stop_id=${p.stop_id}, name=${JSON.stringify(p.stop_name)}` +
        (p.platform_code ? `, platform_code=${p.platform_code}` : ''));
    }

    // 2. Route lookup.
    const routes = gtfsIndex.routesByShortName.get(s.routeShortName) || [];
    lines.push(`route "${s.routeShortName}": ${routes.length} match(es)`);
    if (routes.length === 0) {
      lines.push('  -> NO ROUTE MATCHED.');
      lines.push('');
      continue;
    }
    const routeIds = new Set(routes.map(r => r.route_id));

    // 3. Find ALL trips on this route visiting any of our platforms (no
    // direction filter yet) — including their downstream paths.
    const platformIds = new Set(m.stops.map(p => p.stop_id));
    const tripsAtStop = []; // { trip, atIdx, downstream }
    for (const trip of gtfsIndex.tripsById.values()) {
      if (!routeIds.has(trip.route_id)) continue;
      const ts = gtfsIndex.stopTimesByTrip.get(trip.trip_id) || [];
      const atIdx = ts.findIndex(t => platformIds.has(t.stop_id));
      if (atIdx === -1) continue;
      tripsAtStop.push({ trip, atIdx, all: ts });
    }
    lines.push(`trips visiting these platforms on route ${s.routeShortName}: ${tripsAtStop.length}`);

    // 4. Group by headsign.
    const byHeadsign = new Map();
    for (const { trip } of tripsAtStop) {
      const h = trip.trip_headsign || '(empty)';
      byHeadsign.set(h, (byHeadsign.get(h) || 0) + 1);
    }
    lines.push(`headsigns seen at this stop:`);
    for (const [h, n] of [...byHeadsign].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${n.toString().padStart(4)}× ${JSON.stringify(h)}`);
    }

    // 5. Sample downstream paths (the stops AFTER ours), grouped by headsign.
    //    This is what directionVia matches against.
    const downstreamByHeadsign = new Map();
    for (const { trip, atIdx, all } of tripsAtStop) {
      const h = trip.trip_headsign || '(empty)';
      if (downstreamByHeadsign.has(h)) continue;
      const after = all.slice(atIdx + 1, atIdx + 1 + 6)
        .map(t => gtfsIndex.stopNameById.get(t.stop_id));
      downstreamByHeadsign.set(h, after);
    }
    lines.push(`example downstream paths (next ~6 stops after ours):`);
    for (const [h, after] of downstreamByHeadsign) {
      lines.push(`  headsign=${JSON.stringify(h)}: ${after.map(JSON.stringify).join(' → ')}`);
    }

    // 6. How many pass the configured direction filter.
    const headNeedle = s.headsignContains ? normalizeStopName(s.headsignContains) : null;
    const viaNeedle = s.directionVia ? normalizeStopName(s.directionVia) : null;
    let passed = 0;
    for (const { trip, atIdx, all } of tripsAtStop) {
      if (headNeedle && !normalizeStopName(trip.trip_headsign).includes(headNeedle)) continue;
      if (viaNeedle) {
        let v = false;
        for (let i = atIdx + 1; i < all.length; i++) {
          if (normalizeStopName(gtfsIndex.stopNameById.get(all[i].stop_id)).includes(viaNeedle)) {
            v = true; break;
          }
        }
        if (!v) continue;
      }
      passed++;
    }
    const filterLabel = headNeedle
      ? `headsignContains=${JSON.stringify(s.headsignContains)} (normalized: ${JSON.stringify(headNeedle)})`
      : viaNeedle
        ? `directionVia=${JSON.stringify(s.directionVia)} (normalized: ${JSON.stringify(viaNeedle)})`
        : '(no direction filter)';
    lines.push(`direction filter: ${filterLabel}`);
    lines.push(`trips passing direction filter: ${passed}`);
    if (passed === 0) {
      lines.push('  -> THE PROBLEM. Compare the filter to the actual headsigns / downstream paths above.');
    }

    // 7. Current live result.
    const live = getNextDepartures(gtfsIndex, s, { limit: 3 });
    lines.push(`live getNextDepartures: ${live.length} result(s)`);
    for (const d of live) lines.push(`  ${d.departureTime} (in ${Math.round(d.secondsUntil / 60)} min) → ${d.headsign}`);
    lines.push('');
  }

  res.send(lines.join('\n'));
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
