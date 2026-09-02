import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

/// Fleet-mode colors from the design contract. Kept as literals rather than
/// asset colors so the extension has no asset-catalog dependency.
private enum PaseoColor {
  /// #30d158
  static let running = Color(red: 48 / 255, green: 209 / 255, blue: 88 / 255)
  /// #ff9f0a
  static let needsYou = Color(red: 255 / 255, green: 159 / 255, blue: 10 / 255)
  /// #ff453a
  static let error = Color(red: 255 / 255, green: 69 / 255, blue: 58 / 255)
}

/// The app's registered URL scheme. Anything else in a content-state link is a
/// bug upstream, and honoring it would send the tap to Safari or another app.
private let paseoURLScheme = "paseo"

/// Parses a content-state link, rejecting empty strings, unparseable URLs, and
/// foreign schemes. Callers omit the control instead of substituting a target.
private func paseoLink(_ raw: String?) -> URL? {
  guard let raw, !raw.isEmpty, let url = URL(string: raw) else { return nil }
  guard url.scheme?.lowercased() == paseoURLScheme else { return nil }
  return url
}

/// A label plus a destination that is known to be openable. Failing the
/// initializer is how an incomplete or invalid action disappears.
private struct PaseoFleetAction {
  let label: String
  let url: URL

  init?(label: String?, deepLink: String?) {
    guard
      let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines),
      !trimmed.isEmpty,
      let url = paseoLink(deepLink)
    else { return nil }
    self.label = trimmed
    self.url = url
  }
}

extension PaseoFleetHeroState {
  fileprivate var tint: Color {
    switch self {
    case .running, .finished: return PaseoColor.running
    case .needsYou: return PaseoColor.needsYou
    case .error: return PaseoColor.error
    }
  }

  fileprivate var word: String {
    switch self {
    case .running: return "Running"
    case .needsYou: return "Needs you"
    case .error: return "Error"
    case .finished: return "Finished"
    }
  }

  fileprivate var glyph: String {
    switch self {
    case .running: return "bolt.fill"
    case .needsYou: return "exclamationmark.triangle.fill"
    case .error: return "exclamationmark.octagon.fill"
    case .finished: return "checkmark.circle.fill"
    }
  }

  /// A finished activity has nothing left to time.
  fileprivate var showsTimer: Bool {
    self != .finished
  }
}

@available(iOS 16.2, *)
extension PaseoFleetAttributes.ContentState {
  /// `(done, total)` only when the hero actually reported a todo list.
  fileprivate var todoProgress: (done: Int, total: Int)? {
    guard let total = todoTotal, total > 0 else { return nil }
    return (min(max(todoDone ?? 0, 0), total), total)
  }

  /// "Approve: <tool>" headline, only for a pending permission request.
  fileprivate var approvalHeadline: String? {
    guard heroState == .needsYou, let tool = permissionToolName, !tool.isEmpty else {
      return nil
    }
    return "Approve: \(tool)"
  }

  fileprivate var phaseLine: String? {
    guard let phase, !phase.isEmpty else { return nil }
    return phase
  }

  /// The strip is noise when there is only one agent to talk about.
  fileprivate var showsFleetStrip: Bool {
    needsYouCount + runningCount > 1
  }

  /// Destination for the whole-surface tap on the Lock Screen, compact, and
  /// minimal presentations.
  fileprivate var heroURL: URL? {
    paseoLink(heroDeepLink)
  }

  fileprivate var primaryAction: PaseoFleetAction? {
    PaseoFleetAction(label: primaryActionLabel, deepLink: primaryActionDeepLink)
  }

  fileprivate var secondaryAction: PaseoFleetAction? {
    PaseoFleetAction(label: secondaryActionLabel, deepLink: secondaryActionDeepLink)
  }

  fileprivate var hasActions: Bool {
    primaryAction != nil || secondaryAction != nil
  }
}

/// Elapsed-time text that ticks on the widget's own clock.
private struct ElapsedTimer: View {
  let since: Date

  var body: some View {
    // 12h covers the longest an activity can stay alive; past the range the
    // system freezes the label instead of rolling over.
    Text(timerInterval: since...since.addingTimeInterval(43_200), countsDown: false)
      .monospacedDigit()
  }
}

private struct StateDot: View {
  let state: PaseoFleetHeroState

  var body: some View {
    if state == .finished {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 11, weight: .bold))
        .foregroundStyle(PaseoColor.running)
    } else {
      Circle()
        .fill(state.tint)
        .frame(width: 8, height: 8)
    }
  }
}

@available(iOS 16.2, *)
private struct TodoBar: View {
  let state: PaseoFleetAttributes.ContentState
  let progress: (done: Int, total: Int)

  var body: some View {
    HStack(spacing: 6) {
      ProgressView(value: Double(progress.done), total: Double(progress.total))
        .progressViewStyle(.linear)
        .tint(state.heroState.tint)
      Text("\(progress.done)/\(progress.total)")
        .font(.caption2.monospacedDigit())
        .foregroundStyle(.secondary)
    }
  }
}

