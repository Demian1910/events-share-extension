// prod/events/events_map.js
//
// Event-sharing mini-app: phase-2 map view.
//
// The WebView serves local assets only (no network), so remote map tiles are
// not an option. The map is a self-contained, preinstalled schematic basemap
// of BASEL, drawn in SVG and georeferenced to a fixed bounding box (the Rhine
// with its characteristic knee, plus the Grossbasel / Kleinbasel districts).
// Events are projected onto it with an equirectangular projection (equal
// ground scale on both axes). Pin colors follow the author's contact color;
// tapping a pin or a legend row opens the shared detail overlay.

"use strict";

// Fixed geographic frame of the preinstalled basemap (the city of Basel).
var BASEL_BBOX = { "minLat": 47.530, "maxLat": 47.600, "minLng": 7.550, "maxLng": 7.640 };

// Approximate real course of the Rhine through Basel (lat, lng), south-east
// entry -> Mittlere Bruecke -> Rhine knee -> north exit toward Kleinhueningen.
var BASEL_RHINE = [
    [47.5470, 7.6150], [47.5520, 7.6020], [47.5580, 7.5920], [47.5605, 7.5885],
    [47.5640, 7.5850], [47.5690, 7.5840], [47.5760, 7.5870], [47.5850, 7.5920]
];

var BASEL_LABELS = [
    { "lat": 47.5535, "lng": 7.5790, "text": "Grossbasel" },
    { "lat": 47.5690, "lng": 7.6010, "text": "Kleinbasel" }
];

function events_show_map() {
    events_pick_mode = false; // entering as a viewer, not from the add form
    setScenario('events-map');
}

function events_show_list() {
    setScenario('events');
}

// --- location picking (from the new-event overlay) --------------------------

var events_pick_mode = false;

// The overlay's "Pick on map" button: park the form drafts, switch to the
// map and wait for a tap.
function events_pick_start() {
    events_draft_descr = document.getElementById('event_descr_input').value;
    events_draft_time = document.getElementById('event_time_input').value;
    events_pick_code = "";
    events_pick_mode = true;
    closeOverlay();
    setScenario('events-map');
}

function events_pick_cancel() {
    events_pick_mode = false;
    events_pick_code = "";
    setScenario('events');
    menu_new_event(true); // restore the parked drafts
}

function events_pick_confirm() {
    events_pick_mode = false;
    setScenario('events');
    menu_new_event(true);
}

// DOM click on the SVG -> viewBox coordinates (the SVG is scaled to the
// screen, the viewBox is a fixed 1000x1000)
function events_map_click(ev) {
    var r = ev.currentTarget.getBoundingClientRect();
    events_map_pick_at((ev.clientX - r.left) * 1000 / r.width,
                       (ev.clientY - r.top) * 1000 / r.height);
}

// Pure part (unit-tested): accept taps inside the geographic frame only,
// encode the position as the event's plus code and show the marker.
function events_map_pick_at(vx, vy) {
    if (!events_pick_mode)
        return;
    var p = events_map_xy2geo(vx, vy);
    var b = BASEL_BBOX;
    if (p.lat < b.minLat || p.lat > b.maxLat || p.lng < b.minLng || p.lng > b.maxLng)
        return;
    events_pick_code = olc_encode(p.lat, p.lng);
    events_render_map();
}

// Collect visible events; decode plus codes and split by whether they fall
// inside the Basel basemap frame.
function events_map_collect() {
    events_ensure_store();
    var inside = [], outside = [], unlocated = 0;
    for (var k in tremola.events) {
        var ev = tremola.events[k];
        if (!ev || ev.deleted || ev.pending_tombstone)
            continue;
        var pos = olc_decode(ev.pluscode);
        if (pos == null) {
            unlocated++;
            continue;
        }
        var rec = { "ev": ev, "lat": pos.lat, "lng": pos.lng };
        if (pos.lat >= BASEL_BBOX.minLat && pos.lat <= BASEL_BBOX.maxLat &&
            pos.lng >= BASEL_BBOX.minLng && pos.lng <= BASEL_BBOX.maxLng)
            inside.push(rec);
        else
            outside.push(rec);
    }
    inside.sort(function (a, b) { return b.ev.when - a.ev.when; });
    outside.sort(function (a, b) { return b.ev.when - a.ev.when; });
    return { "inside": inside, "outside": outside, "unlocated": unlocated };
}

