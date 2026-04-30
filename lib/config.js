'use strict';

// Stops we want to display on the home terminal.
//
// Direction matching — pick ONE per stop:
//   - `directionVia`     substring matched against any DOWNSTREAM stop name on
//                        the trip (after our stop). USE THIS WITH PMDP — their
//                        GTFS feed leaves trip_headsign empty for all trips,
//                        so headsignContains will return 0 matches.
//   - `headsignContains` substring of trips.txt > trip_headsign (= terminus
//                        name). Only useful for feeds that actually populate
//                        trip_headsign. Left in as a fallback for other
//                        agencies / future PMDP changes.
//
// Other fields:
//   - `stopName`         matched against GTFS stops.txt > stop_name
//                        (case- and diacritic-insensitive after normalization)
//   - `routeShortName`   exact match against routes.txt > route_short_name
//
// On startup the server logs how many platforms / routes / trips matched each
// entry. If `trips matching direction filter` is 0, hit /api/diagnose for a
// full breakdown.
exports.STOPS = [
  {
    id: 'bazen-slovany-republiky',
    label: 'Bazén Slovany → Centrum',
    stopName: 'Bazén Slovany',
    routeShortName: '2',
    // Direction "into the city" — matches westbound trips that pass NR
    // after leaving Bazén Slovany.
    directionVia: 'náměstí republiky',
  },
  {
    id: 'u-duhy-svetovar',
    label: 'U Duhy → Světovar',
    stopName: 'U Duhy',
    routeShortName: '2',
    // Světovar is the eastern terminus, so any trip leaving U Duhy that later
    // reaches Světovar is going the right way. We can't use headsignContains
    // because PMDP's GTFS leaves trip_headsign empty.
    directionVia: 'světovar',
  },
];

exports.GTFS_URL = 'https://jizdnirady.pmdp.cz/jr/gtfs';

// PMDP refreshes GTFS irregularly (a few times a year), once a day is plenty.
exports.GTFS_REFRESH_HOURS = 24;

// Upcoming departures shown per stop.
exports.DEPARTURES_PER_STOP = 2;

// All time math runs in Prague time, regardless of where Node is running.
exports.SERVER_TZ = 'Europe/Prague';

// Where to show weather + air quality for. Slovany — using Bazén Slovany
// as a representative point for the user's home neighbourhood.
exports.LOCATION = {
  lat: 49.7404,
  lng: 13.4011,
  label: 'Plzeň-Slovany',
};

// Weather doesn't need to be live — air quality even less so.
exports.WEATHER_REFRESH_MINUTES = 10;
