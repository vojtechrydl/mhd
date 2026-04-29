'use strict';

// Stops we want to display on the home terminal.
//
// Direction matching — pick ONE per stop:
//   - `headsignContains` substring of trips.txt > trip_headsign (= terminus
//                        name as PMDP writes it). Use this when the direction
//                        you care about IS the terminus.
//   - `directionVia`     substring matched against any DOWNSTREAM stop name on
//                        the trip (after our stop). Use this when you describe
//                        direction by a mid-route landmark — handy because in
//                        Plzeň the tram 2 westbound trips have headsign
//                        "Skvrňany", but most people think of that direction
//                        as "going through Náměstí Republiky".
//
// Other fields:
//   - `stopName`         exact match against GTFS stops.txt > stop_name
//   - `routeShortName`   exact match against routes.txt > route_short_name
//
// On startup the server logs how many platforms / routes / trips matched each
// entry. If something is zero, tweak the strings here against what you see in
// the logs (or use /api/debug/stops?q=…) and redeploy.
exports.STOPS = [
  {
    id: 'bazen-slovany-republiky',
    label: 'Bazén Slovany → Nám. Republiky',
    stopName: 'Bazén Slovany',
    routeShortName: '2',
    // Tram 2 in Plzeň runs Skvrňany ↔ Světovar. The westbound trip_headsign
    // is "Skvrňany", so we lock onto direction by an intermediate stop.
    directionVia: 'náměstí republiky',
  },
  {
    id: 'u-duhy-svetovar',
    label: 'U Duhy → Světovar',
    stopName: 'U Duhy',
    routeShortName: '2',
    // Světovar IS the terminus, so headsign matching is enough.
    headsignContains: 'světovar',
  },
];

exports.GTFS_URL = 'https://jizdnirady.pmdp.cz/jr/gtfs';

// PMDP refreshes GTFS irregularly (a few times a year), once a day is plenty.
exports.GTFS_REFRESH_HOURS = 24;

// Upcoming departures shown per stop.
exports.DEPARTURES_PER_STOP = 2;

// All time math runs in Prague time, regardless of where Node is running.
exports.SERVER_TZ = 'Europe/Prague';

// Where to show weather + air quality for. Default is Plzeň centre.
exports.LOCATION = {
  lat: 49.7475,
  lng: 13.3776,
  label: 'Plzeň',
};

// Weather doesn't need to be live — air quality even less so.
exports.WEATHER_REFRESH_MINUTES = 10;
