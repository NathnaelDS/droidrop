#!/bin/sh
# Builds DroidDrop.app (self-contained: adb is copied into the bundle).
set -e
cd "$(dirname "$0")"

if [ ! -x ../vendor/platform-tools/adb ]; then
    echo "Fetching Android platform-tools…"
    mkdir -p ../vendor
    curl -sL -o /tmp/platform-tools.zip \
        https://dl.google.com/android/repository/platform-tools-latest-darwin.zip
    unzip -q /tmp/platform-tools.zip -d ../vendor/
fi

APP="../DroidDrop.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -o "$APP/Contents/MacOS/DroidDrop" main.swift
cp Info.plist "$APP/Contents/"
cp ../vendor/platform-tools/adb "$APP/Contents/Resources/adb"
codesign --force -s - "$APP"

echo "Built $APP — open it, or drag it to /Applications"
