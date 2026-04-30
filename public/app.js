'use strict';

const STOP_TEMPLATE_PRIMARY = document.getElementById('stop-template-primary');
const STOP_TEMPLATE_SECONDARY = document.getElementById('stop-template-secondary');
const STOPS_EL = document.getElementById('stops');
const CLOCK_EL = document.getElementById('clock');
const UPDATED_EL = document.getElementById('updated');
const FOOTER_EL = document.querySelector('footer');

const REFRESH_MS = 20_000;     // poll backend every 20s
const STALE_AFTER_MS = 90_000; // mark display stale if no update for 90s

let lastUpdate = null;
let lastFetchError = null;

// ---------------------------------------------------------------------------
// Time + freshness display
// ---------------------------------------------------------------------------

function fmtClock(d = new Date()) {
  return d.toLocaleTimeString('cs-CZ', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Prague',
  });
}

function tickClock() {
  CLOCK_EL.textContent = fmtClock();

  if (lastFetchError) {
    UPDATED_EL.textContent = `chyba spojení: ${lastFetchError}`;
    FOOTER_EL.classList.add('stale');
    return;
  }

  if (lastUpdate) {
    const sec = Math.round((Date.now() - lastUpdate) / 1000);
    UPDATED_EL.textContent = `aktualizováno před ${sec} s`;
    FOOTER_EL.classList.toggle('stale', (Date.now() - lastUpdate) > STALE_AFTER_MS);
  }
}

setInterval(tickClock, 1000);

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function pluralizeMin(n) {
  if (n === 1) return 'minuta';
  if (n >= 2 && n <= 4) return 'minuty';
  return 'minut';
}

// "teď" applies only to the last 30 seconds before the scheduled time, so the
// label reflects reality. Above that we always round UP — "1 min" means
// "tram hasn't arrived yet but is close", never "tram already left".
function fmtCountdown(secondsUntil) {
  if (secondsUntil < 30) return { num: 'teď', unit: '', isNow: true };
  const min = Math.ceil(secondsUntil / 60);
  return { num: String(min), unit: pluralizeMin(min), min, isNow: false };
}

// Traffic-light urgency for "next departure":
//   > 5 min       → green   (plenty of time, can stroll)
//   3–5 min       → amber   (start moving)
//   < 3 min       → red     (run, or accept missing it)
//   "teď"         → red     (already departing)
function urgencyColor(secondsUntil) {
  if (secondsUntil < 30) return 'red';        // "teď"
  const min = Math.ceil(secondsUntil / 60);
  if (min > 5) return 'green';
  if (min >= 3) return 'amber';
  return 'red';
}

// Same idea for AQI on the European AQI scale (CAMS):
//   ≤ 40   "velmi dobrá" / "dobrá"        → green
//   41–60  "středně dobrá"                → amber
//   > 60   "špatná" and worse             → red
function aqiColor(aqi) {
  if (aqi <= 40) return 'green';
  if (aqi <= 60) return 'amber';
  return 'red';
}

