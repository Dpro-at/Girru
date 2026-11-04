#!/bin/sh
# The Android pairing code against a real computer and relay. Called by
# pair-harness.mjs with the QR text as its last argument; runs PairCheckTest on
# the JVM, which writes its id=, code= and paired lines to GIRRU_PAIR_OUT.
#
# From packages/backend (build the test classes once first, see README):
#   node --import tsx ../mobile/tools/pair-harness.mjs ../mobile/tools/android-pair-check.sh
set -e
for qr; do :; done
cd "$(dirname "$0")/../android"
GIRRU_PAIR_QR="$qr" exec ./gradlew -q --offline :app:testDebugUnitTest --tests dev.girru.app.link.PairCheckTest --rerun
