import ExpoModulesCore
import GameController
import UIKit

private let hardwareSubmitEventName = "onHardwareKeyboardSubmit"
private let hardwareConnectionEventName = "onHardwareKeyboardConnectionChange"

private weak var activeModule: PaseoHardwareKeyboardModule?
private var isHardwareSubmitEnabled = false

// why: GCKeyboard.coalesced is the public signal for an attached hardware keyboard, and it needs iOS 14.
private func isHardwareKeyboardAttached() -> Bool {
  guard #available(iOS 14.0, *) else {
    return false
  }
  return GCKeyboard.coalesced != nil
}

@objc
public class PaseoHardwareKeyboardReactDelegateHandler: ExpoReactDelegateHandler {
  public override func createRootViewController() -> UIViewController? {
    return PaseoHardwareKeyboardRootViewController()
  }
}

public class PaseoHardwareKeyboardModule: Module {
  private var connectionObservers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events(hardwareSubmitEventName, hardwareConnectionEventName)

    OnCreate {
      activeModule = self
    }

    Function("setHardwareKeyboardSubmitEnabled") { (enabled: Bool) in
      DispatchQueue.main.async {
        isHardwareSubmitEnabled = enabled
      }
    }

    Function("isHardwareKeyboardConnected") { () -> Bool in
      return isHardwareKeyboardAttached()
    }

    // Observers run only while JS has a listener, so no notifications are delivered otherwise.
    OnStartObserving {
      guard #available(iOS 14.0, *) else {
        return
      }
      let emit: (Notification) -> Void = { [weak self] _ in
        self?.sendEvent(hardwareConnectionEventName, ["connected": isHardwareKeyboardAttached()])
      }
      connectionObservers = [
        NotificationCenter.default.addObserver(
          forName: .GCKeyboardDidConnect, object: nil, queue: .main, using: emit),
        NotificationCenter.default.addObserver(
          forName: .GCKeyboardDidDisconnect, object: nil, queue: .main, using: emit),
      ]
      // Sends the state at start so a change made before observing began is not lost.
      self.sendEvent(hardwareConnectionEventName, ["connected": isHardwareKeyboardAttached()])
    }

    OnStopObserving {
      self.removeConnectionObservers()
    }

    OnDestroy {
      // why: OnStopObserving may not run on a bridge reload while a listener is active, so observers would leak.
      self.removeConnectionObservers()
      if activeModule === self {
        activeModule = nil
      }
      isHardwareSubmitEnabled = false
    }
  }

  fileprivate func emitHardwareKeyboardSubmit() {
    sendEvent(hardwareSubmitEventName, [:])
  }

  private func removeConnectionObservers() {
    for observer in connectionObservers {
      NotificationCenter.default.removeObserver(observer)
    }
    connectionObservers = []
  }
}

private final class PaseoHardwareKeyboardRootViewController: UIViewController {
  override var keyCommands: [UIKeyCommand]? {
    guard isHardwareSubmitEnabled && UIDevice.current.userInterfaceIdiom == .pad else {
      return super.keyCommands
    }

    let command = UIKeyCommand(
      input: "\r",
      modifierFlags: [],
      action: #selector(handleHardwareKeyboardSubmit(_:))
    )
    if #available(iOS 15.0, *) {
      command.wantsPriorityOverSystemBehavior = true
    }
    return (super.keyCommands ?? []) + [command]
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
