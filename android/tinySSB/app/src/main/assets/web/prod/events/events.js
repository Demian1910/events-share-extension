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
//   add:  ["EVT", "add", pluscode, description, timestamp, starts?]
//   del:  ["EVT", "del", targetEventId, timestamp]
//   rsvp: ["EVT", "rsvp", targetEventId, going, timestamp]
// starts is the optional scheduled start of the event (seconds since epoch);
// it was appended to the schema later, so old entries simply lack it (-> 0).
//
// Index entry (tremola.events[id]):
//   { id, from, pluscode, descr, when, starts, deleted, rsvps, pending_tombstone? }
//   id     = message ref of the "add" entry (globally unique)
//   from   = author feed id (base64 SSB id)
//   when   = creation time, milliseconds since epoch
//   starts = scheduled start, milliseconds since epoch (0 = not scheduled)
//   rsvps  = { fid: {going, seq, when} } — see below
//
// RSVPs are the one piece of MULTI-author state on an event: everyone appends
// rsvp entries to their own feed only. Per author, the entry with the highest
// sequence number in that author's feed wins (a per-author last-writer-wins
// register). Feed seqs are totally ordered per author and re-delivery carries
// the same seq, so merging is idempotent and commutative: any two devices
// ingesting the same entries in any order converge to the same participant
// set. No wall-clock trust and no coordination needed.

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
            "starts": (e.public[5] || 0) * 1000, // absent in old entries -> 0
            "deleted": deleted,
            // rsvps that arrived before the add live on the placeholder
            "rsvps": (existing && existing.rsvps) || {}
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
                ev = { "id": target, "deleted": false, "pending_tombstone": true };
                tremola.events[target] = ev;
            }
            if (ev.pending_authors == null)
                ev.pending_authors = {}; // placeholder may have been created by an rsvp
            ev.pending_authors[e.header.fid] = true;
        }
    } else if (op == "rsvp") {
        var tid = e.public[2];
        var rev = tremola.events[tid];
        if (!rev) {
            // rsvp seen before its event: same placeholder pattern as
            // tombstones — kept invisible until (and unless) the add arrives
            rev = { "id": tid, "deleted": false, "pending_tombstone": true, "rsvps": {} };
            tremola.events[tid] = rev;
        }
        if (rev.rsvps == null)
            rev.rsvps = {}; // entries indexed before the rsvp feature existed
        var cur = rev.rsvps[e.header.fid];
        // per-author LWW, ordered by the author's own feed sequence number;
        // >= makes re-delivery of the same entry a harmless no-op
        if (cur == null || (e.header.seq || 0) >= (cur.seq || 0))
            rev.rsvps[e.header.fid] = {
                "going": !!e.public[3],
                "seq": e.header.seq || 0,
                "when": (e.public[4] || 0) * 1000
            };
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
// startsSec: optional scheduled start (seconds since epoch, 0 = unscheduled).
function event_add(descr, startsSec) {
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
    backend("event:add " + loc + " " + btoa(unicodeStringToTypedArray(descr))
            + " " + (startsSec > 0 ? startsSec : "null"));
}

// Publish (or update) our own RSVP for an event.
function event_rsvp(eventId, going) {
    backend("event:rsvp " + eventId + " " + (going ? 1 : 0));
    // optimistic local apply, like event_delete: we keep the currently known
    // seq, so the echoed entry (with our real, higher feed seq) confirms it
    events_ensure_store();
    var ev = tremola.events[eventId];
    if (ev) {
        if (ev.rsvps == null)
            ev.rsvps = {};
        var cur = ev.rsvps[myId];
        ev.rsvps[myId] = { "going": going, "seq": cur ? cur.seq : 0, "when": Date.now() };
    }
    events_refresh_view();
}

// fids of everyone currently going (per-author LWW already applied on ingest)
function events_going(ev) {
    var out = [];
    if (ev && ev.rsvps)
        for (var fid in ev.rsvps)
            if (ev.rsvps[fid].going)
                out.push(fid);
    return out;
}

// is the local user going?
function events_i_go(ev) {
    return !!(ev && ev.rsvps && ev.rsvps[myId] && ev.rsvps[myId].going);
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
