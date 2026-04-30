'use strict';

// Weather + air quality fetcher.
//
// Open-Meteo is free for non-commercial use, no API key required, no auth.
// Two separate endpoints: forecast (temperature, weather code, etc.) and
// air-quality (European AQI, PM2.5, PM10).
//
// We cache the latest successful read; on a fetch error we keep the previous
// reading rather than blanking the UI. Same shape always, plus a fetchedAt
// stamp so the client can show staleness if needed.

const { LOCATION, WEATHER_REFRESH_MINUTES } = require('./config');

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AQ_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

let cache = null;
let lastError = null;

async function fetchOnce() {
  const common = {
    latitude: String(LOCATION.lat),
    longitude: String(LOCATION.lng),
    timezone: 'Europe/Prague',
  };

  const wxQ = new URLSearchParams({
    ...common,
    current: 'temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m',
    // Hourly arrays for the next 12 h sparkline. We ask for two days so the
    // window crossing midnight still fits without slicing across requests.
    hourly: 'temperature_2m,precipitation_probability,weather_code',
    forecast_days: '2',
  });
  const aqQ = new URLSearchParams({
    ...common,
    current: 'european_aqi,pm2_5,pm10',
  });

  const headers = { 'User-Agent': 'tram-terminal/0.1 (home info display)' };

  // Run in parallel; AQ failure is non-fatal (we'll just hide AQI in UI).
  const [wxRes, aqRes] = await Promise.allSettled([
    fetch(`${FORECAST_URL}?${wxQ}`, { headers }).then(r =>
      r.ok ? r.json() : Promise.reject(new Error(`forecast HTTP ${r.status}`))),
    fetch(`${AQ_URL}?${aqQ}`, { headers }).then(r =>
      r.ok ? r.json() : Promise.reject(new Error(`aqi HTTP ${r.status}`))),
  ]);

  if (wxRes.status !== 'fulfilled') throw wxRes.reason;
  const wxData = wxRes.value;
  const wx = wxData.current;
  if (!wx) throw new Error('forecast: missing current block');

  const aq = aqRes.status === 'fulfilled' ? aqRes.value.current : null;

  // Slice next 12 hourly entries starting from the current local hour.
  const hourly = sliceNext12Hours(wxData.hourly, wxData.timezone);

  return {
    location: LOCATION.label,
    tempC: Math.round(wx.temperature_2m),
    weatherCode: wx.weather_code,
    description: describeWeatherCode(wx.weather_code),
    humidity: wx.relative_humidity_2m,
    windKmh: Math.round(wx.wind_speed_10m),
    aqi: aq && aq.european_aqi != null ? Math.round(aq.european_aqi) : null,
    aqiLabel: aq && aq.european_aqi != null ? aqiLabel(aq.european_aqi) : null,
    pm25: aq && aq.pm2_5 != null ? Math.round(aq.pm2_5 * 10) / 10 : null,
    hourly,
    fetchedAt: new Date().toISOString(),
  };
}

// Open-Meteo returns parallel arrays of timestamps + values. We pick the 12
// entries starting from the current hour in the response's timezone.
function sliceNext12Hours(hourly, tz) {
  if (!hourly || !Array.isArray(hourly.time)) return null;

  // Find first index whose timestamp is >= now (in the response's local tz).
  // Timestamps come as e.g. "2026-04-30T15:00" — already in `tz`. We compare
  // by formatting "now" the same way.
  const nowStr = formatLocalHour(new Date(), tz);
  let startIdx = hourly.time.findIndex(t => t >= nowStr);
  if (startIdx === -1) startIdx = 0;

  const slice = (arr) => Array.isArray(arr) ? arr.slice(startIdx, startIdx + 12) : [];
  const times = slice(hourly.time);
  const temps = slice(hourly.temperature_2m);
  const probs = slice(hourly.precipitation_probability);

  if (times.length === 0) return null;

  const tempVals = temps.filter(v => typeof v === 'number');
  const probVals = probs.filter(v => typeof v === 'number');

  return {
    points: times.map((t, i) => ({
      time: t,
      hour: parseInt(t.slice(11, 13), 10),
      tempC: temps[i],
      precipProb: probs[i],
    })),
    tempMin: tempVals.length ? Math.round(Math.min(...tempVals)) : null,
    tempMax: tempVals.length ? Math.round(Math.max(...tempVals)) : null,
    precipMaxPct: probVals.length ? Math.max(...probVals) : null,
  };
}

// Format current instant as "YYYY-MM-DDTHH:00" in the given IANA tz, so we
// can compare against Open-Meteo's already-localized timestamps.
function formatLocalHour(date, tz) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  // sv-SE locale gives "YYYY-MM-DD HH:MM"; Open-Meteo uses "YYYY-MM-DDTHH:MM".
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:00`;
}

function describeWeatherCode(code) {
  // WMO weather interpretation codes (Open-Meteo ref). Czech labels.
  if (code === 0) return 'jasno';
  if (code === 1) return 'skoro jasno';
  if (code === 2) return 'polojasno';
  if (code === 3) return 'oblačno';
  if (code === 45 || code === 48) return 'mlha';
  if (code >= 51 && code <= 57) return 'mrholení';
  if (code >= 61 && code <= 67) return 'déšť';
  if (code >= 71 && code <= 77) return 'sněžení';
  if (code >= 80 && code <= 82) return 'přeháňky';
  if (code === 85 || code === 86) return 'sněhové přeháňky';
  if (code === 95) return 'bouřka';
  if (code === 96 || code === 99) return 'bouřka s kroupami';
  return '—';
}

function aqiLabel(value) {
  // European AQI scale (CAMS).
  if (value <= 20) return 'velmi dobrá';
  if (value <= 40) return 'dobrá';
  if (value <= 60) return 'středně dobrá';
  if (value <= 80) return 'špatná';
  if (value <= 100) return 'velmi špatná';
  return 'extrémně špatná';
}

async function refresh() {
  try {
    cache = await fetchOnce();
    lastError = null;
    const h = cache.hourly;
    const fcastNote = h
      ? `; 12h ${h.tempMin}–${h.tempMax}°, max srážky ${h.precipMaxPct ?? '—'}%`
      : '';
    console.log(
      `[weather] ${cache.tempC}° ${cache.description}` +
      (cache.aqi != null ? `; AQI ${cache.aqi} (${cache.aqiLabel})` : '; AQI n/a') +
      fcastNote
    );
  } catch (err) {
    lastError = err.message;
    console.error('[weather] refresh failed:', err.message);
    // Keep stale cache so UI doesn't blank out for one bad fetch.
  }
}

function start() {
  refresh();
  setInterval(refresh, WEATHER_REFRESH_MINUTES * 60 * 1000);
}

function getCached() {
  return cache;
}

function getLastError() {
  return lastError;
}

module.exports = { start, getCached, getLastError };
