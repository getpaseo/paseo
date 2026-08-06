import ExpoModulesCore
import UIKit

private let hardwareSubmitEventName = "onHardwareKeyboardSubmit"
private let hardwareKeyDownEventName = "onHardwareKeyDown"

private weak var activeModule: PaseoHardwareKeyboardModule?
private var isHardwareSubmitEnabled = false
private var isHardwareKeyEventsEnabled = false

@objc
public class PaseoHardwareKeyboardReactDelegateHandler: ExpoReactDelegateHandler {
  public override func createRootViewController() -> UIViewController? {
    return PaseoHardwareKeyboardRootViewController()
  }
}

public class PaseoHardwareKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events(hardwareSubmitEventName, hardwareKeyDownEventName)

    OnCreate {
      activeModule = self
    }

    Function("setHardwareKeyboardSubmitEnabled") { (enabled: Bool) in
      DispatchQueue.main.async {
        isHardwareSubmitEnabled = enabled
      }
    }

    Function("setHardwareKeyEventsEnabled") { (enabled: Bool) in
      DispatchQueue.main.async {
        isHardwareKeyEventsEnabled = enabled
      }
    }

    OnDestroy {
      if activeModule === self {
        activeModule = nil
      }
      isHardwareSubmitEnabled = false
      isHardwareKeyEventsEnabled = false
    }
  }

  fileprivate func emitHardwareKeyboardSubmit() {
    sendEvent(hardwareSubmitEventName, [:])
  }

  fileprivate func emitHardwareKeyDown(_ payload: [String: Any]) {
    sendEvent(hardwareKeyDownEventName, payload)
  }
}

private final class PaseoHardwareKeyboardRootViewController: UIViewController {
  override var keyCommands: [UIKeyCommand]? {
    guard isHardwareSubmitEnabled else {
      return super.keyCommands
    }

    // iPad convention: Enter sends, Shift+Enter inserts a newline. On iPhone
    // Enter keeps inserting a newline, so Shift+Enter sends instead.
    let isPad = UIDevice.current.userInterfaceIdiom == .pad
    let command = UIKeyCommand(
      input: "\r",
      modifierFlags: isPad ? [] : [.shift],
      action: #selector(handleHardwareKeyboardSubmit(_:))
    )
    if #available(iOS 15.0, *) {
      command.wantsPriorityOverSystemBehavior = true
    }
    return (super.keyCommands ?? []) + [command]
  }

  // Hardware key presses that no descendant responder consumes bubble up here.
  // Text inputs consume plain character keys, but modifier combos (Cmd/Ctrl/Alt),
  // Escape, and function keys propagate, which is exactly the set the JS shortcut
  // registry needs. Plain keys are intentionally never emitted: they would race
  // with text entry.
  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    if isHardwareKeyEventsEnabled, #available(iOS 13.4, *) {
      for press in presses {
        guard let key = press.key, let payload = shortcutKeyDownPayload(for: key) else {
          continue
        }
        activeModule?.emitHardwareKeyDown(payload)
      }
    }
    super.pressesBegan(presses, with: event)
  }

  @available(iOS 13.4, *)
  private func shortcutKeyDownPayload(for key: UIKey) -> [String: Any]? {
    guard let code = domCode(for: key.keyCode) else {
      return nil
    }
    let flags = key.modifierFlags
    let metaKey = flags.contains(.command)
    let ctrlKey = flags.contains(.control)
    let altKey = flags.contains(.alternate)
    let shiftKey = flags.contains(.shift)

    let isFunctionKey = code.hasPrefix("F") && code.count <= 3
    let isShortcutWorthy = metaKey || ctrlKey || altKey || code == "Escape" || isFunctionKey
    guard isShortcutWorthy else {
      return nil
    }

    return [
      "code": code,
      "metaKey": metaKey,
      "ctrlKey": ctrlKey,
      "altKey": altKey,
      "shiftKey": shiftKey,
    ]
  }

  @available(iOS 13.4, *)
  private func domCode(for keyCode: UIKeyboardHIDUsage) -> String? {
    switch keyCode {
    case .keyboardA: return "KeyA"
    case .keyboardB: return "KeyB"
    case .keyboardC: return "KeyC"
    case .keyboardD: return "KeyD"
    case .keyboardE: return "KeyE"
    case .keyboardF: return "KeyF"
    case .keyboardG: return "KeyG"
    case .keyboardH: return "KeyH"
    case .keyboardI: return "KeyI"
    case .keyboardJ: return "KeyJ"
    case .keyboardK: return "KeyK"
    case .keyboardL: return "KeyL"
    case .keyboardM: return "KeyM"
    case .keyboardN: return "KeyN"
    case .keyboardO: return "KeyO"
    case .keyboardP: return "KeyP"
    case .keyboardQ: return "KeyQ"
    case .keyboardR: return "KeyR"
    case .keyboardS: return "KeyS"
    case .keyboardT: return "KeyT"
    case .keyboardU: return "KeyU"
    case .keyboardV: return "KeyV"
    case .keyboardW: return "KeyW"
    case .keyboardX: return "KeyX"
    case .keyboardY: return "KeyY"
    case .keyboardZ: return "KeyZ"
    case .keyboard1: return "Digit1"
    case .keyboard2: return "Digit2"
    case .keyboard3: return "Digit3"
    case .keyboard4: return "Digit4"
    case .keyboard5: return "Digit5"
    case .keyboard6: return "Digit6"
    case .keyboard7: return "Digit7"
    case .keyboard8: return "Digit8"
    case .keyboard9: return "Digit9"
    case .keyboard0: return "Digit0"
    case .keyboardReturnOrEnter: return "Enter"
    case .keyboardEscape: return "Escape"
    case .keyboardDeleteOrBackspace: return "Backspace"
    case .keyboardTab: return "Tab"
    case .keyboardSpacebar: return "Space"
    case .keyboardHyphen: return "Minus"
    case .keyboardEqualSign: return "Equal"
    case .keyboardOpenBracket: return "BracketLeft"
    case .keyboardCloseBracket: return "BracketRight"
    case .keyboardBackslash: return "Backslash"
    case .keyboardSemicolon: return "Semicolon"
    case .keyboardQuote: return "Quote"
    case .keyboardGraveAccentAndTilde: return "Backquote"
    case .keyboardComma: return "Comma"
    case .keyboardPeriod: return "Period"
    case .keyboardSlash: return "Slash"
    case .keyboardF1: return "F1"
    case .keyboardF2: return "F2"
    case .keyboardF3: return "F3"
    case .keyboardF4: return "F4"
    case .keyboardF5: return "F5"
    case .keyboardF6: return "F6"
    case .keyboardF7: return "F7"
    case .keyboardF8: return "F8"
    case .keyboardF9: return "F9"
    case .keyboardF10: return "F10"
    case .keyboardF11: return "F11"
    case .keyboardF12: return "F12"
    case .keyboardLeftArrow: return "ArrowLeft"
    case .keyboardRightArrow: return "ArrowRight"
    case .keyboardUpArrow: return "ArrowUp"
    case .keyboardDownArrow: return "ArrowDown"
    case .keyboardHome: return "Home"
    case .keyboardEnd: return "End"
    case .keyboardPageUp: return "PageUp"
    case .keyboardPageDown: return "PageDown"
    case .keyboardDeleteForward: return "Delete"
    default: return nil
    }
  }

  @objc
  private func handleHardwareKeyboardSubmit(_ sender: UIKeyCommand) {
    guard canSubmitCurrentTextInput() else {
      return
    }
    activeModule?.emitHardwareKeyboardSubmit()
  }

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
