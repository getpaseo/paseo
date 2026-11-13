import ExpoModulesCore
import UIKit
import GameController

private let hardwareSubmitEventName = "onHardwareKeyboardSubmit"
private let hardwareShortcutEventName = "onHardwareKeyboardShortcut"

private weak var activeModule: PaseoHardwareKeyboardModule?
private var isHardwareSubmitEnabled = false
private var overlayKeys: Set<String> = []
private var claimedShortcuts: [ClaimedShortcut] = []

/// UIKit spells non-character keys as sentinel input strings rather than as the
/// character they would type. JS sends the DOM `code` and the mapping lives
/// here, so the constants stay in the one place that owns UIKit vocabulary.
private let namedKeyInputs: [String: String] = [
  "Escape": UIKeyCommand.inputEscape,
  "ArrowUp": UIKeyCommand.inputUpArrow,
  "ArrowDown": UIKeyCommand.inputDownArrow,
  "Enter": "\r",
]

/// A shortcut the window takes from the focused text control: Shift+Tab would
/// otherwise insert a tab, and Option+Shift+[ would type a quote.
private struct ClaimedShortcut {
  let input: String
  let modifierFlags: UIKeyModifierFlags
}

struct ClaimedShortcutRecord: Record {
  @Field var code: String = ""
  @Field var shift: Bool = false
  @Field var alt: Bool = false
}

private let claimableKeyInputs: [String: String] = [
  "Tab": "\t", "Space": " ", "Enter": "\r", "Escape": UIKeyCommand.inputEscape,
  "ArrowUp": UIKeyCommand.inputUpArrow, "ArrowDown": UIKeyCommand.inputDownArrow,
  "ArrowLeft": UIKeyCommand.inputLeftArrow, "ArrowRight": UIKeyCommand.inputRightArrow,
  "Minus": "-", "Equal": "=", "BracketLeft": "[", "BracketRight": "]", "Backslash": "\\",
  "Semicolon": ";", "Quote": "'", "Backquote": "`", "Comma": ",", "Period": ".", "Slash": "/",
]

/// UIKit matches a key command against the unmodified character, so
/// Option+Shift+[ is registered as "[" with both modifier flags.
private func claimedShortcut(_ record: ClaimedShortcutRecord) -> ClaimedShortcut? {
  let code = record.code
  let input: String?
  if code.count == 4 && code.hasPrefix("Key") { input = code.suffix(1).lowercased() }
  else if code.count == 6 && code.hasPrefix("Digit") { input = String(code.suffix(1)) }
  else { input = claimableKeyInputs[code] }
  guard let input else { return nil }
  var modifierFlags: UIKeyModifierFlags = []
  if record.shift { modifierFlags.insert(.shift) }
  if record.alt { modifierFlags.insert(.alternate) }
  return ClaimedShortcut(input: input, modifierFlags: modifierFlags)
}

/// Whether the first responder is mid-IME-composition.
///
/// A committing key has to stay out of the way while a CJK candidate is being
/// chosen: Enter confirms the candidate, and consuming it as a key command
/// would submit the half-composed text instead.
private func isComposingText() -> Bool {
  guard let responder = UIResponder.paseoCurrentFirstResponder as? UITextInput else {
    return false
  }
  return responder.markedTextRange != nil
}

public class PaseoHardwareKeyboardModule: Module {
  private var keyboardObservers: [NSObjectProtocol] = []
  public func definition() -> ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events(hardwareSubmitEventName, hardwareShortcutEventName, "onHardwareKeyboardPresenceChanged")

