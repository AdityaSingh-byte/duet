#!/bin/sh
# Builds assets/duet-unstick.dex from android/unstick/Unstick.java.
# Needs a JDK (JAVA_HOME or javac on PATH) and the Android SDK (ANDROID_HOME) with a platform and build-tools.
set -eu
cd "$(dirname "$0")/.."
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$SDK" ] || { echo "Set ANDROID_HOME to your Android SDK." >&2; exit 1; }
PLATFORM=$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)
D8=$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)/d8
JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
OUT=$(mktemp -d)
"$JAVAC" --release 11 -cp "$PLATFORM/android.jar" -d "$OUT" android/unstick/Unstick.java
"$D8" --min-api 26 --lib "$PLATFORM/android.jar" --output "$OUT" "$OUT/Unstick.class"
cp "$OUT/classes.dex" assets/duet-unstick.dex
rm -rf "$OUT"
echo "wrote assets/duet-unstick.dex"
