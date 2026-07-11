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

// Encode a position as a 10-digit plus code (e.g. "8FV9HH6Q+6C", ~14m cell),
// the exact integer-arithmetic inverse of olc_decode above: encoding any
// point inside a cell returns that cell's code, so encode/decode round-trip.
// Used by the map view's location picker.
function olc_encode(lat, lng) {
    lat = Math.min(90, Math.max(-90, lat));
    while (lng < -180) lng += 360;
    while (lng >= 180) lng -= 360;
    // +1e-3 integer units (= 4e-11 degrees, spatially irrelevant) guards
    // against floating-point error flipping a position that lies exactly on
    // a cell boundary (e.g. re-encoding a decoded SW corner) into the
    // neighbouring cell
    var latVal = Math.floor((lat + 90) * OLC_LAT_MULT + 1e-3);
    var lngVal = Math.floor((lng + 180) * OLC_LNG_MULT + 1e-3);
    if (latVal >= 180 * OLC_LAT_MULT)     // lat == 90: stay in the last cell
        latVal = 180 * OLC_LAT_MULT - 1;

    var code = "";
    var latPlace = OLC_LAT_MSP;
    var lngPlace = OLC_LNG_MSP;
    for (var i = 0; i < 5; i++) {         // 5 digit pairs = 10 digits
        latPlace /= OLC_BASE;
        lngPlace /= OLC_BASE;
        code += OLC_ALPHABET[Math.floor(latVal / latPlace) % OLC_BASE];
        code += OLC_ALPHABET[Math.floor(lngVal / lngPlace) % OLC_BASE];
        if (i == 3)
            code += "+";
    }
    return code;
}

// --- eof