    OnCreate {
      activeModule = self
      for name in [Notification.Name.GCKeyboardDidConnect, Notification.Name.GCKeyboardDidDisconnect] {
        self.keyboardObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          self?.sendEvent("onHardwareKeyboardPresenceChanged", [:])
        })
      }
    }

    Function("getHardwareKeyboardPresent") { GCKeyboard.coalesced != nil }

    Function("setHardwareKeyboardSubmitEnabled") { (enabled: Bool) in
      DispatchQueue.main.async {
        isHardwareSubmitEnabled = enabled
      }
    }

    Function("setOverlayKeys") { (keys: [String]) in
      DispatchQueue.main.async {
        overlayKeys = Set(keys).intersection(["Enter", "ArrowUp", "ArrowDown"])
        UIMenuSystem.main.setNeedsRebuild()
      }
    }

    Function("setClaimedShortcuts") { (shortcuts: [ClaimedShortcutRecord]) in
      let claimed = shortcuts.compactMap(claimedShortcut)
      DispatchQueue.main.async {
        claimedShortcuts = claimed
        UIMenuSystem.main.setNeedsRebuild()
      }
    }

    OnDestroy {
      self.keyboardObservers.forEach(NotificationCenter.default.removeObserver)
      self.keyboardObservers = []
      if activeModule === self {
        activeModule = nil
        isHardwareSubmitEnabled = false
        overlayKeys = []
        claimedShortcuts = []
      }
    }
  }

  fileprivate func emitHardwareKeyboardSubmit() {
    sendEvent(hardwareSubmitEventName, [:])
  }

  fileprivate func emitHardwareKeyboardPress(_ press: UIPress, isRepeat: Bool) {
    guard let key = press.key else { return }
    let code = hardwareKeyCode(key)
    let characters = key.characters
    let named = namedKeyInputs.first { $0.value == characters }?.key
    let keyName: String
    if code.hasPrefix("Meta") { keyName = "Meta" }
    else if code.hasPrefix("Control") { keyName = "Control" }
    else if code.hasPrefix("Shift") { keyName = "Shift" }
    else if code.hasPrefix("Alt") { keyName = "Alt" }
    else { keyName = named ?? (characters.isEmpty ? code : characters) }
    guard !code.isEmpty else { return }
    sendEvent(hardwareShortcutEventName, [
      "key": keyName,
      "code": code,
      "altKey": key.modifierFlags.contains(.alternate),
      "ctrlKey": key.modifierFlags.contains(.control),
      "metaKey": key.modifierFlags.contains(.command),
      "shiftKey": key.modifierFlags.contains(.shift),
      "repeat": isRepeat,
      "isComposing": isComposingText(),
      "phase": press.phase == .ended || press.phase == .cancelled ? "up" : "down",
    ])
  }
}

public final class PaseoHardwareKeyboardWindow: UIWindow {
  private var pressedCodes: Set<Int> = []
  public static func observing(_ original: UIWindow) -> UIWindow {
    if original is PaseoHardwareKeyboardWindow { return original }
    guard let scene = original.windowScene else { return original }
    let observed = PaseoHardwareKeyboardWindow(windowScene: scene)
    observed.windowLevel = original.windowLevel
    observed.backgroundColor = original.backgroundColor
    let controller = original.rootViewController
    original.rootViewController = nil
    original.isHidden = true
    observed.rootViewController = controller
    observed.makeKeyAndVisible()
    return observed
  }

  public override func sendEvent(_ event: UIEvent) {
    if let event = event as? UIPressesEvent {
      for press in event.allPresses where press.phase == .began || press.phase == .ended || press.phase == .cancelled {
        guard let key = press.key else { continue }
        let raw = Int(key.keyCode.rawValue)
        let isRepeat = press.phase == .began && pressedCodes.contains(raw)
        if press.phase == .began { pressedCodes.insert(raw) }
        else { pressedCodes.remove(raw) }
        activeModule?.emitHardwareKeyboardPress(press, isRepeat: isRepeat)
      }
    }
    super.sendEvent(event)
  }
  public override var keyCommands: [UIKeyCommand]? {
    var commands = super.keyCommands ?? []
    if isHardwareSubmitEnabled && !isPlainReturnClaimed && !isComposingText()
      && UIDevice.current.userInterfaceIdiom == .pad
    {
      commands.append(makeSubmitCommand())
    }
    if !isComposingText() {
      commands.append(contentsOf: overlayKeys.compactMap(makeShortcutCommand))
      commands.append(contentsOf: claimedShortcuts.map(makeClaimedCommand))
    }
    return commands
  }

