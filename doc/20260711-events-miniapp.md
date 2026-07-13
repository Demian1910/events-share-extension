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
public_event_add/delete/rsvp ──► publish_public_content ──► own append-only feed
                                                                 │  GOset replication
other device's feed  ──►  sendTinyEventToFrontend  ──►  b2f_new_event
                                                                 │
                     tremola.events index  ◄──  events_new_event ◄┘
```

## Wire format (BIPF list, app tag `EVT`)

| op   | schema                                                 |
|------|--------------------------------------------------------|
| add  | `["EVT", "add", pluscode, description, tst, starts?]`  |
| del  | `["EVT", "del", eventId, tst]`                         |
| rsvp | `["EVT", "rsvp", eventId, going, tst]`                 |

- `pluscode`: Open Location Code of the event position (empty string when
  geolocation is disabled or no fix is available). From the
  `getCurrentLocationAsPlusCode()` bridge.
- `description`: free text, UTF-8 (base64 of UTF-8 bytes over the bridge).
- `eventId`: the message id (`mid`) that the log assigned to the `add` entry —
  globally unique, no coordination needed.
- `tst`: seconds since epoch, informational ordering only.
- `starts`: optional scheduled start of the event (seconds since epoch,
  0 = not scheduled). Appended to the schema after the first release, so old
  entries simply lack the field and are indexed as unscheduled — schema
  evolution by appending keeps old and new clients compatible in both
  directions (old clients ignore the extra element).

The list view sorts on this field ("soonest first": upcoming events by
nearest start, then past/unscheduled ones by creation time) and can filter
by upcoming / mine / with-location / I'm-going; past events are dimmed.

## State: a derived index, not a database

`tremola.events[id] = {id, from, pluscode, descr, when, starts, deleted, rsvps}`
lives in the frontend, persisted with the rest of the `tremola` object and
rebuilt by replaying the log (`restream`). We deliberately did **not** extend a
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

## RSVP: multi-author state without coordination

Add and delete are trivially conflict-free because all state about an event
lives in **one** feed — the creator's — and a single append-only feed is
totally ordered. RSVPs ("I'm going") are the first piece of **multi-author**
state: many participants contribute to one event's participant set, which is
where distributed systems usually need coordination. We get away without any:

- every participant appends `rsvp` entries to **their own** feed only — the
  single-writer-per-feed invariant is never violated;
- per author, the rsvp with the highest sequence number *in that author's
  feed* wins (`tremola.events[id].rsvps[fid] = {going, seq, when}`). Feed
  seqs are totally ordered per author, so "latest" is well-defined without
  trusting wall clocks;
- the merge is idempotent (re-delivery carries the same seq) and commutative
  (a stale lower-seq rsvp can never overwrite a newer one), so any two
  devices ingesting the same entries in any order converge to the same
  participant set — formally, a last-writer-wins register per author, and
  the participant set is the join of these registers;
- an rsvp arriving before its event's `add` is parked on the same invisible
  placeholder used by early tombstones and carried over when the `add` shows
  up.

The UI shows a going-count badge in the list, the participant names plus an
"I'm going / tap to cancel" toggle in the detail overlay, and an "I'm going"
filter. The local toggle is applied optimistically; the echoed log entry
(with the real feed seq) confirms it.

## Design discussion: deletion beyond the creator, and moderation

Today only the creator can delete an event. Could others — say, to remove
spam? In a coordination-free append-only system the question needs to be
reframed first: **nobody can force a remote device to un-see an entry.**
Feeds replicate as-is; "deletion" is always a *local policy decision about
which entries to honour*. What we can design is the policy. Three options,
in increasing order of protocol involvement:

1. **Local hide.** A "hide this event" action that only touches the local
   device (a flag in the derived index, never published). Zero protocol
   change, perfect safety (no one can hide content *for* you), but no
   cooperation: every user hides spam individually.

2. **Trusted tombstones.** Honour a `del` from author *B* for *A*'s event iff
   *B* is trusted by the local user — plugging into tremola's existing
   per-contact trust levels. The log stays identical everywhere; the
   *visible* state becomes subjective, converging only among devices with the
   same trust sets. That subjectivity is not a bug: it is the honest
   expression of what moderation *means* without a central authority. The
   pending-tombstone machinery already stores every del author, so this is a
   view-layer filter (`is del-author trusted?`) — no wire change at all.

3. **Delegated moderators.** The creator lists moderator feed ids in the
   `add` entry; everyone honours tombstones from the creator *or* a listed
   moderator. Objective again (all devices agree, given the same entries) and
   spam of *cooperative* authors is removable — but it needs a wire-format
   extension and does nothing against a hostile author, who simply won't
   delegate.

The deeper lesson, worth stating in a distributed-programming context: the
**data layer converges by construction; any moderation is a locally-chosen
projection of that shared data**. We recommend (2) as future work because it
reuses both the trust machinery and our pending-tombstone bookkeeping, and
because "whom do I believe" is precisely the resource a decentralized system
actually has.

## Map view (offline Basel basemap)

The WebView serves local assets only, so remote tiles (OSM/Leaflet) are not
available offline. The map is a self-contained, **preinstalled schematic
basemap of Basel**, drawn in SVG and georeferenced to a fixed bounding box
(`BASEL_BBOX` in `events_map.js`): the Rhine with its characteristic knee, the
Grossbasel / Kleinbasel districts, a north arrow and a 1/2/5-stepped scale
bar. Events are projected with an equirectangular projection (equal ground
scale on both axes, cos-latitude corrected). Plus codes are decoded to
lat/long by `prod/events/pluscodes.js`, a JS port of `PlusCodesUtils.decode`
(the logic tests round-trip a global grid of positions against an encoder
ported from the same source). Events inside the Basel frame get author-colored
numbered pins that match a tappable legend; events outside the frame or
without a location stay reachable in the legend and list. Pins and legend rows
open a detail overlay shared with the list view.

The map doubles as a **location picker**: from the new-event form, "Pick on
map" switches the map into pick mode — a tap is run through the inverse of
the pin projection (`events_map_xy2geo`) and encoded with `olc_encode`, the
integer-arithmetic inverse of the decoder, so a picked position and a GPS
position travel through exactly the same wire format. This also covers the
indoors-without-internet case where no geolocation source can produce a fix.

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
source can produce a fix — the event is then shared without a location, or
the position can be chosen manually on the map (see above).

## Files

| file | role |
|------|------|
| `utils/Constants.kt` | `TINYSSB_APP_EVENT` tag |
| `WebAppInterface.kt` | `event:add` / `event:delete` / `event:rsvp` handlers, publishing, geolocation |
| `MainActivity.kt` | requests the location permission at startup |
| `web/prod/events/events.js` | EVT dispatch, index, add/delete/rsvp logic |
| `web/prod/events/events_ui.js` | list view, add overlay, delete confirm |
| `web/prod/events/events_map.js` | Basel map view, location picker, detail overlay |
| `web/prod/events/pluscodes.js` | OLC decoder (JS port) + matching encoder |
| `web/prod/events/events.css` | styling |
| `web/prod/events/events.svg` | launcher icon |
| `web/tremola.js` / `tremola_ui.js` / `tremola.html` / `prod/tools.js` | dispatch + scenario wiring + launcher |
| `web/prod/chat.js` / `sketch.js` | chat/sketch sends switched to the non-blocking cached-only location |
| `tests/events_test.js` + `run_events_tests.sh` | logic tests (run against the unmodified production JS) |

## Testing

- **Logic tests** (no device, no Node.js): `android/tinySSB/tests/run_events_tests.sh`
  loads the unmodified production JS into macOS's bundled JavaScriptCore and
  asserts (a) replaying the same entries in several shuffled delivery orders
  converges to the same visible state, (b) tombstones are honoured only from
  the event's author, (c) old-format entries (without `starts`) still index,
  (d) rsvp merging is per-author LWW: idempotent under re-delivery and immune
  to stale lower-seq entries, (e) sorting and all filters produce the
  expected list, (f) the detail overlay renders participants and the rsvp
  toggle publishes/applies correctly, (g) the plus-code encoder round-trips
  against the decoder over a global grid, and the picker flow (inverse
  projection, in-frame guard, draft restore, publish) behaves.
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