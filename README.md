# tram-terminal

Domácí informační displej u vchodových dveří, který ukazuje, za kolik minut jede další tramvaj.

První verze (cesta A): jízdní řády z oficiálního GTFS feedu PMDP. Bez zpoždění, bez real-time. Stabilní a jednoduché. Cesta B (real-time z `/provoz` API) přijde v další iteraci — server už má provider abstraction, kam se to napojí.

## Co to umí

- Stáhne GTFS ZIP z `https://jizdnirady.pmdp.cz/jr/gtfs` při startu a pak jednou denně.
- Pro nakonfigurované zastávky (defaultně **Bazén Slovany → Nám. Republiky** a **U Duhy → Světovar**, oboje linka 2) vrací další 2 odjezdy podle dnešního kalendáře.
- Frontend pro iPad v landscape — světlebéžové pozadí, černý text, velké minutové počítadlo, polling každých 20 s.

## Lokálně

Potřeba Node 20+.

```bash
npm install
npm start
# → http://localhost:3000
```

První spuštění chvilku trvá (stahuje a parsuje GTFS, ~10 MB). V logu uvidíš něco jako:

```
[gtfs] Loaded: { stops: 612, routes: 33, trips: 28940, stopTimes: 880123 }
[gtfs] config "bazen-slovany-republiky" → stop "Bazén Slovany": 2 platform(s); route 2: 1 match(es).
[gtfs] config "u-duhy-svetovar" → stop "U Duhy": 2 platform(s); route 2: 1 match(es).
```

Kdyby u některé zastávky vyjelo `0 platform(s)`, název v `lib/config.js` neodpovídá GTFS přesně. Pomůže si endpointem:

```
http://localhost:3000/api/debug/stops?q=slovany
```

Vrátí všechny názvy zastávek obsahující "slovany", podle toho upravíš `stopName` v configu.

## Endpointy

- `GET /` — iPad UI
- `GET /api/departures` — JSON s odjezdy pro nakonfigurované zastávky
- `GET /api/health` — stav GTFS (loaded / last error)
- `GET /api/debug/stops?q=...` — vyhledávání názvů zastávek v GTFS

## Konfigurace zastávek

Vše je v `lib/config.js`:

```js
exports.STOPS = [
  {
    id: 'bazen-slovany-republiky',           // interní ID, libovolné
    label: 'Bazén Slovany → Nám. Republiky', // co se zobrazí na displeji
    stopName: 'Bazén Slovany',               // přesný název z GTFS
    routeShortName: '2',                     // číslo linky
    directionVia: 'náměstí republiky',       // viz níže
  },
  {
    id: 'u-duhy-svetovar',
    label: 'U Duhy → Světovar',
    stopName: 'U Duhy',
    routeShortName: '2',
    headsignContains: 'světovar',            // viz níže
  },
];
```

Směr jízdy se filtruje jednou ze dvou voleb (vyber tu, která dává smysl):

- **`headsignContains`** — substring názvu konečné z `trip_headsign`. Použij, když směr, který chceš, JE konečná.
- **`directionVia`** — substring názvu libovolné zastávky, kterou spoj projíždí PO té tvojí. Použij, když popisuješ směr přes mezilehlou zastávku. Tramvaj 2 jezdí Skvrňany↔Světovar, takže `trip_headsign` při jízdě "směrem do centra" je "Skvrňany" — ale myslí se tím, že to jede přes Náměstí Republiky. `directionVia: 'náměstí republiky'` to vyřeší.

## Deploy na Railway

1. Repo pushnout na GitHub.
2. V Railway: New Project → Deploy from GitHub Repo → vybrat tento repo.
3. Railway si Node automaticky detekuje (Nixpacks), spustí `npm install` a `node server.js`.
4. V Settings nastavit Custom Domain (nebo použít vygenerovanou `*.up.railway.app` adresu).
5. `PORT` je předaný Railway ENV, server ji bere automaticky.

První deploy zhruba 1–2 minuty. Pak `https://<tvůj-projekt>.up.railway.app/` ukazuje displej.

## iPad u dveří

1. **Auto-Lock vypnout**: Settings → Display & Brightness → Auto-Lock → Never. (iPad bude pořád v zásuvce, baterii řešit nemusíš.)
2. **Otevřít stránku** v Safari.
3. **Add to Home Screen**: tlačítko Sdílet → Přidat na plochu. Spustit z plochy → otevře se ve fullscreen bez horní lišty Safari díky `apple-mobile-web-app-capable`.
4. **Otočit na šířku** a zamknout orientaci v Control Center, pokud je odemčená.
5. **Volitelně**: Guided Access (Settings → Accessibility → Guided Access) zamkne iPad v této jedné aplikaci, takže si ho při úklidu omylem neobsadíš jiným appkem.

## Architektura cesty B (real-time)

V `server.js` je provider abstraction:

```js
async function getDepartures() {
  // Path B (future): try realtime first, fall back to GTFS on failure.
  // const realtime = await getDeparturesRealtime();
  // if (realtime.ok) return realtime;
  return getDeparturesFromGtfs();
}
```

Pro real-time potřebujeme najít interní JSON endpointy, které pohánějí `https://jizdnirady.pmdp.cz/odjezdy` a `/provoz`. Postup:

1. Otevřít `/odjezdy` v desktop Chromu → DevTools → Network tab → vyhledat zastávku → koukat, na jaký endpoint to volá a jaké parametry posílá.
2. Stejné u `/provoz` pro polohy vozidel.
3. Vytvořit `lib/realtime.js`, který tyto endpointy volá a vrací stejnou strukturu jako `getNextDepartures`.
4. V `server.js` pustit realtime jako primární zdroj, GTFS jako fallback.

Slušnost: rozumný User-Agent, polling max 1× za 10 s, server-side caching.

## Licence dat

GTFS data: PMDP, licence CC-BY 4.0. Počasí + AQI: Open-Meteo (CC-BY 4.0), využívá modely národních meteorologických služeb (DWD, NOAA, Météo-France, ECMWF, CAMS pro AQI). V UI je vhodné v patičce uvést atribuci „data PMDP · Open-Meteo", pokud bude veřejně dostupné.

## Počasí + kvalita vzduchu

Server fetchne počasí a kvalitu vzduchu z [Open-Meteo](https://open-meteo.com) — zdarma, bez API klíče. Refresh každých 10 minut (konfigurovatelné v `lib/config.js`).

```js
exports.LOCATION = {
  lat: 49.7475,
  lng: 13.3776,
  label: 'Plzeň',
};
exports.WEATHER_REFRESH_MINUTES = 10;
```

Frontend ukáže ikonu počasí, teplotu, slovní popis a evropský AQI s českou kategorií. Při AQI > 60 (špatná) se číslo zbarví do oranžovo-červené.

Na backend logu uvidíš:

```
[weather] 12° polojasno; AQI 23 (dobrá)
```

Pokud Open-Meteo selže, server si nechá poslední úspěšné čtení v paměti — UI nezmizí kvůli jednomu blbému fetchi.
