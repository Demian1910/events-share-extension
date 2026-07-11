#!/bin/sh
# Run the Share Events logic tests against the production JS, unmodified.
# Uses macOS's bundled JavaScriptCore so no Node.js install is needed.
HERE="$(cd "$(dirname "$0")" && pwd)"
EVDIR="$HERE/../app/src/main/assets/web/prod/events"

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
[ -x "$JSC" ] || JSC=jsc

cd "$EVDIR" || exit 1
exec "$JSC" pluscodes.js events.js events_ui.js "$HERE/events_test.js"
