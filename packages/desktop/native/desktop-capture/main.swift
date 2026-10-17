import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision

// Recovery runs after the command process exits, so an interrupted input cannot remain held.
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--release-key",
  let key = UInt16(CommandLine.arguments[2]), key <= 127
{
  let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)
  up?.flags = []
  up?.post(tap: .cghidEventTap)
  exit(0)
}
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--release-button" {
  let right = CommandLine.arguments[2] == "right"
  let point = CGEvent(source: nil)?.location ?? .zero
  CGEvent(
    mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp,
    mouseCursorPosition: point, mouseButton: right ? .right : .left)?.post(tap: .cghidEventTap)
  exit(0)
}

// Only newline-delimited JSON is written to stdout. Stderr belongs to diagnostics.
let outputLock = NSLock()

func emit(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
  outputLock.lock()
  defer { outputLock.unlock() }
  FileHandle.standardOutput.write(data + Data([10]))
}

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
  var value: CFTypeRef?
  AXUIElementCopyAttributeValue(element, key as CFString, &value)
  return value
}

func context() -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication else { return [:] }
  let element = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(element, 0.08)
  var result: [String: Any] = [
    "application": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "",
  ]
  if let window = attribute(element, kAXFocusedWindowAttribute),
    CFGetTypeID(window) == AXUIElementGetTypeID()
  {
    let focused = unsafeBitCast(window, to: AXUIElement.self)
    result["windowTitle"] = attribute(focused, kAXTitleAttribute) as? String ?? ""
    result["document"] = attribute(focused, kAXDocumentAttribute) as? String ?? ""
  }
  return result
}

@available(macOS 14.0, *)
@MainActor
func capture(id: String, gesture: CapturedGesture? = nil) async {
  let start = ProcessInfo.processInfo.systemUptime
  let foreground = gesture?.foreground ?? context()
  let contextEnd = ProcessInfo.processInfo.systemUptime
  // CG coordinates and ScreenCaptureKit display IDs share the global top-left coordinate space.
  let point = CGEvent(source: nil)?.location ?? .zero
  let displays = NSScreen.screens
  let selected =
    displays.first { screen in
      let number =
        screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32 ?? 0
      return CGDisplayBounds(number).contains(point)
    } ?? NSScreen.main
  let displayID =
    selected?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32
    ?? CGMainDisplayID()
  do {
    guard CGPreflightScreenCaptureAccess() else {
      throw NSError(domain: "capture_permission", code: 1)
    }
    let content = try await SCShareableContent.excludingDesktopWindows(
      false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
      throw NSError(domain: "display_missing", code: 1)
    }
    let shareableEnd = ProcessInfo.processInfo.systemUptime
    let configuration = SCStreamConfiguration()
    configuration.width = CGDisplayPixelsWide(displayID)
    configuration.height = CGDisplayPixelsHigh(displayID)
    configuration.showsCursor = false
    let ownWindows = content.windows.filter { $0.owningApplication?.processID == getpid() }
    let filter = SCContentFilter(display: display, excludingWindows: ownWindows)
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter, configuration: configuration)
    let frameEnd = ProcessInfo.processInfo.systemUptime
    let bounds = CGDisplayBounds(displayID)
    let (annotated, crop) =
      gesture.map { annotateGesture(image, bounds: bounds, points: $0.points) } ?? (image, nil)
    let png = NSBitmapImageRep(cgImage: annotated).representation(using: .png, properties: [:])!
    var payload: [String: Any] = [
      "event": "capture", "id": id, "png": png.base64EncodedString(), "context": foreground,
      "display": [
        "id": displayID, "x": bounds.minX, "y": bounds.minY, "width": bounds.width,
        "height": bounds.height,
      ],
      "width": image.width, "height": image.height,
      "captureMs": (ProcessInfo.processInfo.systemUptime - start) * 1000,
      "timings": [
        "contextMs": (contextEnd - start) * 1000, "shareableMs": (shareableEnd - contextEnd) * 1000,
        "frameMs": (frameEnd - shareableEnd) * 1000,
        "encodeMs": (ProcessInfo.processInfo.systemUptime - frameEnd) * 1000,
      ],
    ]
    if gesture != nil { payload["gesture"] = true }
    if let crop,
      let data = NSBitmapImageRep(cgImage: crop).representation(using: .png, properties: [:])
    {
      payload["cropPng"] = data.base64EncodedString()
    }
    emit(payload)
    // OCR is delivered separately so it never holds up the request window.
    DispatchQueue.global(qos: .userInitiated).async {
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .fast
      request.usesLanguageCorrection = false
      do {
        try VNImageRequestHandler(cgImage: image).perform([request])
        let text =
          request.results?.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
          ?? ""
        emit(["event": "ocr", "id": id, "text": String(text.prefix(32000))])
      } catch { emit(["event": "ocr", "id": id, "text": ""]) }
    }
  } catch {
    emit(["event": "error", "id": id, "error": (error as NSError).domain])
  }
}

