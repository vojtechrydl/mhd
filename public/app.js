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
    // Don't hide the whole section silently — show a placeholder so the row
    // still occupies space and the user knows weather is unavailable rather
    // than thinking it's a layout bug. The actual reason (network error,
    // boot lag, etc.) is in the server log.
    WEATHER_EL.hidden = false;
    WEATHER_EL.querySelector('.wx-icon').innerHTML = '';
    WEATHER_EL.querySelector('.wx-temp').textContent = '—';
    WEATHER_EL.querySelector('.wx-desc').textContent = 'počasí nedostupné';
    WEATHER_EL.querySelector('.wx-aqi').hidden = true;
    WEATHER_EL.querySelector('.wx-sep').hidden = true;
    WEATHER_EL.querySelector('.weather-forecast').hidden = true;
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

// 12h forecast row: e.g. "12 h: 8–14° · max srážky 20 %"
function renderForecast(h) {
  const fcastEl = WEATHER_EL.querySelector('.weather-forecast');
  const textEl = fcastEl.querySelector('.wx-fcast');
  if (!h || !h.points || h.points.length < 2) {
    fcastEl.hidden = true;
    return;
  }
  fcastEl.hidden = false;

  const range = h.tempMin === h.tempMax ? `${h.tempMin}°` : `${h.tempMin}–${h.tempMax}°`;
  let rain;
  if (h.precipMaxPct == null) {
    rain = null;
  } else if (h.precipMaxPct === 0) {
    rain = 'bez srážek';
  } else {
    rain = `max srážky ${h.precipMaxPct} %`;
  }

  textEl.textContent = rain
    ? `12 h: ${range}  ·  ${rain}`
    : `12 h: ${range}`;
}

// Alert banner — shown only during the trash-collection prep window.
//
// Collection is Tuesday morning, so the bin needs to go out from Monday 16:00
// at the earliest, until it's emptied (~Tuesday 08:00 to be safe). Outside
// that window the banner stays hidden and doesn't take any layout space.
const ALERT_EL = document.getElementById('alert');

function shouldShowTrashAlert(now) {
  // Test override: append ?alert=1 to the URL to force the banner on, or
  // ?alert=0 to force it off. Useful while iterating outside the real
  // Mon 16:00 → Tue 08:00 window.
  const override = new URLSearchParams(location.search).get('alert');
  if (override === '1') return true;
  if (override === '0') return false;

  // getDay(): 0=Sun, 1=Mon, 2=Tue, …
  // Hours read in the iPad's local time, which for our use is Prague.
  const day = now.getDay();
  const hour = now.getHours();
  if (day === 1 && hour >= 16) return true;  // Monday from 16:00
  if (day === 2 && hour < 8)   return true;  // Tuesday until 08:00
  return false;
}

function renderAlert() {
  ALERT_EL.hidden = !shouldShowTrashAlert(new Date());
}

// ---------------------------------------------------------------------------
// View state — which view is being shown, manual override, geolocation
// ---------------------------------------------------------------------------

const SWITCHER_EL = document.getElementById('view-switcher');
const SOURCE_EL = document.getElementById('updated-source');
const STORAGE_KEY = 'tt:view-state';

// State persisted across reloads in localStorage. Keeping it persistent
// means the user's manual override survives an iPhone re-open, and the last
// known view doesn't briefly flicker before geolocation kicks in.
const state = {
  views: [],                 // [{ id, label, anchor }]
  config: null,              // { geoRadiusM, manualOverrideMinutes, defaultView }
  activeViewId: null,        // currently displayed
  manualOverrideUntil: 0,    // epoch ms; geo logic skipped while > now
  geoNearbyViewId: null,     // last view geo decided is "nearby" (or null)
  geoStatus: 'idle',         // 'idle' | 'requesting' | 'granted' | 'denied' | 'unsupported'
};

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.activeViewId) state.activeViewId = saved.activeViewId;
    if (saved.manualOverrideUntil) state.manualOverrideUntil = saved.manualOverrideUntil;
  } catch (err) {
    console.warn('Failed to load persisted state:', err);
  }
}

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      activeViewId: state.activeViewId,
      manualOverrideUntil: state.manualOverrideUntil,
    }));
  } catch (_) { /* private mode etc. — ignore */ }
}

// Haversine distance between two {lat, lng} coords, in metres.
function geoDistanceM(a, b) {
  const R = 6_371_000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2
          + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Pick the active view by:
//   1. Honour manual override if it's still within its window.
//   2. Snap to whichever view has its anchor within geoRadiusM of the user
//      (closest wins on ties).
//   3. Keep current selection (or fall back to defaultView).
function recomputeActiveView() {
  const now = Date.now();

  // 1. Manual override still hot? Don't touch.
  if (state.manualOverrideUntil > now) return state.activeViewId;

  // 2. Geolocation says we're near a configured view's anchor?
  if (state.geoNearbyViewId) {
    if (state.activeViewId !== state.geoNearbyViewId) {
      state.activeViewId = state.geoNearbyViewId;
      persistState();
    }
    return state.activeViewId;
  }

  // 3. No signal — keep what we had (or fall back).
  if (!state.activeViewId) {
    state.activeViewId = state.config?.defaultView || (state.views[0] && state.views[0].id);
    persistState();
  }
  return state.activeViewId;
}

function setManualView(viewId) {
  if (!state.views.find(v => v.id === viewId)) return;
  state.activeViewId = viewId;
  state.manualOverrideUntil = Date.now() + (state.config.manualOverrideMinutes * 60 * 1000);
  persistState();
  renderSwitcher();
  fetchDepartures();
}

// ---------------------------------------------------------------------------
// View switcher (bottom-of-screen chips)
// ---------------------------------------------------------------------------

function renderSwitcher() {
  if (!state.views.length) {
    SWITCHER_EL.hidden = true;
    return;
  }
  SWITCHER_EL.hidden = false;
  SWITCHER_EL.replaceChildren(...state.views.map(v => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'view-chip';
    btn.dataset.viewId = v.id;
    if (v.id === state.activeViewId) btn.classList.add('active');

    // Marker — geo pin if this view is the geo-detected one, else a dot.
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    marker.setAttribute('class', 'view-chip-marker');
    marker.setAttribute('viewBox', '0 0 16 16');
    marker.setAttribute('aria-hidden', 'true');
    if (v.id === state.geoNearbyViewId) {
      // Pin shape.
      marker.innerHTML =
        '<path d="M8 1 C5 1 3 3 3 6 C3 10 8 15 8 15 C8 15 13 10 13 6 C13 3 11 1 8 1 Z" ' +
        'fill="none" stroke="currentColor" stroke-width="1.4"/>' +
        '<circle cx="8" cy="6" r="1.6" fill="currentColor"/>';
    } else {
      marker.innerHTML = '<circle cx="8" cy="8" r="2.5" fill="currentColor"/>';
    }
    btn.appendChild(marker);

    const label = document.createElement('span');
    label.className = 'view-chip-label';
    label.textContent = v.label;
    btn.appendChild(label);

    btn.addEventListener('click', () => setManualView(v.id));
    return btn;
  }));
}

