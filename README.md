# droidrop

> Drag a file onto your menu bar. It's on your phone.

Mac → Android file transfer that just works. No app on the phone, no cloud, no
pairing dance — a tiny native menu bar app and a USB cable.

**Why:** Android File Transfer is abandonware, MTP is cursed, and wifi-transfer
websites make you type IP addresses like it's 1999. Meanwhile `adb push` has
quietly been the fastest, most reliable way to move files to Android for a
decade. droidrop is just that, wearing a menu bar icon.

## Install

```sh
brew install nathnaelds/tap/droidrop
```

then follow the printed instructions (one `cp` to /Applications).

Or build from source:

```sh
git clone https://github.com/NathnaelDS/droidrop && cd droidrop
./menubar/build.sh        # fetches adb, builds DroidDrop.app — fully self-contained
mv DroidDrop.app /Applications && open /Applications/DroidDrop.app
```

Either way the build happens on your machine, so there's no Gatekeeper
"unidentified developer" drama.

Phone side, once: enable **Developer options** (tap Build number 7×), turn on
**USB debugging**, plug in, tap **Allow**.

## Use

- **Drag files or folders** from Finder onto the 📱 icon → they land at the top
  of the phone's storage. Folders arrive intact. That's the whole app.
- While sending, click the icon for live progress — *"Sending 2 of 3:
  movie.mkv — 42%"* — then `✓` (or `!` with the reason).
- The menu shows connection status (🟢 connected / 🟡 tap Allow / ⚪ no phone)
  and a Start-at-Login toggle (on by default).

## How it works

- One Swift file. Native AppKit, ~no RAM, no Electron.
- `adb` is bundled inside the .app, so nothing else to install.
- Transfers run `adb push` on a pseudo-terminal — that's the trick that makes
  adb report live percentages.
- ~33 MB/s over USB. A movie in under a minute.

## License

MIT
