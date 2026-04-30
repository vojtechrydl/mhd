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
      // Primary: full "pak za 15 min · 20:02".
      // Secondary: compact "pak 20:02" — minute count is redundant when the
      // row already exists at small scale.
      if (priority === 'primary') {
        const tf = fmtCountdown(then.secondsUntil);
        thenEl.textContent = tf.isNow
          ? `pak hned · ${then.departureTime}`
          : `pak za ${tf.num} min · ${then.departureTime}`;
      } else {
        thenEl.textContent = `pak ${then.departureTime}`;
      }
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
