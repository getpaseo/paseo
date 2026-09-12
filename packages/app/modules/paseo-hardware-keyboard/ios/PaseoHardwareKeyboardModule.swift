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
  @Field var namedKey: String = ""
  @Field var command: Bool = false
  @Field var alternate: Bool = false
  @Field var control: Bool = false
  @Field var shift: Bool = false
}

/// UIKit spells non-character keys as sentinel input strings rather than as the
/// character they would type. JS sends the DOM `code` and the mapping lives
/// here, so the constants stay in the one place that owns UIKit vocabulary.
/// Keep this in step with `NATIVE_NAMED_KEY_CODES` in `keyboard/native-shortcuts.ts`.
private let namedKeyInputs: [String: String] = [
  "Escape": UIKeyCommand.inputEscape,
  "ArrowUp": UIKeyCommand.inputUpArrow,
  "ArrowDown": UIKeyCommand.inputDownArrow,
  "Enter": "\r",
]

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

private func resolveKeyCommandInput(_ record: KeyCommandRecord) -> String? {
  if record.namedKey.isEmpty {
    return record.input.isEmpty ? nil : record.input
  }
  return namedKeyInputs[record.namedKey]
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
        registeredKeyCommands = commands.compactMap { record in
          // An unmapped named key would otherwise register under the empty
          // input and match nothing, so drop it rather than carry a dead
          // command that hides the missing mapping.
          guard let input = resolveKeyCommandInput(record) else {
            return nil
          }
          var modifierFlags: UIKeyModifierFlags = []
          if record.command { modifierFlags.insert(.command) }
          if record.alternate { modifierFlags.insert(.alternate) }
          if record.control { modifierFlags.insert(.control) }
          if record.shift { modifierFlags.insert(.shift) }
          return KeyCommandSpec(
            combo: record.combo,
            input: input,
            modifierFlags: modifierFlags
          )
        }
        // The set now changes while the app runs -- a terminal takes Escape back
        // whenever it holds focus, and an overlay asks for Enter and the arrows
        // only while it is open. UIKit serves key commands from a menu it builds
        // once, so the rebuild is what makes the new list take effect.
        UIMenuSystem.main.setNeedsRebuild()
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
    if isHardwareSubmitEnabled && !isPlainReturnClaimed
      && UIDevice.current.userInterfaceIdiom == .pad
    {
      commands.append(makeSubmitCommand())
    }
    commands.append(contentsOf: registeredKeyCommands.map(makeShortcutCommand))
    return commands
  }

  /// Whether something registered has already asked for an unmodified Return.
  ///
  /// The submit command is registered for as long as the composer holds focus,
  /// which includes while a picker is open over it. Registering both would put
  /// two commands on one press, and the composer would win a press the picker
  /// asked for — Enter would create the workspace instead of choosing a project.
  private var isPlainReturnClaimed: Bool {
    registeredKeyCommands.contains { $0.input == "\r" && $0.modifierFlags.isEmpty }
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
    // `propertyList` is read-only, so the combo has to ride in through the
    // initializer rather than being assigned after the fact.
    let command = UIKeyCommand(
      title: "",
      image: nil,
      action: #selector(handleHardwareKeyboardShortcut(_:)),
      input: spec.input,
      modifierFlags: spec.modifierFlags,
      propertyList: spec.combo
    )
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
    if combo == "Enter" && isComposingText() {
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
