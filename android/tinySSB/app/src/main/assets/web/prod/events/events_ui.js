// prod/events/events_ui.js
//
// Event-sharing mini-app: list view (add form, delete confirm).
// The map view lives in events_map.js; both share events_show_detail().

"use strict";

// List-view presentation state. Not persisted on purpose: it is per-screen
// UI state, not shared data — every device may sort/filter differently.
var events_sort = "soonest"; // soonest | newest | oldest
var events_filter = "all";   // all | upcoming | mine | located

function events_set_sort(v) { events_sort = v; events_load_list(); }
function events_set_filter(v) { events_filter = v; events_load_list(); }

// "Sat, 12/07/2026, 14:00" style label for a scheduled start (ms since epoch).
function events_fmt_starts(ms) {
    var d = new Date(ms);
    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return days[d.getDay()] + ", " + d.toLocaleDateString() + ", " +
        ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
}

// Render the event list into #lst:events, honouring the sort/filter selectors.
function events_load_list() {
    events_ensure_store();
    var box = document.getElementById("lst:events");
    if (box == null) return;
    var now = Date.now();

    var evs = [];
    for (var k in tremola.events) { // no Object.values: keep old WebViews happy
        var x = tremola.events[k];
        if (!x || x.deleted || x.pending_tombstone)
            continue;
        if (events_filter == "upcoming" && !(x.starts > now))
            continue;
        if (events_filter == "mine" && x.from != myId)
            continue;
        if (events_filter == "located" && !(x.pluscode && x.pluscode != ""))
            continue;
        evs.push(x);
    }

    if (events_sort == "newest")
        evs.sort(function (a, b) { return b.when - a.when; });
    else if (events_sort == "oldest")
        evs.sort(function (a, b) { return a.when - b.when; });
    else { // soonest: upcoming events first (nearest start on top),
           // then everything else (past / unscheduled) by newest added
        evs.sort(function (a, b) {
            var au = a.starts > now, bu = b.starts > now;
            if (au != bu) return au ? -1 : 1;
            if (au) return a.starts - b.starts;
            return b.when - a.when;
        });
    }

    var html = "<div class='event_toolbar'>";
    html += "<button class='event_toolbar_btn' onclick='events_show_map();'>&#x1F5FA; Map view</button>";
    html += "<span class='event_toolbar_info'>" + evs.length + " event(s)</span></div>";

    // sort / filter selectors (values re-applied after each re-render)
    var sel = function (v, cur) { return v == cur ? " selected" : ""; };
    html += "<div class='event_toolbar event_filterbar'>";
    html += "<select class='event_select' onchange='events_set_sort(this.value)'>";
    html += "<option value='soonest'" + sel("soonest", events_sort) + ">&#x23F0; Soonest first</option>";
    html += "<option value='newest'" + sel("newest", events_sort) + ">Newest added</option>";
    html += "<option value='oldest'" + sel("oldest", events_sort) + ">Oldest added</option>";
    html += "</select>";
    html += "<select class='event_select' onchange='events_set_filter(this.value)'>";
    html += "<option value='all'" + sel("all", events_filter) + ">All events</option>";
    html += "<option value='upcoming'" + sel("upcoming", events_filter) + ">Upcoming only</option>";
    html += "<option value='mine'" + sel("mine", events_filter) + ">Mine only</option>";
    html += "<option value='located'" + sel("located", events_filter) + ">With location</option>";
    html += "</select></div>";

    if (evs.length == 0) {
        box.innerHTML = html + "<div class='event_empty'>" +
            (events_filter == "all" ? "No events yet.<br>Tap + to add one."
                                    : "No events match this filter.") + "</div>";
        return;
    }

    for (var i = 0; i < evs.length; i++) {
        var ev = evs[i];
        var who = (ev.from in tremola.contacts) ? tremola.contacts[ev.from].alias : id2b32(ev.from);
        var when = ev.when ? new Date(ev.when).toLocaleString() : "";
        var mine = (ev.from == myId);
        var past = ev.starts > 0 && ev.starts <= now;

        html += "<div class='event_item light" + (past ? " event_past" : "") +
            "' onclick=\"events_show_detail('" + ev.id + "')\">";
        html += "<div class='event_descr'>" + escapeHTML(ev.descr) + "</div>";
        if (ev.starts > 0)
            html += "<div class='event_starts'>&#x1F4C5; " + escapeHTML(events_fmt_starts(ev.starts)) +
                (past ? " (past)" : "") + "</div>";
        html += "<div class='event_meta'>" + escapeHTML(who) + " &middot; added " + escapeHTML(when) + "</div>";
        html += "<div class='event_actions'>";
        if (ev.pluscode && ev.pluscode != "")
            html += "<button class='event_loc_btn' onclick='event.stopPropagation(); showGeoMenu(\"" + ev.pluscode + "\")'>&#x1F4CD; " + escapeHTML(ev.pluscode) + "</button>";
        if (mine)
            html += "<button class='event_del_btn' onclick='event.stopPropagation(); event_confirm_delete(\"" + ev.id + "\")'>Delete</button>";
        html += "</div></div>";
    }
    box.innerHTML = html;
}

// Invoked by the + FAB while in the events scenario (see plus_button()).
function menu_new_event() {
    closeOverlay();
    var inp = document.getElementById('event_descr_input');
    inp.value = "";
    document.getElementById('event_time_input').value = "";
    document.getElementById('overlay-bg').style.display = 'initial';
    document.getElementById('new_event-overlay').style.display = 'initial';
    overlayIsActive = true;
    inp.focus();
}

function event_create_from_input() {
    var descr = document.getElementById('event_descr_input').value.trim();
    if (descr == "") {
        launch_snackbar("Please enter a description");
        return;
    }
    // optional scheduled start: datetime-local is wall-clock local time,
    // new Date() interprets it in the device timezone
    var starts = 0;
    var tval = document.getElementById('event_time_input').value;
    if (tval) {
        var t = new Date(tval).getTime();
        if (!isNaN(t))
            starts = Math.floor(t / 1000);
    }
    event_add(descr, starts);
    closeOverlay();
    launch_snackbar("Event shared");
}

function event_confirm_delete(eventId) {
    launch_toast("Delete event",
        "Remove this event? A tombstone is appended to your feed and syncs to others.",
        function () { event_delete(eventId); closeOverlay(); },
        function () { closeOverlay(); });
}

// --- eof
