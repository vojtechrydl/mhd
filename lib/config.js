'use strict';

// Two named views the user switches between, manually or automatically by
// proximity. Each view has its own list of stops to display, plus an `anchor`
// — a coordinate used by the frontend's geolocation logic to decide "is the
// user near here?". The first stop in each view is the primary one (rendered
// big); the rest are secondary.
//
// Direction matching for each stop — pick ONE:
//   - `directionVia`     substring matched against any DOWNSTREAM stop name
//                        on the trip (after our stop). USE THIS WITH PMDP —
//                        their GTFS leaves trip_headsign empty for all trips.
//   - `headsignContains` substring of trip_headsign. Useless on PMDP feeds
//                        right now; kept as future-proofing.
//
// Other stop fields:
//   - `stopName`         matched against GTFS stops.txt > stop_name (case-
//                        and diacritic-insensitive after normalization)
//   - `routeShortName`   exact match against routes.txt > route_short_name
//
// Hit /api/diagnose?view=<id> if anything looks off after a config change.

exports.VIEWS = {
  domov: {
    id: 'domov',
    label: 'Doma → ven',
    // Anchor near Bazén Slovany — the primary stop. Geolocation logic snaps
    // to this view when the user is within `GEO_RADIUS_M` of the anchor.
    anchor: { lat: 49.7404, lng: 13.4011 },
    stops: [
      {
        id: 'bazen-slovany-centrum',
        label: 'Bazén Slovany → Centrum',
        stopName: 'Bazén Slovany',
        routeShortName: '2',
        directionVia: 'náměstí republiky',
      },
      {
        id: 'u-duhy-svetovar',
        label: 'U Duhy → Světovar',
        stopName: 'U Duhy',
        routeShortName: '2',
        directionVia: 'světovar',
      },
    ],
  },

  centrum: {
    id: 'centrum',
    label: 'Centrum → domů',
    // Anchor at Náměstí Republiky.
    anchor: { lat: 49.7475, lng: 13.3776 },
    stops: [
      {
        id: 'republiky-svetovar',
        label: 'Nám. Republiky → Světovar',
        stopName: 'Náměstí Republiky',
        routeShortName: '2',
        // Tram 2 runs Skvrňany ↔ Světovar; eastbound trips through Republiky
        // continue to Světovar.
        directionVia: 'světovar',
      },
      {
        id: 'republiky-slovany',
        label: 'Nám. Republiky → Slovany',
        stopName: 'Náměstí Republiky',
        routeShortName: '1',
        // Line 1's southern terminus is Slovany. Any trip leaving Republiky
        // that ends up at a stop containing "slovany" downstream is going
        // the right way.
        directionVia: 'slovany',
      },
    ],
  },
};

// View used when the request has no ?view=... param. The frontend always
// sends one explicitly, so this is mostly a safety net for direct API hits.
exports.DEFAULT_VIEW = 'domov';

// Geolocation behaviour for the frontend auto-switcher. Picked larger than a
// city block so being near a stop doesn't require pinpoint accuracy on phone
// GPS, which can be 50–100 m off indoors.
exports.GEO_RADIUS_M = 500;

// How long a manual tap on the bottom switcher locks out auto-switching.
exports.MANUAL_OVERRIDE_MINUTES = 30;

exports.GTFS_URL = 'https://jizdnirady.pmdp.cz/jr/gtfs';

// PMDP refreshes GTFS irregularly (a few times a year), once a day is plenty.
exports.GTFS_REFRESH_HOURS = 24;

// Upcoming departures shown per stop.
exports.DEPARTURES_PER_STOP = 2;

// All time math runs in Prague time, regardless of where Node is running.
exports.SERVER_TZ = 'Europe/Prague';

// Where to show weather + air quality for. Slovany — close to home, since
// that's where weather decisions get made (jacket on the way out).
exports.LOCATION = {
  lat: 49.7404,
  lng: 13.4011,
  label: 'Plzeň-Slovany',
};

// Weather doesn't need to be live — air quality even less so.
exports.WEATHER_REFRESH_MINUTES = 10;
