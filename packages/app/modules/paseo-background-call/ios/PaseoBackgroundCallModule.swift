import AVFoundation
import ExpoModulesCore

public class PaseoBackgroundCallModule: Module {
  private var isActive = false

  public func definition() -> ModuleDefinition {
    Name("PaseoBackgroundCall")

    AsyncFunction("begin") { () throws in
      guard !self.isActive else {
        return
      }

      let session = AVAudioSession.sharedInstance()
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.allowBluetooth, .defaultToSpeaker]
      )
      try session.setActive(true)
      self.isActive = true
    }.runOnQueue(.main)

    AsyncFunction("end") { () throws in
      try self.end()
    }.runOnQueue(.main)

    OnDestroy {
      try? self.end()
    }
  }

  private func end() throws {
    guard isActive else {
      return
    }

    try AVAudioSession.sharedInstance().setActive(
      false,
      options: .notifyOthersOnDeactivation
    )
    isActive = false
  }
}