  /// Whether something registered has already asked for an unmodified Return.
  ///
  /// The submit command is registered for as long as the composer holds focus,
  /// which includes while a picker is open over it. Registering both would put
  /// two commands on one press, and the composer would win a press the picker
  /// asked for — Enter would create the workspace instead of choosing a project.
  private var isPlainReturnClaimed: Bool {
    overlayKeys.contains("Enter")
  }

  private func makeSubmitCommand() -> UIKeyCommand {
    let command = UIKeyCommand(
      input: "\r",
      modifierFlags: [],
      action: #selector(handleHardwareKeyboardSubmit(_:))
    )
    if #available(iOS 15.0, *) {
      command.wantsPriorityOverSystemBehavior = true
    }
    return command
  }

  private func makeShortcutCommand(_ key: String) -> UIKeyCommand? {
    guard let input = namedKeyInputs[key] else { return nil }
    let command = UIKeyCommand(input: input, modifierFlags: [], action: #selector(handleHardwareKeyboardShortcut(_:)))
    if #available(iOS 15.0, *) { command.wantsPriorityOverSystemBehavior = true }
    return command
  }

  /// The window's press stream still emits the shortcut; the command only keeps
  /// the key away from the text control.
  private func makeClaimedCommand(_ shortcut: ClaimedShortcut) -> UIKeyCommand {
    let command = UIKeyCommand(
      input: shortcut.input,
      modifierFlags: shortcut.modifierFlags,
      action: #selector(handleHardwareKeyboardShortcut(_:))
    )
    if #available(iOS 15.0, *) { command.wantsPriorityOverSystemBehavior = true }
    return command
  }

  @objc
  private func handleHardwareKeyboardSubmit(_ sender: UIKeyCommand) {
    guard canSubmitCurrentTextInput() else {
      return
    }
    activeModule?.emitHardwareKeyboardSubmit()
  }

  @objc
  private func handleHardwareKeyboardShortcut(_ sender: UIKeyCommand) {}

  private func canSubmitCurrentTextInput() -> Bool {
    guard let responder = UIResponder.paseoCurrentFirstResponder else {
      return false
    }
    guard let textInput = responder as? UITextInput else {
      return false
    }
    return textInput.markedTextRange == nil
  }
}

private extension UIResponder {
  private static weak var currentFirstResponder: UIResponder?

  static var paseoCurrentFirstResponder: UIResponder? {
    currentFirstResponder = nil
    UIApplication.shared.sendAction(
      #selector(captureCurrentFirstResponder(_:)),
      to: nil,
      from: nil,
      for: nil
    )
    return currentFirstResponder
  }

  @objc
  private func captureCurrentFirstResponder(_ sender: Any?) {
    UIResponder.currentFirstResponder = self
  }
}


private func hardwareKeyCode(_ key: UIKey) -> String {
  let raw = key.keyCode.rawValue
  if raw >= 4 && raw <= 29 {
    let letter = UnicodeScalar(Int(raw) + 61)!
    return "Key" + String(letter)
  }
  if raw >= 30 && raw <= 38 { return "Digit" + String(raw - 29) }
  if raw == 39 { return "Digit0" }
  let codes: [Int: String] = [
    40: "Enter", 41: "Escape", 42: "Backspace", 43: "Tab", 44: "Space",
    45: "Minus", 46: "Equal", 47: "BracketLeft", 48: "BracketRight",
    49: "Backslash", 51: "Semicolon", 52: "Quote", 53: "Backquote",
    54: "Comma", 55: "Period", 56: "Slash", 76: "Delete", 79: "ArrowRight",
    80: "ArrowLeft", 81: "ArrowDown", 82: "ArrowUp", 224: "ControlLeft",
    225: "ShiftLeft", 226: "AltLeft", 227: "MetaLeft", 228: "ControlRight",
    229: "ShiftRight", 230: "AltRight", 231: "MetaRight",
  ]
  if raw >= 58 && raw <= 69 { return "F" + String(raw - 57) }
  return codes[Int(raw)] ?? ""
}
