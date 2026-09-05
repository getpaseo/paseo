import ExpoModulesCore
import UIKit

private let hardwareSubmitEventName = "onHardwareKeyboardSubmit"
private let hardwareShortcutEventName = "onHardwareKeyboardShortcut"

private weak var activeModule: PaseoHardwareKeyboardModule?
private var isHardwareSubmitEnabled = false
private var shortcuts: [HardwareShortcut] = []

fileprivate struct HardwareShortcut: Record {
  @Field var key: String = ""
  @Field var code: String = ""
  @Field var ctrlKey: Bool = false
  @Field var metaKey: Bool = false
  @Field var altKey: Bool = false
  @Field var shiftKey: Bool = false

  var modifiers: UIKeyModifierFlags {
    var flags: UIKeyModifierFlags = []
    if ctrlKey { flags.insert(.control) }
    if metaKey { flags.insert(.command) }
    if altKey { flags.insert(.alternate) }
    if shiftKey { flags.insert(.shift) }
    return flags
  }

  var input: String {
    switch code {
    case "ArrowLeft": return UIKeyCommand.inputLeftArrow
    case "ArrowRight": return UIKeyCommand.inputRightArrow
    case "ArrowUp": return UIKeyCommand.inputUpArrow
    case "ArrowDown": return UIKeyCommand.inputDownArrow
    case "Escape": return UIKeyCommand.inputEscape
    case "Enter": return "\r"
    case "Tab": return "\t"
    case "Backspace": return "\u{8}"
    case "Delete": return UIKeyCommand.inputDelete
    case "Home": return UIKeyCommand.inputHome
    case "End": return UIKeyCommand.inputEnd
    case "PageUp": return UIKeyCommand.inputPageUp
    case "PageDown": return UIKeyCommand.inputPageDown
    case "Insert": return "\u{F727}"
    default:
      if code.hasPrefix("F"), let number = Int(code.dropFirst()), (1...12).contains(number) {
        let keys = [UIKeyCommand.f1, UIKeyCommand.f2, UIKeyCommand.f3, UIKeyCommand.f4,
                    UIKeyCommand.f5, UIKeyCommand.f6, UIKeyCommand.f7, UIKeyCommand.f8,
                    UIKeyCommand.f9, UIKeyCommand.f10, UIKeyCommand.f11, UIKeyCommand.f12]
        return keys[number - 1]
      }
      return key
    }
  }

  var event: [String: Any] {
    return ["key": key, "code": code, "ctrlKey": ctrlKey, "metaKey": metaKey,
            "altKey": altKey, "shiftKey": shiftKey, "repeat": false]
  }
}

@objc
public class PaseoHardwareKeyboardReactDelegateHandler: ExpoReactDelegateHandler {
  public override func createRootViewController() -> UIViewController? {
    return PaseoHardwareKeyboardRootViewController()
  }
}

public class PaseoHardwareKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events(hardwareSubmitEventName, hardwareShortcutEventName)

    OnCreate {
      activeModule = self
    }

    Function("setHardwareKeyboardSubmitEnabled") { (enabled: Bool) in
      DispatchQueue.main.async {
        guard activeModule === self else { return }
        isHardwareSubmitEnabled = enabled
        UIMenuSystem.main.setNeedsRebuild()
      }
    }

    Function("setHardwareKeyboardShortcuts") { (commands: [HardwareShortcut]) in
      DispatchQueue.main.async {
        guard activeModule === self else { return }
        shortcuts = commands
        // Capture and chord steps replace commands without changing responders.
        UIMenuSystem.main.setNeedsRebuild()
      }
    }

    OnDestroy {
      DispatchQueue.main.async {
        guard activeModule === self else { return }
        activeModule = nil
        isHardwareSubmitEnabled = false
        shortcuts = []
        UIMenuSystem.main.setNeedsRebuild()
      }
    }
  }

  fileprivate func emitHardwareKeyboardSubmit() {
    sendEvent(hardwareSubmitEventName, [:])
  }

  fileprivate func emitShortcut(_ command: HardwareShortcut) {
    sendEvent(hardwareShortcutEventName, command.event)
  }
}

private final class PaseoHardwareKeyboardRootViewController: UIViewController {
  override var keyCommands: [UIKeyCommand]? {
    var commands = (super.keyCommands ?? []) + shortcuts.map { shortcut in
      let command = UIKeyCommand(input: shortcut.input, modifierFlags: shortcut.modifiers,
                                 action: #selector(handleShortcut(_:)))
      if #available(iOS 15.0, *) {
        command.wantsPriorityOverSystemBehavior = true
      }
      return command
    }
    guard isHardwareSubmitEnabled && UIDevice.current.userInterfaceIdiom == .pad else {
      return commands
    }

    let command = UIKeyCommand(
      input: "\r",
      modifierFlags: [],
      action: #selector(handleHardwareKeyboardSubmit(_:))
    )
    if #available(iOS 15.0, *) {
      command.wantsPriorityOverSystemBehavior = true
    }
    // Capture owns Enter while binding a shortcut, avoiding a second submit action.
    if !shortcuts.contains(where: { $0.input == "\r" && $0.modifiers.isEmpty }) {
      commands.append(command)
    }
    return commands
  }

  @objc
  private func handleShortcut(_ sender: UIKeyCommand) {
    if let textInput = UIResponder.paseoCurrentFirstResponder as? UITextInput,
       textInput.markedTextRange != nil {
      return
    }
    guard let shortcut = shortcuts.first(where: {
      $0.input == sender.input && $0.modifiers == sender.modifierFlags
    }) else { return }
    activeModule?.emitShortcut(shortcut)
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