function events_author_color(fid) {
    return (fid in tremola.contacts) ? tremola.contacts[fid].color : "#777777";
}

// Fixed Basel projection (equirectangular, equal ground scale on both axes)
// in viewBox coordinates; shared by rendering and the tap-to-pick inverse.
function events_map_geom() {
    var W = 1000;
    var b = BASEL_BBOX;
    var cosMid = Math.cos(((b.minLat + b.maxLat) / 2) * Math.PI / 180);
    var gw = (b.maxLng - b.minLng) * cosMid;   // ground width  (lat-deg equiv)
    var gh = (b.maxLat - b.minLat);            // ground height
    var scale = W / Math.max(gw, gh);
    return {
        "W": W, "b": b, "cosMid": cosMid, "gw": gw, "gh": gh, "scale": scale,
        "offX": (W - gw * scale) / 2, "offY": (W - gh * scale) / 2
    };
}

// inverse projection: viewBox x/y back to geographic coordinates
function events_map_xy2geo(vx, vy) {
    var g = events_map_geom();
    return {
        "lat": g.b.maxLat - (vy - g.offY) / g.scale,
        "lng": g.b.minLng + (vx - g.offX) / (g.cosMid * g.scale)
    };
}

function events_render_map() {
    var box = document.getElementById('div:events_map');
    if (box == null)
        return;
    var c = events_map_collect();
    var inside = c.inside, i, p;

    var html = "<div class='event_toolbar'>";
    if (events_pick_mode) {
        // picking a location for a new event: instruction/result + actions
        html += "<span class='event_toolbar_info'>" + (events_pick_code != ""
            ? "&#x1F4CD; " + escapeHTML(events_pick_code)
            : "Tap the map to place your event") + "</span>";
        if (events_pick_code != "")
            html += "<button class='event_toolbar_btn' onclick='events_pick_confirm();'>&#x2714; Use location</button>";
        html += "<button class='event_toolbar_btn' onclick='events_pick_cancel();'>Cancel</button>";
    } else {
        html += "<button class='event_toolbar_btn' onclick='events_show_list();'>&#9776; List view</button>";
        html += "<span class='event_toolbar_info'>" + inside.length + " in Basel";
        if (c.outside.length > 0) html += ", " + c.outside.length + " outside";
        if (c.unlocated > 0) html += ", " + c.unlocated + " no location";
        html += "</span>";
    }
    html += "</div>";

    var g = events_map_geom();
    var W = g.W, b = g.b, cosMid = g.cosMid, gw = g.gw, gh = g.gh,
        scale = g.scale, offX = g.offX, offY = g.offY;
    var px = function (lng) { return offX + (lng - b.minLng) * cosMid * scale; };
    var py = function (lat) { return offY + (b.maxLat - lat) * scale; };

    var svg = "<div class='events_map_wrap'>";
    svg += "<svg viewBox='0 0 " + W + " " + W + "' class='events_map_svg' " +
        (events_pick_mode ? "onclick='events_map_click(event)' style='cursor: crosshair;' " : "") +
        "xmlns='http://www.w3.org/2000/svg'>";
    svg += "<rect x='0' y='0' width='" + W + "' height='" + W + "' class='events_map_frame'/>";
    // land area of the basemap
    svg += "<rect x='" + offX + "' y='" + offY + "' width='" + (gw * scale) + "' height='" + (gh * scale) + "' class='basel_land'/>";

    // the Rhine
    var d = "";
    for (i = 0; i < BASEL_RHINE.length; i++)
        d += (i === 0 ? "M" : "L") + px(BASEL_RHINE[i][1]).toFixed(1) + "," + py(BASEL_RHINE[i][0]).toFixed(1) + " ";
    svg += "<path d='" + d + "' class='basel_rhine'/>";

    // watermark + district labels
    svg += "<text x='" + (W / 2) + "' y='" + (offY + 70) + "' text-anchor='middle' class='basel_watermark'>BASEL</text>";
    for (i = 0; i < BASEL_LABELS.length; i++) {
        var L = BASEL_LABELS[i];
        svg += "<text x='" + px(L.lng).toFixed(1) + "' y='" + py(L.lat).toFixed(1) + "' text-anchor='middle' class='basel_label'>" + L.text + "</text>";
    }

    // north arrow (top-right)
    svg += "<g class='basel_compass'><line x1='" + (W - 55) + "' y1='40' x2='" + (W - 55) + "' y2='95'/>";
    svg += "<path d='M" + (W - 55) + " 32 L" + (W - 45) + " 52 L" + (W - 65) + " 52 Z'/>";
    svg += "<text x='" + (W - 55) + "' y='115' text-anchor='middle' class='basel_compass_txt'>N</text></g>";

    // scale bar: largest nice 1/2/5*10^k meters below 1/3 of the drawn width
    var metersPerPx = 111320 / scale;
    var target = (gw * scale) / 3 * metersPerPx;
    var nice = Math.pow(10, Math.floor(Math.log(target) / Math.LN10));
    if (target / nice >= 5) nice *= 5; else if (target / nice >= 2) nice *= 2;
    var barPx = nice / metersPerPx;
    var barLabel = nice >= 1000 ? (nice / 1000) + " km" : nice + " m";
    var bx = offX + 30, byy = W - offY - 40;
    svg += "<line x1='" + bx + "' y1='" + byy + "' x2='" + (bx + barPx) + "' y2='" + byy + "' class='events_map_scale'/>";
    svg += "<line x1='" + bx + "' y1='" + (byy - 12) + "' x2='" + bx + "' y2='" + (byy + 12) + "' class='events_map_scale'/>";
    svg += "<line x1='" + (bx + barPx) + "' y1='" + (byy - 12) + "' x2='" + (bx + barPx) + "' y2='" + (byy + 12) + "' class='events_map_scale'/>";
    svg += "<text x='" + (bx + barPx / 2) + "' y='" + (byy - 20) + "' text-anchor='middle' class='events_map_scale_txt'>" + barLabel + "</text>";

    // pins (numbering matches the legend, newest first); while picking they
    // are inert context — their clicks must not open the detail overlay
    for (i = 0; i < inside.length; i++) {
        p = inside[i];
        var x = px(p.lng), y = py(p.lat);
        svg += events_pick_mode
            ? "<g class='events_map_pin' style='pointer-events: none;' opacity='0.5'>"
            : "<g class='events_map_pin' onclick=\"events_show_detail('" + p.ev.id + "')\">";
        svg += "<circle cx='" + x.toFixed(1) + "' cy='" + y.toFixed(1) + "' r='22' fill='" + events_author_color(p.ev.from) + "' stroke='white' stroke-width='4'/>";
        svg += "<text x='" + x.toFixed(1) + "' y='" + (y + 8).toFixed(1) + "' text-anchor='middle' class='events_map_pin_txt'>" + (i + 1) + "</text>";
        svg += "</g>";
    }

    // crosshair marker for the picked position
    if (events_pick_mode && events_pick_code != "") {
        var pc = olc_decode(events_pick_code);
        if (pc != null) {
            var mx = px(pc.lng + 0.0000625), my = py(pc.lat + 0.0000625); // cell center
            svg += "<g class='events_pick_marker' style='pointer-events: none;'>";
            svg += "<circle cx='" + mx.toFixed(1) + "' cy='" + my.toFixed(1) + "' r='26'/>";
            svg += "<line x1='" + (mx - 40).toFixed(1) + "' y1='" + my.toFixed(1) + "' x2='" + (mx + 40).toFixed(1) + "' y2='" + my.toFixed(1) + "'/>";
            svg += "<line x1='" + mx.toFixed(1) + "' y1='" + (my - 40).toFixed(1) + "' x2='" + mx.toFixed(1) + "' y2='" + (my + 40).toFixed(1) + "'/>";
            svg += "</g>";
        }
    }
    svg += "</svg></div>";
    html += svg;

    if (events_pick_mode) {
        // no legend while picking; keep the map clean
        box.innerHTML = html;
        return;
    }

    if (inside.length === 0)
        html += "<div class='event_empty'>No events inside the Basel map yet.<br>Add one from Basel, or check the list view.</div>";

    // legend for the pinned (Basel) events
    html += "<div class='event_map_legend'>";
    for (i = 0; i < inside.length; i++) {
        var ev = inside[i].ev;
        var short = ev.descr.length > 48 ? ev.descr.substring(0, 48) + "…" : ev.descr;
        html += "<div class='event_map_legend_row' onclick=\"events_show_detail('" + ev.id + "')\">";
        html += "<span class='event_map_legend_dot' style='background-color:" + events_author_color(ev.from) + ";'>" + (i + 1) + "</span> ";
        html += escapeHTML(short) + "</div>";
    }
    // events outside the Basel frame stay reachable but unpinned
    for (i = 0; i < c.outside.length; i++) {
        var evo = c.outside[i].ev;
        var shorto = evo.descr.length > 44 ? evo.descr.substring(0, 44) + "…" : evo.descr;
        html += "<div class='event_map_legend_row event_map_legend_out' onclick=\"events_show_detail('" + evo.id + "')\">";
        html += "<span class='event_map_legend_dot' style='background-color:#9e9e9e;'>&middot;</span> ";
        html += escapeHTML(shorto) + " <em>(outside Basel)</em></div>";
    }
    html += "</div>";

    box.innerHTML = html;
}