@available(iOS 16.2, *)
private struct FleetStrip: View {
  let state: PaseoFleetAttributes.ContentState

  var body: some View {
    HStack(spacing: 6) {
      if state.needsYouCount > 0 {
        Label("\(state.needsYouCount) need you", systemImage: "exclamationmark.triangle.fill")
          .foregroundStyle(PaseoColor.needsYou)
      }
      if state.needsYouCount > 0 && state.runningCount > 0 {
        Text("·").foregroundStyle(.secondary)
      }
      if state.runningCount > 0 {
        Label("\(state.runningCount) running", systemImage: "circle.fill")
          .foregroundStyle(PaseoColor.running)
      }
    }
    .font(.caption2)
    .labelStyle(.titleAndIcon)
    .imageScale(.small)
    .lineLimit(1)
  }
}

/// Capsule shell for an expanded-Dynamic-Island action.
///
/// The expanded presentation is always drawn on the black island, so the
/// contrast pair is fixed: black text on the state tint for the primary, white
/// text on a translucent white fill for the secondary.
private struct ActionCapsule: View {
  let label: String
  let fill: Color
  let foreground: Color

  var body: some View {
    Text(label)
      .font(.caption2.weight(.semibold))
      .lineLimit(1)
      .minimumScaleFactor(0.85)
      .foregroundStyle(foreground)
      .padding(.horizontal, 12)
      .padding(.vertical, 5)
      .background(fill, in: Capsule())
  }
}

/// Up to two real `Link`s. Apple allows `Link` in the expanded presentation
/// only, which is why nothing here is reused by the Lock Screen or the compact
/// presentations: those get a whole-surface `widgetURL` instead.
@available(iOS 16.2, *)
private struct ActionRow: View {
  let state: PaseoFleetAttributes.ContentState

  var body: some View {
    HStack(spacing: 8) {
      if let primary = state.primaryAction {
        Link(destination: primary.url) {
          ActionCapsule(
            label: primary.label,
            fill: state.heroState.tint,
            foreground: .black
          )
        }
      }
      if let secondary = state.secondaryAction {
        Link(destination: secondary.url) {
          ActionCapsule(
            label: secondary.label,
            fill: Color.white.opacity(0.18),
            foreground: .white
          )
        }
      }
    }
  }
}

@available(iOS 16.2, *)
private struct LockScreenBanner: View {
  let state: PaseoFleetAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        StateDot(state: state.heroState)
        Text("Paseo")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
        Text(state.heroState.word)
          .font(.caption2)
          .foregroundStyle(state.heroState.tint)
        Spacer(minLength: 8)
        if state.heroState.showsTimer {
          ElapsedTimer(since: state.since)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      Text(state.heroTitle)
        .font(.headline)
        .lineLimit(1)

      if let approval = state.approvalHeadline {
        Text(approval)
          .font(.caption.weight(.semibold))
          .foregroundStyle(PaseoColor.needsYou)
          .lineLimit(1)
      }

      if let phase = state.phaseLine {
        Text(phase)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }

      if let progress = state.todoProgress {
        TodoBar(state: state, progress: progress)
      }

      if state.showsFleetStrip {
        FleetStrip(state: state)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

@available(iOS 16.2, *)
struct PaseoFleetLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: PaseoFleetAttributes.self) { context in
      LockScreenBanner(state: context.state)
        .activityBackgroundTint(Color.black.opacity(0.4))
        .activitySystemActionForegroundColor(.white)
        .widgetURL(context.state.heroURL)
    } dynamicIsland: { context in
      let state = context.state

      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 6) {
            StateDot(state: state.heroState)
            Text("Paseo")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(.secondary)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          if state.heroState.showsTimer {
            ElapsedTimer(since: state.since)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        DynamicIslandExpandedRegion(.center) {
          Text(state.heroTitle)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 4) {
            if let approval = state.approvalHeadline {
              Text(approval)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(PaseoColor.needsYou)
                .lineLimit(1)
            }

            if let phase = state.phaseLine {
              Text(phase)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            if let progress = state.todoProgress {
              TodoBar(state: state, progress: progress)
            }
            if state.hasActions {
              ActionRow(state: state)
                .padding(.top, 2)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        Image(systemName: state.heroState.glyph)
          .foregroundStyle(state.heroState.tint)
      } compactTrailing: {
        if state.needsYouCount > 0 {
          HStack(spacing: 2) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text("\(state.needsYouCount)").monospacedDigit()
          }
          .font(.caption2)
          .foregroundStyle(PaseoColor.needsYou)
        } else if state.heroState.showsTimer {
          ElapsedTimer(since: state.since)
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
      } minimal: {
        Circle()
          .fill(state.heroState.tint)
          .frame(width: 8, height: 8)
      }
      .widgetURL(state.heroURL)
      .keylineTint(state.heroState.tint)
    }
  }
}
