// The ActivityKit contract shared by the app and the widget extension.
//
// This file is the single source of truth for the Live Activity payload. It is
// compiled into two Swift modules:
//
//   1. the `PaseoLiveActivity` pod (the local Expo module), via a symlink at
//      `modules/paseo-live-activity/ios/PaseoFleetAttributes.swift`;
//   2. this widget extension, because @bacons/apple-targets makes every file in
//      the target directory a member of the extension target.
//
// ActivityKit matches an `Activity<Attributes>` to its `ActivityConfiguration`
// by the unqualified attributes type name, so the two module copies pair up.
//
// Keep `ContentState` field-for-field identical to `LiveActivityContentState` in
// `modules/paseo-live-activity/types.ts`. Codable uses the property names
// verbatim, so renaming a field here silently breaks the JS bridge.
//
// Do not import ExpoModulesCore, WidgetKit, or SwiftUI here: the pod links none
// of them.

import ActivityKit
import Foundation

/// Hero state reported by the JS controller. Raw values are the wire strings.
public enum PaseoFleetHeroState: String, Codable, Hashable, CaseIterable, Sendable {
  case running
  case needsYou = "needs_you"
  case error
  case finished
}

@available(iOS 16.2, *)
public struct PaseoFleetAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable, Sendable {
    public var heroTitle: String
    public var heroState: PaseoFleetHeroState
    /// Epoch milliseconds. Drives `Text(timerInterval:)` on the widget side, so
    /// the timer keeps ticking without an update from the app.
    public var sinceMs: Double
    public var phase: String?
    public var todoDone: Int?
    public var todoTotal: Int?
    public var permissionToolName: String?
    public var permissionDetail: String?
    public var needsYouCount: Int
    public var runningCount: Int

    public init(
      heroTitle: String,
      heroState: PaseoFleetHeroState,
      sinceMs: Double,
      phase: String? = nil,
      todoDone: Int? = nil,
      todoTotal: Int? = nil,
      permissionToolName: String? = nil,
      permissionDetail: String? = nil,
      needsYouCount: Int,
      runningCount: Int
    ) {
      self.heroTitle = heroTitle
      self.heroState = heroState
      self.sinceMs = sinceMs
      self.phase = phase
      self.todoDone = todoDone
      self.todoTotal = todoTotal
      self.permissionToolName = permissionToolName
      self.permissionDetail = permissionDetail
      self.needsYouCount = needsYouCount
      self.runningCount = runningCount
    }

    /// `sinceMs` as a `Date`, for timer ranges.
    public var since: Date {
      Date(timeIntervalSince1970: sinceMs / 1000)
    }
  }

  public init() {}
}