function setDot(el, color) {
  if (!el) return;
  el.classList.remove('green', 'amber', 'red');
  if (color) {
    el.classList.add(color);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function renderStop(stop, priority) {
  const tpl = priority === 'primary' ? STOP_TEMPLATE_PRIMARY : STOP_TEMPLATE_SECONDARY;
  const node = tpl.content.cloneNode(true);
  const article = node.querySelector('.stop');
  article.dataset.id = stop.id;
  node.querySelector('.stop-label').textContent = stop.label;

  const dotEl = node.querySelector('.dot');
  const numEl = node.querySelector('.next-num');
  const unitEl = node.querySelector('.next-unit');
  const timeEl = node.querySelector('.next-time');
  const thenEl = node.querySelector('.then');

  const next = stop.departures[0];
  const then = stop.departures[1];

  if (!next) {
    numEl.textContent = '—';
    numEl.classList.add('empty');
    unitEl.textContent = 'žádný spoj';
    timeEl.textContent = '';
    if (thenEl) thenEl.textContent = '';
    setDot(dotEl, null);
    return node;
  }

  setDot(dotEl, urgencyColor(next.secondsUntil));

  const f = fmtCountdown(next.secondsUntil);
  numEl.textContent = f.num;
  if (f.isNow) {
    numEl.classList.add('now');
    unitEl.textContent = `(${next.departureTime})`;
    timeEl.textContent = '';
  } else {
    unitEl.textContent = f.unit;
    timeEl.textContent = `· ${next.departureTime}`;
  }

  if (thenEl) {
    if (then) {
      // Both primary and secondary now use the same "pak za X min · HH:MM"
      // format — easier to scan than the abbreviated "pak HH:MM" we had.
      const tf = fmtCountdown(then.secondsUntil);
      thenEl.textContent = tf.isNow
        ? `pak hned · ${then.departureTime}`
        : `pak za ${tf.num} min · ${then.departureTime}`;
    } else {
      thenEl.textContent = '';
    }
  }

  return node;
}

function render(data) {
  // Weather is independent of GTFS — render it whenever we have it, even if
  // departures failed to load.
  renderWeather(data.weather);

  if (!data.ok) {
    // Leave stops alone (initial empty section); footer will show the error.
    return;
  }

  // First configured stop is treated as primary, the rest as secondary —
  // matching the importance hierarchy the user requested.
  const frag = document.createDocumentFragment();
  data.stops.forEach((stop, i) => {
    const priority = i === 0 ? 'primary' : 'secondary';
    frag.appendChild(renderStop(stop, priority));
  });
  STOPS_EL.replaceChildren(frag);
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

const WEATHER_EL = document.getElementById('weather');

// Inline-SVG paths for each pictogram. All draw inside a 40x40 viewBox using
// the parent's currentColor so they pick up the page's foreground.
const WX_ICONS = {
  sun:
    '<circle cx="20" cy="20" r="6"/>' +
    '<line x1="20" y1="5" x2="20" y2="9"/>' +
    '<line x1="20" y1="31" x2="20" y2="35"/>' +
    '<line x1="5" y1="20" x2="9" y2="20"/>' +
    '<line x1="31" y1="20" x2="35" y2="20"/>' +
    '<line x1="9" y1="9" x2="12" y2="12"/>' +
    '<line x1="28" y1="28" x2="31" y2="31"/>' +
    '<line x1="31" y1="9" x2="28" y2="12"/>' +
    '<line x1="9" y1="31" x2="12" y2="28"/>',
  cloud:
    '<path d="M 12 27 Q 6 27 6 22 Q 6 17 11 16 Q 13 11 18 11 Q 23 9 26 13 Q 32 13 32 18 Q 35 19 33 23 Q 32 27 27 27 Z"/>',
  rain:
    '<path d="M 12 22 Q 6 22 6 17 Q 6 12 11 11 Q 13 6 18 6 Q 23 4 26 8 Q 32 8 32 13 Q 35 14 33 18 Q 32 22 27 22 Z"/>' +
    '<line x1="14" y1="26" x2="13" y2="32"/>' +
    '<line x1="20" y1="26" x2="19" y2="32"/>' +
    '<line x1="26" y1="26" x2="25" y2="32"/>',
  snow:
    '<path d="M 12 22 Q 6 22 6 17 Q 6 12 11 11 Q 13 6 18 6 Q 23 4 26 8 Q 32 8 32 13 Q 35 14 33 18 Q 32 22 27 22 Z"/>' +
    '<circle cx="13" cy="29" r="1.2" fill="currentColor"/>' +
    '<circle cx="20" cy="32" r="1.2" fill="currentColor"/>' +
    '<circle cx="27" cy="29" r="1.2" fill="currentColor"/>',
  thunder:
    '<path d="M 12 22 Q 6 22 6 17 Q 6 12 11 11 Q 13 6 18 6 Q 23 4 26 8 Q 32 8 32 13 Q 35 14 33 18 Q 32 22 27 22 Z"/>' +
    '<polyline points="22,25 18,31 22,31 19,36" fill="none"/>',
  fog:
    '<line x1="6" y1="14" x2="34" y2="14"/>' +
    '<line x1="9" y1="20" x2="31" y2="20"/>' +
    '<line x1="6" y1="26" x2="34" y2="26"/>',
};

function pickWxIcon(code) {
  if (code <= 1) return 'sun';
  if (code <= 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'thunder';
  return 'cloud';
}

function renderWeather(wx) {
  if (!wx) {
    WEATHER_EL.hidden = true;
    return;
  }
  WEATHER_EL.hidden = false;

  const iconKey = pickWxIcon(wx.weatherCode);
  WEATHER_EL.querySelector('.wx-icon').innerHTML = WX_ICONS[iconKey];
  WEATHER_EL.querySelector('.wx-temp').textContent = `${wx.tempC}°`;
  WEATHER_EL.querySelector('.wx-desc').textContent = wx.description;

  const aqiEl = WEATHER_EL.querySelector('.wx-aqi');
  const aqiTextEl = WEATHER_EL.querySelector('.wx-aqi-text');
  const sepEl = WEATHER_EL.querySelector('.wx-sep');
  const dotEl = WEATHER_EL.querySelector('.wx-aqi-dot');
  if (wx.aqi != null) {
    aqiTextEl.textContent = `AQI ${wx.aqi} · ${wx.aqiLabel} čistota vzduchu`;
    setDot(dotEl, aqiColor(wx.aqi));
    sepEl.hidden = false;
    aqiEl.hidden = false;
  } else {
    aqiTextEl.textContent = '';
    setDot(dotEl, null);
    sepEl.hidden = true;
    aqiEl.hidden = true;
  }

  renderForecast(wx.hourly);
}

// 12h forecast row: "3–9°  [sparkline]  ☔ 20 %"
function renderForecast(h) {
  const fcastEl = WEATHER_EL.querySelector('.weather-forecast');
  if (!h || !h.points || h.points.length < 2) {
    fcastEl.hidden = true;
    return;
  }
  fcastEl.hidden = false;

  const rangeEl = fcastEl.querySelector('.wx-range');
  rangeEl.textContent = h.tempMin === h.tempMax
    ? `${h.tempMin}°`
    : `${h.tempMin}–${h.tempMax}°`;

  const sparkEl = fcastEl.querySelector('.wx-spark');
  sparkEl.innerHTML = buildSparkline(h.points);

  const rainEl = fcastEl.querySelector('.wx-rain');
  if (h.precipMaxPct == null) {
    rainEl.textContent = '';
    rainEl.classList.remove('wet');
  } else if (h.precipMaxPct === 0) {
    rainEl.textContent = 'bez srážek';
    rainEl.classList.remove('wet');
  } else {
    rainEl.textContent = `max srážky ${h.precipMaxPct} %`;
    // Highlight when rain actually likely.
    rainEl.classList.toggle('wet', h.precipMaxPct >= 30);
  }
}

// Build an SVG <path> covering the next 12 hours' temperature curve, mapped
// into the parent SVG's 100×20 viewBox. We draw a small filled area below the
// line for visual weight, plus the line itself on top. Hours where temp data
// is missing are skipped (line breaks).
function buildSparkline(points) {
  const W = 100, H = 20, PAD = 1;
  const temps = points.map(p => p.tempC).filter(v => typeof v === 'number');
  if (temps.length < 2) return '';

  const tMin = Math.min(...temps);
  const tMax = Math.max(...temps);
  const range = Math.max(1, tMax - tMin); // avoid div-by-zero on flat curves

  const xs = points.map((_, i) => PAD + (i / (points.length - 1)) * (W - 2 * PAD));
  const ys = points.map(p =>
    typeof p.tempC === 'number'
      ? PAD + (1 - (p.tempC - tMin) / range) * (H - 2 * PAD)
      : null
  );

  // Line path: skip nulls with M/L breaks.
  let line = '';
  let pen = 'M';
  for (let i = 0; i < xs.length; i++) {
    if (ys[i] == null) { pen = 'M'; continue; }
    line += `${pen}${xs[i].toFixed(2)} ${ys[i].toFixed(2)} `;
    pen = 'L';
  }

  // Area path: same shape, closed at bottom for a fill.
  let area = '';
  let firstX = null, lastX = null;
  pen = 'M';
  for (let i = 0; i < xs.length; i++) {
    if (ys[i] == null) continue;
    if (firstX == null) firstX = xs[i];
    lastX = xs[i];
    area += `${pen}${xs[i].toFixed(2)} ${ys[i].toFixed(2)} `;
    pen = 'L';
  }
  if (firstX != null) {
    area += `L${lastX.toFixed(2)} ${H} L${firstX.toFixed(2)} ${H} Z`;
  }

  return `
    <path d="${area}" fill="currentColor" fill-opacity="0.15" stroke="none"/>
    <path d="${line.trim()}" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round" stroke-linecap="round"/>
  `;
}

// Alert banner — for now always visible (testing). When time-gating is added
// later, this becomes a function of current time.
const ALERT_EL = document.getElementById('alert');

function renderAlert() {
  // TEMP: always show "Vyndat popelnici". Phase 2 adds the Mon 16:00 → Tue 08:00
  // window check here.
  ALERT_EL.hidden = false;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchDepartures() {
  try {
    const res = await fetch('/api/departures', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    render(data); // renders weather even if !data.ok

    if (!data.ok) {
      lastFetchError = data.error || 'unknown';
    } else {
      lastUpdate = Date.now();
      lastFetchError = null;
      FOOTER_EL.classList.remove('stale');
    }
    tickClock();
  } catch (err) {
    console.error('Fetch failed:', err);
    lastFetchError = err.message;
    tickClock();
  }
}

// Initial + periodic
renderAlert();
fetchDepartures();
setInterval(fetchDepartures, REFRESH_MS);

// Re-fetch when iPad Safari resumes the tab after a sleep / app switch.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') fetchDepartures();
});

// Minute-rollover smoothing: refresh just after each new minute starts so the
// big number ticks down in sync with reality even if next poll is 19s away.
function scheduleMinuteRollover() {
  const now = new Date();
  const ms = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 250;
  setTimeout(() => {
    fetchDepartures();
    scheduleMinuteRollover();
  }, ms);
}
scheduleMinuteRollover();
