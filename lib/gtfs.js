'use strict';

const AdmZip = require('adm-zip');
const { parse } = require('csv-parse/sync');
const { SERVER_TZ } = require('./config');

const REQUIRED_FILES = [
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
];

// ---------------------------------------------------------------------------
// Download + parse
// ---------------------------------------------------------------------------

async function downloadGtfs(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'tram-terminal/0.1 (home info display)' },
  });
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

function parseGtfs(buffer) {
  const zip = new AdmZip(buffer);
  const opts = { columns: true, skip_empty_lines: true, bom: true, trim: true };

  const files = {};
  for (const name of REQUIRED_FILES) {
    const entry = zip.getEntry(name);
    if (!entry) throw new Error(`GTFS missing required file: ${name}`);
    files[name] = parse(entry.getData(), opts);
  }

  // calendar_dates.txt is optional in GTFS; treat as empty if absent.
  const calDates = zip.getEntry('calendar_dates.txt');
  files['calendar_dates.txt'] = calDates ? parse(calDates.getData(), opts) : [];

  return files;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

function buildIndex(files) {
  const stopsByName = new Map();
  const stopNameById = new Map();
  for (const s of files['stops.txt']) {
    if (!stopsByName.has(s.stop_name)) stopsByName.set(s.stop_name, []);
    stopsByName.get(s.stop_name).push(s);
    stopNameById.set(s.stop_id, s.stop_name);
  }

  const routesByShortName = new Map();
  for (const r of files['routes.txt']) {
    if (!routesByShortName.has(r.route_short_name)) routesByShortName.set(r.route_short_name, []);
    routesByShortName.get(r.route_short_name).push(r);
  }

  const tripsById = new Map();
  for (const t of files['trips.txt']) tripsById.set(t.trip_id, t);

  // Same row objects shared into two indexes: by stop (for finding "next
  // departure here"), and by trip (for asking "where does this trip go after
  // here?", which powers directionVia matching).
  const stopTimesByStop = new Map();
  const stopTimesByTrip = new Map();
  for (const st of files['stop_times.txt']) {
    if (!stopTimesByStop.has(st.stop_id)) stopTimesByStop.set(st.stop_id, []);
    stopTimesByStop.get(st.stop_id).push(st);
    if (!stopTimesByTrip.has(st.trip_id)) stopTimesByTrip.set(st.trip_id, []);
    stopTimesByTrip.get(st.trip_id).push(st);
  }
  // Lexicographic sort works for HH:MM:SS, including times >= 24:00:00.
  for (const arr of stopTimesByStop.values()) {
    arr.sort((a, b) => a.departure_time.localeCompare(b.departure_time));
  }
  for (const arr of stopTimesByTrip.values()) {
    arr.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  }

  const calendarById = new Map();
  for (const c of files['calendar.txt']) calendarById.set(c.service_id, c);

  const calendarDatesByService = new Map();
  for (const cd of files['calendar_dates.txt']) {
    if (!calendarDatesByService.has(cd.service_id)) calendarDatesByService.set(cd.service_id, []);
    calendarDatesByService.get(cd.service_id).push(cd);
  }

  return {
    stopsByName,
    stopNameById,
    routesByShortName,
    tripsById,
    stopTimesByStop,
    stopTimesByTrip,
    calendarById,
    calendarDatesByService,
    counts: {
      stops: files['stops.txt'].length,
      routes: files['routes.txt'].length,
      trips: files['trips.txt'].length,
      stopTimes: files['stop_times.txt'].length,
    },
    loadedAt: new Date(),
  };
}

async function loadGtfs(url) {
  const buf = await downloadGtfs(url);
  const files = parseGtfs(buf);
  return buildIndex(files);
}

// ---------------------------------------------------------------------------
// Time helpers (Prague-anchored, independent of host TZ)
// ---------------------------------------------------------------------------

const DOW_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function pad2(n) { return String(n).padStart(2, '0'); }

function nowInPrague(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SERVER_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t) => Number(parts.find(p => p.type === t).value);
  const year = get('year'), month = get('month'), day = get('day');
  let hour = get('hour'); // some Intl impls return 24 for midnight
  if (hour === 24) hour = 0;
  const minute = get('minute'), second = get('second');
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const ymd = `${year}${pad2(month)}${pad2(day)}`;
  return { year, month, day, hour, minute, second, dow, ymd };
}

