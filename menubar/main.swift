import AppKit
import ServiceManagement

// MARK: - adb

let adbPath: String = {
    let candidates: [String?] = [
        Bundle.main.resourceURL?.appendingPathComponent("adb").path,
        Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("vendor/platform-tools/adb").path,
        "/opt/homebrew/bin/adb",
    ]
    for c in candidates {
        if let c, FileManager.default.isExecutableFile(atPath: c) { return c }
    }
    return "adb"
}()

struct CmdResult {
    let ok: Bool
    let output: String
}

@discardableResult
func adb(_ args: [String]) -> CmdResult {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: adbPath)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do {
        try p.run()
    } catch {
        return CmdResult(ok: false, output: error.localizedDescription)
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    let out = String(data: data, encoding: .utf8) ?? ""
    return CmdResult(ok: p.terminationStatus == 0, output: out)
}

struct Device {
    let serial: String
    let state: String  // device | unauthorized | offline | ...
    let model: String
    var isUSB: Bool { !serial.contains(":") }
}

func listDevices() -> [Device] {
    let res = adb(["devices", "-l"])
    var devices: [Device] = []
    for line in res.output.split(separator: "\n").dropFirst() {
        let parts = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard parts.count >= 2 else { continue }
        var model = ""
        for p in parts.dropFirst(2) where p.hasPrefix("model:") {
            model = String(p.dropFirst(6)).replacingOccurrences(of: "_", with: " ")
        }
        devices.append(Device(serial: parts[0], state: parts[1], model: model))
    }
    return devices.sorted { $0.isUSB && !$1.isUSB }
}

// MARK: - drop view (overlays the status item button)

final class DropView: NSView {
    var onDrop: (([URL]) -> Void)?
    var onClick: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) { fatalError() }

    private var button: NSStatusBarButton? { superview as? NSStatusBarButton }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        button?.highlight(true)
        return .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) { button?.highlight(false) }
    override func draggingEnded(_ sender: NSDraggingInfo) { button?.highlight(false) }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL] ?? []
        guard !urls.isEmpty else { return false }
        onDrop?(urls)
        return true
    }

    override func mouseDown(with event: NSEvent) { onClick?() }
}

