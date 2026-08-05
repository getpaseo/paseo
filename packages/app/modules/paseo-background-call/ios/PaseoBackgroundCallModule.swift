import AVFoundation
import ExpoModulesCore

public class PaseoBackgroundCallModule: Module {
  private var isActive = false
  private var routeObserver: NSObjectProtocol?

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

      // WebRTC applies its own session configuration when its audio unit
      // starts, dropping .defaultToSpeaker and landing hand-held calls on the
      // near-silent receiver. Whenever the route falls back to the receiver,
      // push it to the speaker; headphone and Bluetooth routes are left alone.
      self.applySpeakerFallback()
      self.routeObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.applySpeakerFallback()
      }
    }.runOnQueue(.main)

    AsyncFunction("end") { () throws in
      try self.end()
    }.runOnQueue(.main)

    OnDestroy {
      try? self.end()
    }
  }

  private func applySpeakerFallback() {
    guard isActive else {
      return
    }

    let session = AVAudioSession.sharedInstance()
    let onReceiver = session.currentRoute.outputs.contains {
      $0.portType == .builtInReceiver
    }
    guard onReceiver else {
      return
    }
    try? session.overrideOutputAudioPort(.speaker)
  }

  private func end() throws {
    guard isActive else {
      return
    }

    if let observer = routeObserver {
      NotificationCenter.default.removeObserver(observer)
      routeObserver = nil
    }
    try AVAudioSession.sharedInstance().setActive(
      false,
      options: .notifyOthersOnDeactivation
    )
    isActive = false
  }
}
