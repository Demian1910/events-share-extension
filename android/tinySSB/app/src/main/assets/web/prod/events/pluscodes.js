// prod/events/pluscodes.js
//
// Minimal Open Location Code ("plus code") decoder, ported from
// utils/PlusCodesUtils.kt (same constants and algorithm). The map view uses
// it to position event pins without a synchronous round-trip through the
// Android bridge for every event; it also works in browser-only test mode
// where the Android object is absent.

"use strict";

var OLC_ALPHABET = "23456789CFGHJMPQRVWX";
var OLC_BASE = OLC_ALPHABET.length;              // 20
var OLC_LAT_MULT = 8000 * 3125;                  // 25 000 000
var OLC_LNG_MULT = 8000 * 1024;                  //  8 192 000
var OLC_LAT_MSP = OLC_LAT_MULT * OLC_BASE * OLC_BASE;
var OLC_LNG_MSP = OLC_LNG_MULT * OLC_BASE * OLC_BASE;

// Decode a plus code to the south-west corner of its cell, mirroring
// PlusCodesUtils.decode. Returns {lat, lng} or null for empty/malformed input.
function olc_decode(code) {
    if (code == null || code == "")
        return null;
    var clean = "";
    for (var i = 0; i < code.length; i++) {
        var ch = code[i].toUpperCase();
        if (ch == '+')
            continue;
        if (OLC_ALPHABET.indexOf(ch) < 0)
            return null;
        clean += ch;
    }
    if (clean.length < 2 || clean.length % 2 != 0)
        return null;

    var latVal = -90 * OLC_LAT_MULT;
    var lngVal = -180 * OLC_LNG_MULT;
    var latPlace = OLC_LAT_MSP;
    var lngPlace = OLC_LNG_MSP;
    for (var j = 0; j < clean.length; j += 2) {
        latPlace /= OLC_BASE;
        lngPlace /= OLC_BASE;
        latVal += OLC_ALPHABET.indexOf(clean[j]) * latPlace;
        lngVal += OLC_ALPHABET.indexOf(clean[j + 1]) * lngPlace;
    }
    return {
        "lat": latVal / OLC_LAT_MULT,
        "lng": lngVal / OLC_LNG_MULT
    };
}

// --- eof