function dayBefore(dayInfo) {
  const utc = new Date(Date.UTC(dayInfo.year, dayInfo.month - 1, dayInfo.day));
  utc.setUTCDate(utc.getUTCDate() - 1);
  const year = utc.getUTCFullYear();
  const month = utc.getUTCMonth() + 1;
  const day = utc.getUTCDate();
  return {
    year, month, day,
    hour: 0, minute: 0, second: 0,
    dow: utc.getUTCDay(),
    ymd: `${year}${pad2(month)}${pad2(day)}`,
  };
}

function timeToSeconds(t) {
  // Handles "HH:MM:SS" with HH possibly >= 24 (GTFS post-midnight extensions).
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

// ---------------------------------------------------------------------------
// Service-day resolution
// ---------------------------------------------------------------------------

function getActiveServiceIds(index, dayInfo) {
  const dowName = DOW_NAMES[dayInfo.dow];
  const active = new Set();

  for (const [serviceId, cal] of index.calendarById) {
    if (dayInfo.ymd >= cal.start_date && dayInfo.ymd <= cal.end_date && cal[dowName] === '1') {
      active.add(serviceId);
    }
  }

  for (const [serviceId, exceptions] of index.calendarDatesByService) {
    for (const ex of exceptions) {
      if (ex.date !== dayInfo.ymd) continue;
      if (ex.exception_type === '1') active.add(serviceId);
      else if (ex.exception_type === '2') active.delete(serviceId);
    }
  }

  return active;
}

// ---------------------------------------------------------------------------
// Departure query
// ---------------------------------------------------------------------------

function getNextDepartures(index, query, opts = {}) {
  const { stopName, routeShortName, headsignContains, directionVia } = query;
  const limit = opts.limit ?? 2;
  const now = opts.now ?? new Date();

  const candidateStops = index.stopsByName.get(stopName) || [];
  if (candidateStops.length === 0) return [];

  const candidateRoutes = index.routesByShortName.get(routeShortName) || [];
  if (candidateRoutes.length === 0) return [];
  const routeIds = new Set(candidateRoutes.map(r => r.route_id));

  const today = nowInPrague(now);
  const yesterday = dayBefore(today);
  const todaySvc = getActiveServiceIds(index, today);
  const yesterdaySvc = getActiveServiceIds(index, yesterday);

  const nowSec = today.hour * 3600 + today.minute * 60 + today.second;
  const headsignNeedle = headsignContains ? headsignContains.toLowerCase() : null;
  const viaNeedle = directionVia ? directionVia.toLowerCase() : null;

  const results = [];
  for (const stop of candidateStops) {
    const stopTimes = index.stopTimesByStop.get(stop.stop_id) || [];
    for (const st of stopTimes) {
      const trip = index.tripsById.get(st.trip_id);
      if (!trip) continue;
      if (!routeIds.has(trip.route_id)) continue;

      // Direction filter: headsignContains (terminus name) OR directionVia
      // (any downstream stop on this trip after our stop). Either-or — use
      // whichever is set; if neither, no direction filter.
      if (headsignNeedle && !(trip.trip_headsign || '').toLowerCase().includes(headsignNeedle)) continue;
      if (viaNeedle) {
        const tripStops = index.stopTimesByTrip.get(trip.trip_id) || [];
        const myIdx = tripStops.findIndex(t =>
          t.stop_id === st.stop_id && t.stop_sequence === st.stop_sequence);
        if (myIdx === -1) continue;
        let goesVia = false;
        for (let i = myIdx + 1; i < tripStops.length; i++) {
          const name = (index.stopNameById.get(tripStops[i].stop_id) || '').toLowerCase();
          if (name.includes(viaNeedle)) { goesVia = true; break; }
        }
        if (!goesVia) continue;
      }

      const depSec = timeToSeconds(st.departure_time);
      let secondsUntil = null;

      if (depSec >= 24 * 3600) {
        // Belongs to yesterday's service, falling into today's small hours.
        if (yesterdaySvc.has(trip.service_id)) {
          const dep = depSec - 24 * 3600;
          if (dep >= nowSec) secondsUntil = dep - nowSec;
        }
      } else if (todaySvc.has(trip.service_id)) {
        if (depSec >= nowSec) secondsUntil = depSec - nowSec;
      }

      if (secondsUntil === null) continue;

      results.push({
        departureTime: st.departure_time.slice(0, 5),
        secondsUntil,
        minutesUntil: Math.floor(secondsUntil / 60),
        headsign: trip.trip_headsign,
        tripId: trip.trip_id,
      });
    }
  }

  results.sort((a, b) => a.secondsUntil - b.secondsUntil);
  return results.slice(0, limit);
}

module.exports = {
  loadGtfs,
  getNextDepartures,
  nowInPrague,
  buildIndex,
};
