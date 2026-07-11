# Share Events — a georeferenced event-sharing mini-app for Tremola

*Author: Demian Piodi, Anton Bilokon, Tamer Erata — Distributed Programming FS26*

Users add events (location + description) that replicate automatically to
nearby devices and are shown as a list and an offline map of Basel.

## Architecture

The mini-app introduces **no new sync or storage layer**. An event is an
ordinary tinySSB log entry on the author's append-only feed, published on the
public channel and replicated by the existing GOset/replica machinery — the
same path used by public chat messages. Sync is foreground-only: whenever the
app is open and two devices can reach each other (BLE/UDP/websocket), their
frontiers converge and events flow with them.

```
UI (events_ui.js / events_map.js)
   │ backend("event:add …")                 WebView bridge (WebAppInterface)
   ▼
public_event_add/delete  ──►  publish_public_content  ──►  own append-only feed
                                                                 │  GOset replication
other device's feed  ──►  sendTinyEventToFrontend  ──►  b2f_new_event
                                                                 │
                     tremola.events index  ◄──  events_new_event ◄┘
```

## Wire format (BIPF list, app tag `EVT`)

| op  | schema                                        |
|-----|-----------------------------------------------|
| add | `["EVT", "add", pluscode, description, tst]`  |
| del | `["EVT", "del", eventId, tst]`                |

- `pluscode`: Open Location Code of the event position (empty string when
  geolocation is disabled or no fix is available). From the
  `getCurrentLocationAsPlusCode()` bridge.
- `description`: free text, UTF-8 (base64 of UTF-8 bytes over the bridge).
- `eventId`: the message id (`mid`) that the log assigned to the `add` entry —
  globally unique, no coordination needed.
- `tst`: seconds since epoch, informational ordering only.

## State: a derived index, not a database

`tremola.events[id] = {id, from, pluscode, descr, when, deleted}` lives in the
frontend, persisted with the rest of the `tremola` object and rebuilt by
replaying the log (`restream`). We deliberately did **not** extend a
server-side store: the append-only feeds *are* the storage and the source of
truth; everything else is a materialized view. This keeps the app correct
under re-delivery (indexing is idempotent, keyed by `mid`) and free of
migration concerns.

## Deletions and conflicts

tinySSB feeds are append-only per author, so there are no concurrent writes
to the same feed and no merge conflicts by construction. Deletion is a
**tombstone** entry in the author's own feed:

- a tombstone is honoured only if its author equals the author of the
  referenced event (you can only delete your own events);
- out-of-order delivery is handled: a tombstone arriving before its `add` is
  remembered as *pending* (the full set of del-authors is kept), and applied
  when the `add` shows up only if the authors match — so two devices replaying
  the same entries in any order converge to the same visibility;
- the UI hides the local copy optimistically; the echoed tombstone from the
  log confirms it and propagates the deletion to peers.

## Map view (offline Basel basemap)

The WebView serves local assets only, so remote tiles (OSM/Leaflet) are not
available offline. The map is a self-contained, **preinstalled schematic
basemap of Basel**, drawn in SVG and georeferenced to a fixed bounding box
(`BASEL_BBOX` in `events_map.js`): the Rhine with its characteristic knee, the
Grossbasel / Kleinbasel districts, a north arrow and a 1/2/5-stepped scale
bar. Events are projected with an equirectangular projection (equal ground
scale on both axes, cos-latitude corrected). Plus codes are decoded to
lat/long by `prod/events/pluscodes.js`, a JS port of `PlusCodesUtils.decode`
(verified with 20'000 round-trips against an encoder ported from the same
source). Events inside the Basel frame get author-colored numbered pins that
match a tappable legend; events outside the frame or without a location stay
reachable in the legend and list. Pins and legend rows open a detail overlay
shared with the list view.

Untrusted input is handled defensively: a `pluscode` that does not decode as a
valid Open Location Code is dropped at ingest (it can only contain the OLC
alphabet, so it cannot break out of the inline `onclick` attributes the views
build), and descriptions are HTML-escaped as text.

## Geolocation

The position is obtained through the Android framework `LocationManager`. `getCurrentLocationAsPlusCode()`
first takes the best recent, accurate
cached fix, and otherwise listens on GPS and
NETWORK together for a short window and keeps the most accurate fix. The
location runtime permission is requested proactively at startup.

Practical note: **GPS needs a view of the sky and no internet; network
location and A-GPS assistance need internet**. Indoors without internet, no
source can produce a fix — the event is then shared without a location.

## Files

| file | role |
|------|------|
| `utils/Constants.kt` | `TINYSSB_APP_EVENT` tag |
| `WebAppInterface.kt` | `event:add` / `event:delete` handlers, publishing, geolocation |
| `MainActivity.kt` | requests the location permission at startup |
| `web/prod/events/events.js` | EVT dispatch, index, add/delete logic |
| `web/prod/events/events_ui.js` | list view, add overlay, delete confirm |
| `web/prod/events/events_map.js` | Basel map view, detail overlay |
| `web/prod/events/pluscodes.js` | OLC decoder (JS port) |
| `web/prod/events/events.css` | styling |
| `web/prod/events/events.svg` | launcher icon |
| `web/tremola.js` / `tremola_ui.js` / `tremola.html` / `prod/tools.js` | dispatch + scenario wiring + launcher |

## Testing

- **Two devices**: build and install the debug APK
  (`cd android/tinySSB && ./gradlew :app:assembleDebug`, then
  `adb install -r app/build/outputs/apk/debug/app-debug.apk` on each phone).
  Open *Productivity → Share Events*, add an event on one, watch it appear on
  the other. For location, be outdoors (GPS) or connected to the internet
  (network location).
- **Browser-only** (UI without a device): serve the web assets
  (`python3 -m http.server 8321 --directory
  android/tinySSB/app/src/main/assets/web`), open `tremola.html`, and inject
  fake events from the console:
  `b2f_new_event({header:{fid:'@…=.ed25519', ref:'r1', seq:1},
  public:['EVT','add','8FV9HH6Q+6C','hello',1783600000]})`
  (that plus code is in Basel).