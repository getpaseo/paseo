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
    /// Whole-surface tap destination: the exact hero agent, plus the pending
    /// request when there is one. Empty or unparseable means the surface has no
    /// destination, and the widget renders no tap target rather than guessing.
    public var heroDeepLink: String
    /// Label/URL pairs for the expanded Dynamic Island controls. Flat fields
    /// because the Expo bridge carries no nested records. A pair is only
    /// rendered when both halves are present and the URL is a valid `paseo://`
    /// link.
    public var primaryActionLabel: String?
    public var primaryActionDeepLink: String?
    public var secondaryActionLabel: String?
    public var secondaryActionDeepLink: String?

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
      runningCount: Int,
      heroDeepLink: String,
      primaryActionLabel: String? = nil,
      primaryActionDeepLink: String? = nil,
      secondaryActionLabel: String? = nil,
      secondaryActionDeepLink: String? = nil
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
      self.heroDeepLink = heroDeepLink
      self.primaryActionLabel = primaryActionLabel
      self.primaryActionDeepLink = primaryActionDeepLink
      self.secondaryActionLabel = secondaryActionLabel
      self.secondaryActionDeepLink = secondaryActionDeepLink
    }

    /// `sinceMs` as a `Date`, for timer ranges.
    public var since: Date {
      Date(timeIntervalSince1970: sinceMs / 1000)
    }
  }

  public init() {}
}