// MARK: - app

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private let statusLine = NSMenuItem(title: "Checking for phone…", action: nil, keyEquivalent: "")
    private let progressLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let loginLine = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin), keyEquivalent: "")
    private let wirelessLine = NSMenuItem(title: "Go wireless", action: #selector(toggleWireless), keyEquivalent: "")
    private let stopLine = NSMenuItem(title: "Stop transfer", action: #selector(stopTransfer), keyEquivalent: "")
    private let remoteDir = "/sdcard"
    private let pushQueue = DispatchQueue(label: "droidrop.push")
    private var busy = false
    // Cancellation state is touched from the main thread and the push queue.
    private let stateLock = NSLock()
    private var cancelRequested = false
    private var currentPush: Process?

    private var isCancelled: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return cancelRequested
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: "smartphone",
                accessibilityDescription: "droidrop"
            )
            let drop = DropView(frame: button.bounds)
            drop.autoresizingMask = [.width, .height]
            drop.onDrop = { [weak self] urls in self?.handleDrop(urls) }
            drop.onClick = { [weak self] in self?.showMenu() }
            button.addSubview(drop)
        }

        menu.autoenablesItems = false
        statusLine.isEnabled = false
        progressLine.isHidden = true
        progressLine.isEnabled = false
        loginLine.target = self
        wirelessLine.target = self
        wirelessLine.isEnabled = false
        stopLine.target = self
        stopLine.isHidden = true
        stopLine.image = NSImage(systemSymbolName: "stop.circle.fill", accessibilityDescription: "Stop")
        let infoLine = NSMenuItem(title: "Drop files on the icon to send to the phone", action: nil, keyEquivalent: "")
        infoLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(progressLine)
        menu.addItem(stopLine)
        menu.addItem(infoLine)
        menu.addItem(.separator())
        menu.addItem(wirelessLine)
        menu.addItem(loginLine)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit droidrop", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.delegate = self

        // First launch: register as a login item (the menu toggle can undo this).
        if SMAppService.mainApp.status == .notRegistered,
           !UserDefaults.standard.bool(forKey: "triedAutoLogin") {
            UserDefaults.standard.set(true, forKey: "triedAutoLogin")
            try? SMAppService.mainApp.register()
        }

        // Warm up the adb server so the first drop isn't slow.
        pushQueue.async { adb(["start-server"]) }
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            alert("Could not change login item", error.localizedDescription)
        }
    }

    private func showMenu() {
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
    }

    func menuDidClose(_ menu: NSMenu) {
        statusItem.menu = nil  // keep clicks routed through DropView
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        loginLine.state = SMAppService.mainApp.status == .enabled ? .on : .off
        statusLine.title = "Checking for phone…"
        statusLine.image = Self.dot(.tertiaryLabelColor)
        pushQueue.async { [weak self] in
            let devices = listDevices()
            let (label, color) = Self.status(for: devices)
            let wifiActive = devices.contains { !$0.isUSB && $0.state == "device" }
            let usbReady = devices.contains { $0.isUSB && $0.state == "device" }
            DispatchQueue.main.async {
                guard let self else { return }
                self.statusLine.title = label
                self.statusLine.image = Self.dot(color)
                if wifiActive {
                    self.wirelessLine.title = "Disconnect wireless"
                    self.wirelessLine.isEnabled = true
                    if #available(macOS 14.0, *) { self.wirelessLine.subtitle = nil }
                } else {
                    self.wirelessLine.title = usbReady ? "Go wireless — then unplug" : "Go wireless (plug in USB first)"
                    self.wirelessLine.isEnabled = usbReady
                    if #available(macOS 14.0, *) {
                        self.wirelessLine.subtitle = "Unencrypted — use on trusted networks only"
                    }
                }
            }
        }
    }

    @objc private func toggleWireless() {
        pushQueue.async { [weak self] in
            guard let self else { return }
            let devices = listDevices()

            if let wifi = devices.first(where: { !$0.isUSB }) {
                adb(["disconnect", wifi.serial])
                self.setTitle("✓", clearAfter: 2)
                return
            }

            guard let usb = devices.first(where: { $0.isUSB && $0.state == "device" }) else { return }
            let route = adb(["-s", usb.serial, "shell", "ip route get 1 2>/dev/null || ip route"])
            guard let r = route.output.range(of: #"src (\d+\.\d+\.\d+\.\d+)"#, options: .regularExpression) else {
                self.alert("Could not find the phone’s wifi IP",
                           "Make sure the phone’s wifi is on and it’s on the same network as this Mac.")
                return
            }
            let ip = String(route.output[r].dropFirst(4))

            let tcp = adb(["-s", usb.serial, "tcpip", "5555"])
            guard tcp.ok else {
                self.alert("Could not switch the phone to wireless mode",
                           tcp.output.trimmingCharacters(in: .whitespacesAndNewlines))
                return
            }

            // adbd restarts in TCP mode; give it a moment, retry once if it's slow.
            usleep(1_500_000)
            var conn = adb(["connect", "\(ip):5555"])
            if !conn.output.contains("connected") {
                usleep(1_500_000)
                conn = adb(["connect", "\(ip):5555"])
            }

            let out = conn.output.lowercased()
            if out.contains("connected"), !out.contains("cannot"), !out.contains("failed") {
                self.setTitle("✓", clearAfter: 3)
            } else {
                self.alert("Wireless connect failed",
                           conn.output.trimmingCharacters(in: .whitespacesAndNewlines)
                           + "\n\nIf the phone is showing an “Allow USB debugging” prompt, tap Allow and click Go wireless again.")
            }
        }
    }

    private static func status(for devices: [Device]) -> (String, NSColor) {
        guard let d = devices.first else {
            return ("No phone connected — plug in USB", .tertiaryLabelColor)
        }
        switch d.state {
        case "device": return ("\(d.model.isEmpty ? d.serial : d.model) connected", .systemGreen)
        case "unauthorized", "authorizing": return ("Phone found — tap “Allow” on it", .systemYellow)
        default: return ("Phone is \(d.state)", .systemRed)
        }
    }

    private static func dot(_ color: NSColor) -> NSImage {
        NSImage(size: NSSize(width: 9, height: 9), flipped: false) { rect in
            color.withAlphaComponent(0.9).setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5)).fill()
            return true
        }
    }

    // MARK: transfers

    private func handleDrop(_ urls: [URL]) {
        guard !busy else {
            NSSound.beep()
            return
        }
        busy = true
        stateLock.lock()
        cancelRequested = false
        stateLock.unlock()
        stopLine.isHidden = false
        pushQueue.async { [weak self] in
            self?.pushAll(urls)
            DispatchQueue.main.async {
                self?.busy = false
                self?.stopLine.isHidden = true
            }
        }
    }

    @objc private func stopTransfer() {
        stateLock.lock()
        cancelRequested = true
        let running = currentPush
        stateLock.unlock()
        running?.terminate()
    }

    private func pushAll(_ urls: [URL]) {
        let devices = listDevices()
        guard let device = devices.first(where: { $0.state == "device" }) else {
            if devices.contains(where: { $0.state == "unauthorized" || $0.state == "authorizing" }) {
                alert("Phone is locked to this Mac yet",
                      "Look at the phone and tap “Allow USB debugging” (check “Always allow”), then drop again.")
            } else {
                alert("No phone connected",
                      "Plug in the USB cable and make sure USB debugging is on.")
            }
            setTitle("!", clearAfter: 3)
            return
        }

        setTitle("↑")
        var failures: [String] = []
        for (i, url) in urls.enumerated() {
            if isCancelled { break }
            let prefix = urls.count > 1 ? "Sending \(i + 1) of \(urls.count): " : "Sending: "
            let name = url.lastPathComponent
            setProgress(prefix + name)
            let res = pushWithProgress(serial: device.serial, localPath: url.path) { [weak self] pct in
                self?.setProgress("\(prefix)\(name) — \(pct)%")
            }
            if !res.ok, !isCancelled {
                let lastLine = res.output
                    .split(whereSeparator: { $0 == "\n" || $0 == "\r" })
                    .last.map(String.init) ?? "failed"
                failures.append("\(name): \(lastLine)")
            }
        }
        setProgress(nil)

        if isCancelled {
            setTitle("✕", clearAfter: 2)  // note: the interrupted file is left partial on the phone
        } else if failures.isEmpty {
            setTitle("✓", clearAfter: 3)
        } else {
            setTitle("!", clearAfter: 3)
            alert("Some transfers failed", failures.joined(separator: "\n"))
        }
    }

    /// adb only reports percentages when talking to a terminal, so run it on a pty.
    private func pushWithProgress(serial: String, localPath: String,
                                  onProgress: @escaping (Int) -> Void) -> CmdResult {
        var master: Int32 = -1
        var slave: Int32 = -1
        guard openpty(&master, &slave, nil, nil, nil) == 0 else {
            return adb(["-s", serial, "push", localPath, remoteDir + "/"])
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: adbPath)
        p.arguments = ["-s", serial, "push", localPath, remoteDir + "/"]
        if serial.contains(":") {
            // Wireless: burst mode skips per-chunk round trips (~5x faster in testing).
            var env = ProcessInfo.processInfo.environment
            env["ADB_BURST_MODE"] = "1"
            p.environment = env
        }
        let slaveHandle = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        p.standardOutput = slaveHandle
        p.standardError = slaveHandle
        p.standardInput = FileHandle.nullDevice

        let lock = NSLock()
        var output = ""
        let masterHandle = FileHandle(fileDescriptor: master, closeOnDealloc: false)
        masterHandle.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            guard let chunk = String(data: data, encoding: .utf8) else { return }
            lock.lock(); output += chunk; lock.unlock()
            if let r = chunk.range(of: #"\[\s*\d+%\]"#, options: [.regularExpression, .backwards]),
               let pct = Int(chunk[r].filter(\.isNumber)) {
                onProgress(pct)
            }
        }

        do {
            try p.run()
        } catch {
            masterHandle.readabilityHandler = nil
            close(master)
            close(slave)
            return CmdResult(ok: false, output: error.localizedDescription)
        }
        close(slave)  // parent's copy; child keeps its own until exit
        stateLock.lock()
        currentPush = p
        stateLock.unlock()
        p.waitUntilExit()
        stateLock.lock()
        currentPush = nil
        stateLock.unlock()
        usleep(150_000)  // let the reader drain the final chunk
        masterHandle.readabilityHandler = nil
        close(master)

        lock.lock(); defer { lock.unlock() }
        return CmdResult(ok: p.terminationStatus == 0, output: output)
    }

    /// Shows/hides the transfer line in the status menu. nil hides it.
    private func setProgress(_ text: String?) {
        DispatchQueue.main.async {
            self.progressLine.isHidden = (text == nil)
            self.progressLine.title = text ?? ""
        }
    }

    /// Shows short text next to the icon (progress, ✓, !). Empty restores icon-only.
    private func setTitle(_ text: String, clearAfter seconds: Double? = nil) {
        DispatchQueue.main.async {
            self.statusItem.length = text.isEmpty ? NSStatusItem.squareLength : NSStatusItem.variableLength
            self.statusItem.button?.title = text.isEmpty ? "" : " " + text
            self.statusItem.button?.imagePosition = .imageLeft
            if let seconds {
                DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { self.setTitle("") }
            }
        }
    }

    private func alert(_ title: String, _ text: String) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            let a = NSAlert()
            a.messageText = title
            a.informativeText = text
            a.runModal()
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
