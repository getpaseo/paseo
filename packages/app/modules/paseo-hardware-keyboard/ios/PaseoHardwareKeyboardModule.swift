import ExpoModulesCore
import UIKit

private let hardwareSubmitEventName = "onHardwareKeyboardSubmit"
private let hardwareShortcutEventName = "onHardwareKeyboardShortcut"

private weak var activeModule: PaseoHardwareKeyboardModule?
private var isHardwareSubmitEnabled = false
private var registeredKeyCommands: [KeyCommandSpec] = []

private struct KeyCommandSpec {
  let combo: String
  let input: String
  let modifierFlags: UIKeyModifierFlags
}

struct KeyCommandRecord: Record {
  @Field var combo: String = ""
  @Field var input: String = ""
  @Field var command: Bool = false
  @Field var alternate: Bool = false
  @Field var control: Bool = false
  @Field var shift: Bool = false
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
        isHardwareSubmitEnabled = enabled
      }
    }

    // The combo string is opaque to UIKit: it rides along on the command and
    // comes back on the event so JS resolves the press through the same binding
    // table the web listener uses, instead of a second native-only mapping.
    Function("setKeyCommands") { (commands: [KeyCommandRecord]) in
      DispatchQueue.main.async {
        registeredKeyCommands = commands.map { record in
          var modifierFlags: UIKeyModifierFlags = []
          if record.command { modifierFlags.insert(.command) }
          if record.alternate { modifierFlags.insert(.alternate) }
          if record.control { modifierFlags.insert(.control) }
          if record.shift { modifierFlags.insert(.shift) }
          return KeyCommandSpec(
            combo: record.combo,
            input: record.input,
            modifierFlags: modifierFlags
          )
        }
      }
    }

    OnDestroy {
      if activeModule === self {
        activeModule = nil
      }
      isHardwareSubmitEnabled = false
      registeredKeyCommands = []
    }
  }

  fileprivate func emitHardwareKeyboardSubmit() {
    sendEvent(hardwareSubmitEventName, [:])
  }

  fileprivate func emitHardwareKeyboardShortcut(combo: String) {
    sendEvent(hardwareShortcutEventName, ["combo": combo])
  }
}

private final class PaseoHardwareKeyboardRootViewController: UIViewController {
  override var keyCommands: [UIKeyCommand]? {
    var commands = super.keyCommands ?? []
    if isHardwareSubmitEnabled && UIDevice.current.userInterfaceIdiom == .pad {
      commands.append(makeSubmitCommand())
    }
    commands.append(contentsOf: registeredKeyCommands.map(makeShortcutCommand))
    return commands
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

  private func makeShortcutCommand(_ spec: KeyCommandSpec) -> UIKeyCommand {
    let command = UIKeyCommand(
      input: spec.input,
      modifierFlags: spec.modifierFlags,
      action: #selector(handleHardwareKeyboardShortcut(_:))
    )
    command.propertyList = spec.combo
    if #available(iOS 15.0, *) {
      command.wantsPriorityOverSystemBehavior = true
    }
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
  private func handleHardwareKeyboardShortcut(_ sender: UIKeyCommand) {
    guard let combo = sender.propertyList as? String else {
      return
    }
    activeModule?.emitHardwareKeyboardShortcut(combo: combo)
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
