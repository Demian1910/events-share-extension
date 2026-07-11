// Tests for the Share Events mini-app logic: convergence under shuffled
// delivery, tombstone authorization, RSVP last-writer-wins merging,
// start-time indexing, sorting, filters, plus-code encoding and the
// map location picker.
// The production files run UNMODIFIED; this file provides the globals they
// reference and then drives them. Runs on macOS's bundled JavaScriptCore
// (no Node.js needed) -- see run_events_tests.sh next to this file.

// --- stubs referenced by the production code ---------------------------------
var tremola = { events: null, contacts: {} };
var curr_scenario = "events";
var myId = "@me.ed25519";
var overlayIsActive = false;
var backendCalls = [];
function backend(s) { backendCalls.push(s); }
function btoa(s) { return "b64(" + s + ")"; } // tagged so calls are inspectable
function unicodeStringToTypedArray(s) { return s; }
function escapeHTML(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
function id2b32(s) { return s.slice(0, 8); }
function closeOverlay() {}
function showGeoMenu() {}
function launch_snackbar() {}
// mimics the tremola_ui.js wiring for the two events scenarios
function setScenario(s) {
    curr_scenario = s;
    if (s == "events") events_load_list();
    else if (s == "events-map") events_render_map();
}
var elements = {};
var document = {
    getElementById: function (id) {
        if (!elements[id]) elements[id] = { innerHTML: "", style: {}, value: "", focus: function () {} };
        return elements[id];
    }
};

// --- helpers ------------------------------------------------------------------
var fails = 0;
function assert(cond, msg) { if (!cond) { fails++; print("FAIL: " + msg); } else print("ok:   " + msg); }
function entry(fid, ref, pub, seq) { return { header: { fid: fid, ref: ref, seq: seq || 1 }, public: pub }; }
function reset() { tremola.events = null; events_sort = "soonest"; events_filter = "all"; backendCalls = []; }

var NOW = Math.floor(Date.now() / 1000);
var IN_BASEL = "8FV9HH6Q+6C";

// adds: old-format (5 elems), scheduled future, scheduled past, soonest;
// tombstones: valid for e1, foreign for e2 (must be ignored);
// rsvps: @b goes to e2 (seq 1) then cancels (seq 2) -> LWW says not going,
//        @me goes to e2, @c rsvps to an event that never arrives.
var ENTRIES = [
    entry("@a.ed25519", "e1", ["EVT", "add", IN_BASEL, "old-format entry", NOW - 100]),
    entry("@a.ed25519", "e2", ["EVT", "add", IN_BASEL, "future event", NOW - 90, NOW + 3600], 2),
    entry("@me.ed25519", "e3", ["EVT", "add", "", "past event", NOW - 80, NOW - 3600]),
    entry("@me.ed25519", "e4", ["EVT", "add", IN_BASEL, "soonest event", NOW - 70, NOW + 600], 2),
    entry("@a.ed25519", "t1", ["EVT", "del", "e1", NOW - 60], 3),
    entry("@evil.ed25519", "t2", ["EVT", "del", "e2", NOW - 50]),
    entry("@b.ed25519", "r1", ["EVT", "rsvp", "e2", 1, NOW - 45], 1),
    entry("@b.ed25519", "r2", ["EVT", "rsvp", "e2", 0, NOW - 35], 2),
    entry("@me.ed25519", "r3", ["EVT", "rsvp", "e2", 1, NOW - 30], 3),
    entry("@c.ed25519", "r4", ["EVT", "rsvp", "e9", 1, NOW - 25], 1),
];

function visibleState(order) {
    reset();
    for (var i = 0; i < order.length; i++) events_new_event(ENTRIES[order[i]]);
    // canonical form: sorted keys and sorted rsvp sets, so JSON comparison is
    // independent of the (legitimately differing) insertion order
    var keys = [];
    for (var k in tremola.events) keys.push(k);
    keys.sort();
    var vis = {};
    for (var j = 0; j < keys.length; j++) {
        var e = tremola.events[keys[j]];
        if (!e.deleted && !e.pending_tombstone)
            vis[keys[j]] = { descr: e.descr, starts: e.starts, going: events_going(e).sort() };
    }
    return vis;
}

// 1) convergence under shuffled delivery — including tombstone-before-add,
//    rsvp-before-add, and @b's cancel (seq 2) arriving before their yes (seq 1)
var orders = [
    [0,1,2,3,4,5,6,7,8,9],
    [9,8,7,6,5,4,3,2,1,0],
    [6,7,1,9,4,0,5,8,3,2],
    [7,6,2,5,9,1,8,4,0,3],
];
var states = [];
for (var i = 0; i < orders.length; i++) states.push(JSON.stringify(visibleState(orders[i])));
var allEqual = true;
for (i = 1; i < states.length; i++) if (states[i] != states[0]) allEqual = false;
assert(allEqual, "convergence: all delivery orders agree (incl. rsvps)");

var vis = visibleState(orders[0]);
assert(!("e1" in vis), "valid tombstone removes own event");
assert("e2" in vis, "foreign tombstone is ignored");
assert(vis["e2"].starts == (NOW + 3600) * 1000, "starts indexed from e.public[5]");
assert(vis["e3"] && vis["e3"].starts == (NOW - 3600) * 1000, "past starts indexed");
events_new_event(entry("@b.ed25519", "e5", ["EVT", "add", "", "no schema field", NOW - 40], 3));
assert(tremola.events["e5"].starts === 0, "old wire format -> starts = 0");

// 2) rsvp semantics
assert(JSON.stringify(vis["e2"].going) == JSON.stringify(["@me.ed25519"]),
    "rsvp LWW: @b's cancel (higher seq) wins in every order; @me going");
assert(!("e9" in vis), "rsvp for an unknown event stays an invisible placeholder");
events_new_event(ENTRIES[7]); // re-deliver @b's cancel
assert(!tremola.events["e2"].rsvps["@b.ed25519"].going, "re-delivery is a no-op (idempotent merge)");
events_new_event(ENTRIES[6]); // late re-delivery of the OLDER yes (seq 1)
assert(!tremola.events["e2"].rsvps["@b.ed25519"].going, "stale lower-seq rsvp cannot resurrect");

// 3) sorting: soonest first = upcoming ascending, then rest newest-added
events_load_list();
var html = elements["lst:events"].innerHTML;
function pos(s) { return html.indexOf(s); }
assert(pos("soonest event") >= 0 && pos("soonest event") < pos("future event"), "upcoming sorted by nearest start");
assert(pos("future event") < pos("no schema field"), "upcoming block before unscheduled");
assert(pos("no schema field") < pos("past event"), "unscheduled/past by newest added");
assert(pos("event_past") >= 0, "past event carries dim class");
assert(pos("1 going") >= 0 && pos("you &#x2713;") >= 0, "list badge: going count incl. self marker");

// 4) filters
events_set_filter("upcoming"); html = elements["lst:events"].innerHTML;
assert(pos("soonest event") >= 0 && pos("past event") < 0 && pos("no schema field") < 0,
    "filter 'upcoming' keeps only future-scheduled events");
events_set_filter("mine"); html = elements["lst:events"].innerHTML;
assert(pos("past event") >= 0 && pos("soonest event") >= 0 && pos("future event") < 0,
    "filter 'mine' keeps only my events");
events_set_filter("located"); html = elements["lst:events"].innerHTML;
assert(pos("soonest event") >= 0 && pos("past event") < 0,
    "filter 'located' keeps only events with a plus code");
events_set_filter("going"); html = elements["lst:events"].innerHTML;
assert(pos("future event") >= 0 && pos("soonest event") < 0 && pos("past event") < 0,
    "filter 'going' keeps only events I rsvp'd yes to");

// 5) publishing: event_add / event_rsvp backend call format
events_set_filter("all");
event_add("hello", NOW + 60);
event_add("hello2", 0);
assert(backendCalls[0].split(" ").pop() == String(NOW + 60), "event_add appends starts");
assert(backendCalls[1].split(" ").pop() == "null", "event_add appends null when unscheduled");

// 6) detail overlay: participants + rsvp toggle (optimistic apply)
events_show_detail("e2");
html = elements["event-detail-overlay"].innerHTML;
assert(pos("1 going: you") >= 0, "detail overlay lists participants");
assert(pos("tap to cancel") >= 0, "detail overlay shows going-state button");
event_rsvp_toggle("e2"); // cancel
assert(backendCalls[backendCalls.length - 1] == "event:rsvp e2 0", "toggle publishes rsvp 0");
html = elements["event-detail-overlay"].innerHTML;
assert(pos("I'm going") >= 0 && pos("tap to cancel") < 0, "overlay re-rendered optimistically");
assert(events_going(tremola.events["e2"]).length === 0, "cancel applied locally");
event_rsvp_toggle("e2"); // and back on
assert(backendCalls[backendCalls.length - 1] == "event:rsvp e2 1", "toggle publishes rsvp 1");

// 7) sort selectors survive re-render (selected attribute)
events_set_sort("newest"); html = elements["lst:events"].innerHTML;
assert(html.indexOf("value='newest' selected") >= 0, "sort selection re-applied after render");
assert(pos("no schema field") < pos("soonest event"), "sort 'newest added' orders by creation");

// 8) plus-code encoder: cell-accurate inverse of the decoder
var rt_ok = true;
for (var la = -89.9; la <= 89.9; la += 13.7) {
    for (var lo = -179.9; lo <= 179.9; lo += 23.3) {
        var sw = olc_decode(olc_encode(la, lo));
        if (!(sw.lat <= la + 1e-6 && la < sw.lat + 0.000125 + 1e-6 &&
              sw.lng <= lo + 1e-6 && lo < sw.lng + 0.000125 + 1e-6))
            rt_ok = false;
    }
}
assert(rt_ok, "olc_encode: every grid point decodes back to its own cell");
var swb = olc_decode(IN_BASEL);
assert(olc_encode(swb.lat, swb.lng) == IN_BASEL, "encoding a cell's SW corner returns the same code");
assert(olc_encode(90, 0) != null && olc_decode(olc_encode(90, 0)) != null, "lat=90 pole edge encodes");

// 9) projection: xy2geo inverts the forward projection used for pins
var g = events_map_geom();
var tlat = 47.5605, tlng = 7.5886; // Mittlere Bruecke
var vx = g.offX + (tlng - g.b.minLng) * g.cosMid * g.scale;
var vy = g.offY + (g.b.maxLat - tlat) * g.scale;
var back = events_map_xy2geo(vx, vy);
assert(Math.abs(back.lat - tlat) < 1e-9 && Math.abs(back.lng - tlng) < 1e-9,
    "events_map_xy2geo inverts the pin projection");

// 10) map location picker flow
document.getElementById("event_descr_input").value = "picnic";
document.getElementById("event_time_input").value = "2026-07-12T14:00";
events_pick_start();
assert(events_pick_mode === true && curr_scenario == "events-map", "pick_start switches to map in pick mode");
html = elements["div:events_map"].innerHTML;
assert(pos("Tap the map") >= 0, "pick mode shows the instruction");
assert(pos("events_show_detail") < 0, "pins are inert while picking");
events_map_pick_at(2, 500); // left of the geographic frame (offX > 0)
assert(events_pick_code === "", "tap outside the frame is ignored");
events_map_pick_at(500, 500);
assert(events_pick_code !== "", "tap inside the frame picks a plus code");
var pp = olc_decode(events_pick_code);
assert(pp != null && pp.lat >= BASEL_BBOX.minLat && pp.lat <= BASEL_BBOX.maxLat &&
    pp.lng >= BASEL_BBOX.minLng && pp.lng <= BASEL_BBOX.maxLng,
    "picked code decodes to a position inside Basel");
html = elements["div:events_map"].innerHTML;
assert(pos("Use location") >= 0 && pos("events_pick_marker") >= 0, "marker and confirm button shown");
var pickedCode = events_pick_code;
events_pick_confirm();
assert(curr_scenario == "events" && events_pick_mode === false, "confirm leaves pick mode");
assert(elements["event_descr_input"].value == "picnic" &&
    elements["event_time_input"].value == "2026-07-12T14:00", "form drafts restored after picking");
assert(elements["event_loc_row"].innerHTML.indexOf(pickedCode) >= 0, "overlay shows the picked location");
event_create_from_input();
assert(backendCalls[backendCalls.length - 1].indexOf("b64(" + pickedCode + ")") == "event:add ".length,
    "picked plus code published instead of the device position");
assert(events_pick_code === "", "pick state cleared after publishing");

// 11) enriched basemap renders in normal (non-pick) mode
events_render_map();
html = elements["div:events_map"].innerHTML;
assert(pos("basel_bridge") >= 0 && pos("basel_river_minor") >= 0, "bridges and tributaries drawn");
assert(pos("Bahnhof SBB") >= 0 && pos("Messe") >= 0, "orientation points labelled");
assert(pos("List view") >= 0, "normal toolbar restored after picking ended");

print(fails === 0 ? "ALL TESTS PASSED" : fails + " FAILURE(S)");
