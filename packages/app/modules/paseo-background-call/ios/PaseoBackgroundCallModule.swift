import AVFoundation
import ExpoModulesCore
import WebRTC

public class PaseoBackgroundCallModule: Module {
  private var isActive = false

  public func definition() -> ModuleDefinition {
    Name("PaseoBackgroundCall")

    AsyncFunction("begin") { () throws in
      guard !self.isActive else {
        return
      }

      // libwebrtc reapplies RTCAudioSessionConfiguration.webRTC() whenever its
      // audio unit starts, replacing the category options set below. The stock
      // configuration omits .defaultToSpeaker, which lands hand-held calls on
      // the near-silent receiver. Adding the option to that shared
      // configuration keeps routing with the system: headphones and Bluetooth
      // still win, the loudspeaker replaces the receiver as the no-accessory
      // fallback, and a route the user picks mid-call is left alone.
      let webRTCConfiguration = RTCAudioSessionConfiguration.webRTC()
      webRTCConfiguration.categoryOptions.insert(.defaultToSpeaker)
      RTCAudioSessionConfiguration.setWebRTC(webRTCConfiguration)

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
