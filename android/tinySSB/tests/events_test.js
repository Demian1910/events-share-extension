// Tests for the Share Events mini-app logic: convergence under shuffled
// delivery, tombstone authorization, start-time indexing, sorting, filters.
// The production files run UNMODIFIED; this file provides the globals they
// reference and then drives them. Runs on macOS's bundled JavaScriptCore
// (no Node.js needed) -- see run_events_tests.sh next to this file.

// --- stubs referenced by the production code ---------------------------------
var tremola = { events: null, contacts: {} };
var curr_scenario = "events";
var myId = "@me.ed25519";
var backendCalls = [];
function backend(s) { backendCalls.push(s); }
function btoa(s) { return "b64"; } // only used inside event_add, value unchecked
function unicodeStringToTypedArray(s) { return s; }
function escapeHTML(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
function id2b32(s) { return s.slice(0, 8); }
function events_render_map() {}
function events_show_map() {}
function showGeoMenu() {}
var listBox = { innerHTML: "" };
var document = { getElementById: function (id) { return id == "lst:events" ? listBox : null; } };

// --- helpers ------------------------------------------------------------------
var fails = 0;
function assert(cond, msg) { if (!cond) { fails++; print("FAIL: " + msg); } else print("ok:   " + msg); }
function entry(fid, ref, pub) { return { header: { fid: fid, ref: ref, seq: 1 }, public: pub }; }
function reset() { tremola.events = null; events_sort = "soonest"; events_filter = "all"; backendCalls = []; }

var NOW = Math.floor(Date.now() / 1000);
var IN_BASEL = "8FV9HH6Q+6C";

// old-format add (5 elems), scheduled future, scheduled past, soonest,
// valid tombstone for e1, foreign tombstone for e2 (must be ignored)
var ENTRIES = [
    entry("@a.ed25519", "e1", ["EVT", "add", IN_BASEL, "old-format entry", NOW - 100]),
    entry("@a.ed25519", "e2", ["EVT", "add", IN_BASEL, "future event", NOW - 90, NOW + 3600]),
    entry("@me.ed25519", "e3", ["EVT", "add", "", "past event", NOW - 80, NOW - 3600]),
    entry("@me.ed25519", "e4", ["EVT", "add", IN_BASEL, "soonest event", NOW - 70, NOW + 600]),
    entry("@a.ed25519", "t1", ["EVT", "del", "e1", NOW - 60]),
    entry("@evil.ed25519", "t2", ["EVT", "del", "e2", NOW - 50]),
];

function visibleState(order) {
    reset();
    for (var i = 0; i < order.length; i++) events_new_event(ENTRIES[order[i]]);
    // canonical order: JSON.stringify follows insertion order, which
    // legitimately differs per delivery order — sort keys before comparing
    var keys = [];
    for (var k in tremola.events) keys.push(k);
    keys.sort();
    var vis = {};
    for (var j = 0; j < keys.length; j++) {
        var e = tremola.events[keys[j]];
        if (!e.deleted && !e.pending_tombstone) vis[keys[j]] = { descr: e.descr, starts: e.starts };
    }
    return vis;
}

// 1) convergence under shuffled delivery
var orders = [[0,1,2,3,4,5],[5,4,3,2,1,0],[4,0,5,1,3,2],[2,5,1,4,0,3]];
var states = [];
for (var i = 0; i < orders.length; i++) states.push(JSON.stringify(visibleState(orders[i])));
var allEqual = true;
for (i = 1; i < states.length; i++) if (states[i] != states[0]) allEqual = false;
assert(allEqual, "convergence: all delivery orders agree");

var vis = visibleState(orders[0]);
assert(!("e1" in vis), "valid tombstone removes own event");
assert("e2" in vis, "foreign tombstone is ignored");
assert(vis["e2"].starts == (NOW + 3600) * 1000, "starts indexed from e.public[5]");
assert(vis["e3"] && vis["e3"].starts == (NOW - 3600) * 1000, "past starts indexed");
events_new_event(entry("@b.ed25519", "e5", ["EVT", "add", "", "no schema field", NOW - 40]));
assert(tremola.events["e5"].starts === 0, "old wire format -> starts = 0");

// 2) sorting: soonest first = upcoming ascending, then rest newest-added
events_load_list();
var html = listBox.innerHTML;
function pos(s) { return html.indexOf(s); }
assert(pos("soonest event") >= 0 && pos("soonest event") < pos("future event"), "upcoming sorted by nearest start");
assert(pos("future event") < pos("no schema field"), "upcoming block before unscheduled");
assert(pos("no schema field") < pos("past event"), "unscheduled/past by newest added");
assert(pos("event_past") >= 0, "past event carries dim class");
assert(pos("(past)") >= 0, "past label rendered");

// 3) filters
events_set_filter("upcoming"); html = listBox.innerHTML;
assert(pos("soonest event") >= 0 && pos("past event") < 0 && pos("no schema field") < 0,
    "filter 'upcoming' keeps only future-scheduled events");
events_set_filter("mine"); html = listBox.innerHTML;
assert(pos("past event") >= 0 && pos("soonest event") >= 0 && pos("future event") < 0,
    "filter 'mine' keeps only my events");
events_set_filter("located"); html = listBox.innerHTML;
assert(pos("soonest event") >= 0 && pos("past event") < 0,
    "filter 'located' keeps only events with a plus code");

// 4) publishing: event_add forwards starts (or null) to the backend
event_add("hello", NOW + 60);
event_add("hello2", 0);
assert(backendCalls[0].split(" ").pop() == String(NOW + 60), "event_add appends starts");
assert(backendCalls[1].split(" ").pop() == "null", "event_add appends null when unscheduled");

// 5) sort selectors survive re-render (selected attribute)
events_set_filter("all"); events_set_sort("newest"); html = listBox.innerHTML;
assert(html.indexOf("value='newest' selected") >= 0, "sort selection re-applied after render");
assert(pos("no schema field") < pos("soonest event"), "sort 'newest added' orders by creation");

print(fails === 0 ? "ALL TESTS PASSED" : fails + " FAILURE(S)");
