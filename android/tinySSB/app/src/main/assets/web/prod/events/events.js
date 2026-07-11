// prod/events/events.js
//
// Event-sharing mini-app: logic and in-memory index.
//
// Events are ordinary public-channel log entries, so they replicate with the
// exact same GOset/replica machinery as public chat posts. There is no separate
// storage or sync layer: the index below (tremola.events) is a derived view,
// rebuilt by replaying the log through events_new_event(), and persisted with
// persist() like every other part of the tremola state object.
//
// Wire schema (e.public), produced by WebAppInterface.public_event_*:
//   add: ["EVT", "add", pluscode, description, timestamp]
//   del: ["EVT", "del", targetEventId, timestamp]
//
// Index entry (tremola.events[id]):
//   { id, from, pluscode, descr, when, deleted, pending_tombstone? }
//   id   = message ref of the "add" entry (globally unique)
//   from = author feed id (base64 SSB id)
//   when = milliseconds since epoch

"use strict";

function events_ensure_store() {
    if (tremola.events == null)
        tremola.events = {};
}

// Called from b2f_new_event() for every incoming "EVT" log entry.
function events_new_event(e) {
    events_ensure_store();
    var op = e.public[1];

    if (op == "add") {
        var id = e.header.ref;                 // this entry's own message id = event id
        var existing = tremola.events[id];
        if (existing && !existing.pending_tombstone)
            return;                            // already indexed, ignore duplicate

        // A tombstone may have arrived before its event (out-of-order delivery).
        // Honour a pending tombstone only if THIS event's author is among the
        // authors that published a del for it. We keep the full set of pending
        // authors (not just the first) so the outcome is independent of arrival
        // order: two devices replaying the same entries always agree.
        var deleted = !!(existing && existing.pending_authors && existing.pending_authors[e.header.fid]);

        // Reject anything that is not a well-formed plus code before it is
        // ever stored: a valid code contains only the OLC alphabet, so this
        // also removes any character that could break out of the inline
        // onclick attributes the views build from it (defense at the source).
        var pluscode = e.public[2] || "";
        if (pluscode != "" && olc_decode(pluscode) == null)
            pluscode = "";

        tremola.events[id] = {
            "id": id,
            "from": e.header.fid,
            "pluscode": pluscode,
            "descr": e.public[3] || "",
            "when": (e.public[4] || 0) * 1000,
            "deleted": deleted
        };
    } else if (op == "del") {
        var target = e.public[2];
        var ev = tremola.events[target];
        if (ev && !ev.pending_tombstone) {
            // Append-only per author: a tombstone is valid only for one's own events.
            if (ev.from == e.header.fid)
                ev.deleted = true;
        } else {
            // Tombstone seen before its event (or only other pending tombstones
            // so far): remember EVERY del author for when the add arrives.
            if (!ev) {
                ev = { "id": target, "deleted": false, "pending_tombstone": true, "pending_authors": {} };
                tremola.events[target] = ev;
            }
            ev.pending_authors[e.header.fid] = true;
        }
    } else {
        return;
    }

    events_refresh_view();
}

// Redraw whichever events view is currently on screen.
function events_refresh_view() {
    if (curr_scenario == "events")
        events_load_list();
    else if (curr_scenario == "events-map")
        events_render_map();
}

// Publish a new event. Best-effort geolocation, mirroring prod/chat.js.
function event_add(descr) {
    var pluscode = "";
    try {
        if (typeof Android != 'undefined' && Android.isGeoLocationEnabled() == "true")
            pluscode = Android.getCurrentLocationAsPlusCode();
    } catch (err) {
        pluscode = "";
    }
    var loc = (pluscode && pluscode != "") ? btoa(pluscode) : "null";
    // unicodeStringToTypedArray: UTF-8 bytes so Kotlin's decodeToString()
    // round-trips non-ASCII text (same idiom as chat.js)
    backend("event:add " + loc + " " + btoa(unicodeStringToTypedArray(descr)));
}

// Publish a tombstone for one of our own events.
function event_delete(eventId) {
    backend("event:delete " + eventId);
    // optimistic local hide; the echoed tombstone will confirm it
    events_ensure_store();
    if (eventId in tremola.events)
        tremola.events[eventId].deleted = true;
    events_refresh_view();
}

// --- eof