// ---------------------------------------------------------------------------
// Geolocation — auto-switch the view based on distance from anchor
// ---------------------------------------------------------------------------

function startGeolocation() {
  if (!navigator.geolocation) {
    state.geoStatus = 'unsupported';
    return;
  }
  state.geoStatus = 'requesting';

  // watchPosition keeps us updated as the user moves; on a desk it's quiet,
  // and on the way to/from a stop it'll fire as the user crosses the radius.
  navigator.geolocation.watchPosition(
    (pos) => {
      state.geoStatus = 'granted';
      const userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const radius = state.config?.geoRadiusM || 500;

      // Pick closest view whose anchor is within radius. If none qualify,
      // null (no geo signal) — current selection survives.
      let best = null;
      let bestDist = Infinity;
      for (const v of state.views) {
        const d = geoDistanceM(userLoc, v.anchor);
        if (d <= radius && d < bestDist) {
          best = v;
          bestDist = d;
        }
      }
      const newId = best ? best.id : null;
      if (newId !== state.geoNearbyViewId) {
        state.geoNearbyViewId = newId;
        const prev = state.activeViewId;
        recomputeActiveView();
        renderSwitcher();
        if (state.activeViewId !== prev) fetchDepartures();
      }
    },
    (err) => {
      state.geoStatus = err.code === err.PERMISSION_DENIED ? 'denied' : 'unsupported';
      console.warn('Geolocation error:', err.message);
      // No-op for the UI: state.geoNearbyViewId stays null, active view
      // falls back to manual / default.
    },
    {
      enableHighAccuracy: false,  // city-block accuracy is plenty
      maximumAge: 60_000,         // 1 min cache fine
      timeout: 15_000,
    }
  );
}

// ---------------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------------

async function loadViewsConfig() {
  const res = await fetch('/api/views', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cfg = await res.json();
  state.views = cfg.views;
  state.config = {
    defaultView: cfg.defaultView,
    geoRadiusM: cfg.geoRadiusM,
    manualOverrideMinutes: cfg.manualOverrideMinutes,
  };
  // Pin default view if nothing was persisted.
  if (!state.activeViewId) state.activeViewId = cfg.defaultView;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchDepartures() {
  // Re-evaluate which view is active before each fetch (e.g. geo decided
  // mid-cycle, or override expired) so the UI never lags behind state.
  recomputeActiveView();

  try {
    const url = `/api/departures?view=${encodeURIComponent(state.activeViewId)}`;
    const res = await fetch(url, { cache: 'no-store' });
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

    // Update footer source line — shows whether geo or manual is driving.
    if (SOURCE_EL) {
      const now = Date.now();
      if (state.manualOverrideUntil > now) {
        const minLeft = Math.ceil((state.manualOverrideUntil - now) / 60_000);
        SOURCE_EL.textContent = `· ručně (${minLeft} min)`;
        SOURCE_EL.hidden = false;
      } else if (state.geoNearbyViewId) {
        SOURCE_EL.textContent = '· auto';
        SOURCE_EL.hidden = false;
      } else {
        SOURCE_EL.hidden = true;
      }
    }

    tickClock();
  } catch (err) {
    console.error('Fetch failed:', err);
    lastFetchError = err.message;
    tickClock();
  }
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

(async () => {
  loadPersistedState();
  renderAlert();

  try {
    await loadViewsConfig();
  } catch (err) {
    console.error('Failed to load views config:', err);
    // Without view metadata we can still call the API (it'll return the
    // default view), but no switcher and no geo.
  }

  renderSwitcher();
  fetchDepartures();
  startGeolocation();

  setInterval(fetchDepartures, REFRESH_MS);
  setInterval(renderSwitcher, 60_000); // refresh "ručně (N min)" countdown text

  // Re-fetch when Safari resumes the tab after a sleep / app switch.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fetchDepartures();
  });

  scheduleMinuteRollover();
})();

// Minute-rollover smoothing: refresh just after each new minute starts so the
// big number ticks down in sync with reality even if next poll is 19s away.
// We also re-evaluate the alert here so the trash banner appears/disappears
// on its own at the configured boundary times without needing a reload.
function scheduleMinuteRollover() {
  const now = new Date();
  const ms = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 250;
  setTimeout(() => {
    renderAlert();
    fetchDepartures();
    scheduleMinuteRollover();
  }, ms);
}