var revokedSessions = Set<String>()
var controllingSession: String?
var stopPanel: NSPanel?
class StopControl: NSObject {
  @objc func stop() {
    guard let session = controllingSession else { return }
    revokedSessions.insert(session)
    controllingSession = nil
    stopPanel?.orderOut(nil)
    emit(["event": "stopped", "sessionId": session])
  }
}
let stopControl = StopControl()
func showStop(session: String) {
  controllingSession = session
  if stopPanel == nil {
    let panel = NSPanel(
      contentRect: NSRect(x: 24, y: 48, width: 140, height: 44), styleMask: [.nonactivatingPanel],
      backing: .buffered, defer: false)
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false
    let button = NSButton(
      title: "Arrêter", target: stopControl, action: #selector(StopControl.stop))
    button.frame = NSRect(x: 8, y: 6, width: 124, height: 32)
    button.bezelStyle = .rounded
    panel.contentView?.addSubview(button)
    stopPanel = panel
  }
  stopPanel?.orderFrontRegardless()
}

func accessibleElements() -> [[String: Any]] {
  guard let app = NSWorkspace.shared.frontmostApplication else { return [] }
  var queue = [AXUIElementCreateApplication(app.processIdentifier)]
  var result = [[String: Any]]()
  let deadline = ProcessInfo.processInfo.systemUptime + 0.3
  while !queue.isEmpty && result.count < 300 && ProcessInfo.processInfo.systemUptime < deadline {
    let element = queue.removeFirst()
    AXUIElementSetMessagingTimeout(element, 0.01)
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    var row: [String: Any] = [
      "role": role, "title": attribute(element, kAXTitleAttribute) as? String ?? "",
    ]
    if role != "AXSecureTextField" {
      row["value"] =
        (attribute(element, kAXValueAttribute) as? String).map { String($0.prefix(4000)) } ?? ""
    }
    result.append(row)
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
      queue.append(contentsOf: children.prefix(max(0, 300 - queue.count - result.count)))
    }
  }
  return result
}

