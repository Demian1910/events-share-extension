// prod/events/events_ui.js
//
// Event-sharing mini-app: list view (add form, delete confirm).
// The map view lives in events_map.js; both share events_show_detail().

"use strict";

// Render the event list into #lst:events, newest first.
function events_load_list() {
    events_ensure_store();
    var box = document.getElementById("lst:events");
    if (box == null) return;

    var evs = [];
    for (var k in tremola.events) { // no Object.values: keep old WebViews happy
        var x = tremola.events[k];
        if (x && !x.deleted && !x.pending_tombstone)
            evs.push(x);
    }
    evs.sort(function (a, b) { return b.when - a.when; });

    var html = "<div class='event_toolbar'>";
    html += "<button class='event_toolbar_btn' onclick='events_show_map();'>&#x1F5FA; Map view</button>";
    html += "<span class='event_toolbar_info'>" + evs.length + " event(s)</span></div>";

    if (evs.length == 0) {
        box.innerHTML = html + "<div class='event_empty'>No events yet.<br>Tap + to add one.</div>";
        return;
    }

    for (var i = 0; i < evs.length; i++) {
        var ev = evs[i];
        var who = (ev.from in tremola.contacts) ? tremola.contacts[ev.from].alias : id2b32(ev.from);
        var when = ev.when ? new Date(ev.when).toLocaleString() : "";
        var mine = (ev.from == myId);

        html += "<div class='event_item light' onclick=\"events_show_detail('" + ev.id + "')\">";
        html += "<div class='event_descr'>" + escapeHTML(ev.descr) + "</div>";
        html += "<div class='event_meta'>" + escapeHTML(who) + " &middot; " + escapeHTML(when) + "</div>";
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
    event_add(descr);
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
