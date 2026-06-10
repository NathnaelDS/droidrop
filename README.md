# droidrop

Dead-simple Mac → Android file transfer: drag files or folders onto a menu bar
icon, they land at the top of the phone's storage (`/sdcard`) over the USB
cable. Uses ADB — **no app needed on the phone**.

## Build & run

```sh
./menubar/build.sh     # builds DroidDrop.app in the project root
open DroidDrop.app     # or drag it to /Applications first
```

The app is self-contained (`adb` is bundled inside it). On first launch it
registers itself to start at login — toggle "Start at Login" in its menu to
change that.

## One-time phone setup

1. Settings → About phone → tap **Build number** 7 times (enables Developer options).
2. Settings → Developer options → enable **USB debugging**.
3. Plug in the cable; tap **Allow** on the phone (check "Always allow").

## Use

- Drag any files/folders from Finder onto the menu bar icon → they're pushed to
  `/sdcard` (folders arrive intact, recursively).
- While sending, the icon shows `↑` and clicking it shows live progress
  ("Sending 2 of 3: movie.mkv — 42%"); `✓` on completion, `!` plus an alert if
  something failed.
- Click the icon for connection status, the login toggle, and Quit.

## Also in this repo (optional)

`npm start` runs a localhost web UI (port 7878) for two-way transfers: browse
the phone's storage, download files/folders to the Mac, drag-drop uploads, and
wifi connection via wireless ADB. Not needed for the menu bar workflow.

## Layout

- `menubar/` — the Swift menu bar app (one file) + build script
- `src/`, `public/` — the optional Node web UI (zero npm dependencies)
- `vendor/platform-tools/` — bundled adb