func control(_ command: [String: Any]) {
  guard let id = command["id"] as? String, let session = command["sessionId"] as? String,
    let action = command["action"] as? [String: Any], let name = action["command"] as? String
  else { return }
  if revokedSessions.contains(session) {
    emit(["event": "error", "id": id, "error": "session_revoked"])
    return
  }
  showStop(session: session)
  if name == "screenshot" {
    if #available(macOS 14.0, *) { Task { await capture(id: id) } }
    return
  }
  guard AXIsProcessTrusted() else {
    emit(["event": "error", "id": id, "error": "accessibility_permission"])
    return
  }
  if name == "accessibility" {
    emit([
      "event": "result", "id": id,
      "result": ["context": context(), "elements": accessibleElements()],
    ])
    return
  }
  let source = CGEventSource(stateID: .hidSystemState)
  if name == "click" || name == "scroll" {
    guard let x = action["x"] as? Double, let y = action["y"] as? Double,
      NSScreen.screens.contains(where: { screen in
        let number =
          screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32 ?? 0
        return CGDisplayBounds(number).contains(CGPoint(x: x, y: y))
      })
    else {
      emit(["event": "error", "id": id, "error": "invalid_coordinates"])
      return
    }
    let point = CGPoint(x: x, y: y)
    if name == "click" {
      let right = action["button"] as? String == "right"
      let button: CGMouseButton = right ? .right : .left
      CGEvent(
        mouseEventSource: source, mouseType: right ? .rightMouseDown : .leftMouseDown,
        mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
      CGEvent(
        mouseEventSource: source, mouseType: right ? .rightMouseUp : .leftMouseUp,
        mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
    } else {
      CGEvent(
        mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point,
        mouseButton: .left)?.post(tap: .cghidEventTap)
      CGEvent(
        scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
        wheel1: Int32(action["deltaY"] as? Int ?? 0), wheel2: Int32(action["deltaX"] as? Int ?? 0),
        wheel3: 0)?.post(tap: .cghidEventTap)
    }
  } else if name == "type_text", let text = action["text"] as? String {
    let chars = Array(text.utf16)
    let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
    let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
    down?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
    up?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
  } else if name == "shortcut", let key = action["keyCode"] as? UInt16 {
    let names = action["modifiers"] as? [String] ?? []
    var flags: CGEventFlags = []
    for name in names {
      switch name {
      case "command": flags.insert(.maskCommand)
      case "option": flags.insert(.maskAlternate)
      case "control": flags.insert(.maskControl)
      case "shift": flags.insert(.maskShift)
      default: break
      }
    }
    let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true)
    let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
    down?.flags = flags
    up?.flags = []
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
  } else {
    emit(["event": "error", "id": id, "error": "invalid_command"])
    return
  }
  emit(["event": "result", "id": id, "result": ["completed": true]])
}

let modifiers: CGEventFlags = [
  .maskAlternate, .maskControl, .maskCommand, .maskShift, .maskSecondaryFn,
]
var shortcut = ModifierShortcut(required: CGEventFlags([.maskAlternate, .maskControl]).rawValue)
var tap: CFMachPort?
let gestureOverlay = MainActor.assumeIsolated { GestureOverlay() }
var activeGestureId: String?

func gestureEvent(_ event: ModifierShortcutEvent?) {
  MainActor.assumeIsolated {
    guard let event else { return }
    switch event {
    case .began:
      let id = UUID().uuidString
      activeGestureId = id
      emit(["event": "gesture", "id": id, "phase": "began"])
      gestureOverlay.begin(id: id, foreground: context())
    case .ended:
      guard let id = activeGestureId else { return }
      activeGestureId = nil
      let gesture = gestureOverlay.finish()
      emit(["event": "gesture", "id": id, "phase": "ended"])
      if #available(macOS 14.0, *) { Task { await capture(id: id, gesture: gesture) } }
    case .cancelled:
      gestureOverlay.cancel()
      if let id = activeGestureId { emit(["event": "gesture", "id": id, "phase": "cancelled"]) }
      activeGestureId = nil
    }
  }
}

func installTap() {
  guard tap == nil else { return }
  let mask =
    (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
    | (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.rightMouseDown.rawValue)
  tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
    eventsOfInterest: CGEventMask(mask),
    callback: { _, type, event, _ in
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        gestureEvent(shortcut.cancel())
        if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      } else if type == .flagsChanged {
        gestureEvent(shortcut.update(modifiers: event.flags.intersection(modifiers).rawValue))
      } else {
        gestureEvent(shortcut.cancel())
      }
      return Unmanaged.passUnretained(event)
    }, userInfo: nil)
  if let tap {
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
  }
  emit([
    "event": "ready", "keyboard": tap != nil, "capture": CGPreflightScreenCaptureAccess(),
    "accessibility": AXIsProcessTrusted(),
  ])
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
if #available(macOS 14.0, *) {
  // Permissions are requested only after an explicit command from the app.
  installTap()
  DispatchQueue.global().async {
    while let line = readLine() {
      guard let data = line.data(using: .utf8),
        let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { continue }
      DispatchQueue.main.async {
        switch command["command"] as? String {
        case "cancel_gesture": gestureEvent(shortcut.cancel())
        case "control": control(command)
        case "revoke":
          if let session = command["sessionId"] as? String {
            revokedSessions.insert(session)
            if controllingSession == session {
              controllingSession = nil
              stopPanel?.orderOut(nil)
            }
          }
        case "permissions":
          let options =
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
          _ = AXIsProcessTrustedWithOptions(options)
          _ = CGRequestScreenCaptureAccess()
          installTap()
        case "capture":
          if let id = command["id"] as? String { Task { await capture(id: id) } }
        case "shortcut":
          if let raw = command["modifiers"] as? UInt64, raw != 0, raw & ~modifiers.rawValue == 0 {
            shortcut = ModifierShortcut(required: raw)
          }
        default: break
        }
      }
    }
    DispatchQueue.main.async { application.terminate(nil) }
  }
  application.run()
} else {
  emit(["event": "unavailable", "error": "macos_14_required"])
}
