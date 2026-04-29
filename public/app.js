'use strict';

const STOP_TEMPLATE = document.getElementById('stop-template');
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

function renderStop(stop) {
  const node = STOP_TEMPLATE.content.cloneNode(true);
  const article = node.querySelector('.stop');
  article.dataset.id = stop.id;
  node.querySelector('.stop-label').textContent = stop.label;

  const numEl = node.querySelector('.next-num');
  const unitEl = node.querySelector('.next-unit');
  const thenEl = node.querySelector('.then');

  const next = stop.departures[0];
  const then = stop.departures[1];

  if (!next) {
    numEl.textContent = '—';
    numEl.classList.add('empty');
    unitEl.textContent = 'žádný spoj';
    thenEl.textContent = '';
  } else if (next.minutesUntil < 1) {
    numEl.textContent = 'teď';
    numEl.classList.add('now');
    unitEl.textContent = `(${next.departureTime})`;
    thenEl.textContent = then ? `pak za ${then.minutesUntil} min` : '';
  } else {
    numEl.textContent = String(next.minutesUntil);
    unitEl.textContent = pluralizeMin(next.minutesUntil);
    thenEl.textContent = then
      ? `pak za ${then.minutesUntil} min · ${then.departureTime}`
      : `· ${next.departureTime}`;
  }

  return node;
}

function render(data) {
  // Build new DOM in a fragment, swap atomically — avoids flicker.
  const frag = document.createDocumentFragment();
  for (const stop of data.stops) frag.appendChild(renderStop(stop));
  STOPS_EL.replaceChildren(frag);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchDepartures() {
  try {
    const res = await fetch('/api/departures', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'unknown');

    render(data);
    lastUpdate = Date.now();
    lastFetchError = null;
    FOOTER_EL.classList.remove('stale');
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