// Detail overlay, shared by the list and map views.
function events_show_detail(eventId) {
    var ev = tremola.events[eventId];
    if (ev == null || ev.deleted || ev.pending_tombstone)
        return;
    closeOverlay();
    var who = (ev.from in tremola.contacts) ? tremola.contacts[ev.from].alias : id2b32(ev.from);
    var when = ev.when ? new Date(ev.when).toLocaleString() : "";
    var m = "<div class='event_descr' style='font-size: 1.15em;'>" + escapeHTML(ev.descr) + "</div>";
    if (ev.starts > 0)
        m += "<div class='event_starts'>&#x1F4C5; " + escapeHTML(events_fmt_starts(ev.starts)) +
            (ev.starts <= Date.now() ? " (past)" : "") + "</div>";
    m += "<div class='event_meta'>" + escapeHTML(who) + " &middot; added " + escapeHTML(when) + "</div>";

    // participants (per-author LWW rsvp state, merged on ingest)
    var going = events_going(ev);
    if (going.length > 0) {
        var names = [];
        for (var g = 0; g < going.length; g++)
            names.push(going[g] == myId ? "you" :
                (going[g] in tremola.contacts) ? tremola.contacts[going[g]].alias : id2b32(going[g]));
        names.sort();
        m += "<div class='event_rsvp_badge'>&#x1F465; " + going.length + " going: " +
            escapeHTML(names.join(", ")) + "</div>";
    }

    m += "<div class='event_actions' style='margin-top: 14px;'>";
    m += events_i_go(ev)
        ? "<button class='event_rsvp_btn event_rsvp_on' onclick='event_rsvp_toggle(\"" + ev.id + "\")'>&#x2713; Going &middot; tap to cancel</button>"
        : "<button class='event_rsvp_btn' onclick='event_rsvp_toggle(\"" + ev.id + "\")'>I'm going</button>";
    if (ev.pluscode && ev.pluscode != "")
        m += "<button class='event_loc_btn' onclick='showGeoMenu(\"" + ev.pluscode + "\")'>&#x1F4CD; " + escapeHTML(ev.pluscode) + "</button>";
    if (ev.from == myId)
        m += "<button class='event_del_btn' onclick='event_confirm_delete(\"" + ev.id + "\")'>Delete</button>";
    m += "</div>";
    document.getElementById('event-detail-overlay').innerHTML = m;
    document.getElementById('event-detail-overlay').style.display = 'initial';
    document.getElementById('overlay-bg').style.display = 'initial';
    overlayIsActive = true;
}

// Flip our RSVP and re-render the open detail overlay with the
// optimistically applied state (the echoed log entry confirms it).
function event_rsvp_toggle(eventId) {
    var ev = tremola.events[eventId];
    if (ev == null || ev.deleted || ev.pending_tombstone)
        return;
    event_rsvp(eventId, !events_i_go(ev));
    events_show_detail(eventId);
}

// --- eof
