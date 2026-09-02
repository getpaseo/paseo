import ActivityKit
import ExpoModulesCore

/// Argument record for the JS `LiveActivityContentState`. Names must match
/// `types.ts` exactly; Expo maps JS object keys to `@Field` names.
internal struct PaseoFleetStateRecord: Record {
  @Field var heroTitle: String = ""
  @Field var heroState: PaseoFleetHeroState = .running
  @Field var sinceMs: Double = 0
  @Field var phase: String?
  @Field var todoDone: Int?
  @Field var todoTotal: Int?
  @Field var permissionToolName: String?
  @Field var permissionDetail: String?
  @Field var needsYouCount: Int = 0
  @Field var runningCount: Int = 0
  @Field var heroDeepLink: String = ""
  @Field var primaryActionLabel: String?
  @Field var primaryActionDeepLink: String?
  @Field var secondaryActionLabel: String?
  @Field var secondaryActionDeepLink: String?
}

/// Lets Expo convert the JS string union into the shared enum, and reject
/// anything outside it with a descriptive error.
extension PaseoFleetHeroState: Enumerable {}

@available(iOS 16.2, *)
extension PaseoFleetStateRecord {
  fileprivate var contentState: PaseoFleetAttributes.ContentState {
    PaseoFleetAttributes.ContentState(
      heroTitle: heroTitle,
      heroState: heroState,
      sinceMs: sinceMs,
      phase: phase,
      todoDone: todoDone,
      todoTotal: todoTotal,
      permissionToolName: permissionToolName,
      permissionDetail: permissionDetail,
      needsYouCount: needsYouCount,
      runningCount: runningCount,
      heroDeepLink: heroDeepLink,
      primaryActionLabel: primaryActionLabel,
      primaryActionDeepLink: primaryActionDeepLink,
      secondaryActionLabel: secondaryActionLabel,
      secondaryActionDeepLink: secondaryActionDeepLink
    )
  }
}

internal final class LiveActivityUnsupportedException: Exception {
  override var reason: String {
    "Live Activities require iOS 16.2 or newer"
  }
}

internal final class LiveActivityRequestFailedException: GenericException<String> {
  override var reason: String {
    "Could not start the Paseo Live Activity: \(param)"
  }
}

/// Owns the single fleet-mode activity.
///
/// Isolated in its own `@available` type so the module class itself stays
/// buildable against the app's iOS 15.1 deployment target.
@available(iOS 16.2, *)
internal final class PaseoFleetActivityStore {
  static let shared = PaseoFleetActivityStore()

  private var activity: Activity<PaseoFleetAttributes>?

  /// Adopts an activity that outlived the JS handle (app relaunch, JS reload).
  /// Without this, `update` after a reload would silently do nothing while a
  /// stale banner stayed on the lock screen.
  private func liveActivity() -> Activity<PaseoFleetAttributes>? {
    if let activity, activity.activityState == .active {
      return activity
    }
    let adopted = Activity<PaseoFleetAttributes>.activities.first { $0.activityState == .active }
    activity = adopted
    return adopted
  }

  private func endAll(dismissalPolicy: ActivityUIDismissalPolicy) async {
    activity = nil
    for existing in Activity<PaseoFleetAttributes>.activities {
      await existing.end(nil, dismissalPolicy: dismissalPolicy)
    }
  }

  func start(state: PaseoFleetAttributes.ContentState) async throws {
    // Idempotent: one Paseo activity at a time, including leftovers from a
    // previous launch that ActivityKit still considers live.
    await endAll(dismissalPolicy: .immediate)
    do {
      activity = try Activity.request(
        attributes: PaseoFleetAttributes(),
        content: ActivityContent(state: state, staleDate: nil),
        pushType: nil
      )
    } catch {
      throw LiveActivityRequestFailedException(error.localizedDescription)
    }
  }

  func update(state: PaseoFleetAttributes.ContentState) async {
    guard let activity = liveActivity() else { return }
    await activity.update(ActivityContent(state: state, staleDate: nil))
  }

  func end(state: PaseoFleetAttributes.ContentState, dismissAfterSeconds: Double) async {
    guard let activity = liveActivity() else { return }
    let policy: ActivityUIDismissalPolicy =
      dismissAfterSeconds > 0
      ? .after(Date().addingTimeInterval(dismissAfterSeconds))
      : .immediate
    await activity.end(
      ActivityContent(state: state, staleDate: nil),
      dismissalPolicy: policy
    )
    self.activity = nil
  }
}

public final class PaseoLiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoLiveActivity")

    Function("isSupported") { () -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      return ActivityAuthorizationInfo().areActivitiesEnabled
    }

    AsyncFunction("start") { (state: PaseoFleetStateRecord) in
      guard #available(iOS 16.2, *) else { throw LiveActivityUnsupportedException() }
      try await PaseoFleetActivityStore.shared.start(state: state.contentState)
    }

    AsyncFunction("update") { (state: PaseoFleetStateRecord) in
      guard #available(iOS 16.2, *) else { return }
      await PaseoFleetActivityStore.shared.update(state: state.contentState)
    }

    AsyncFunction("end") { (state: PaseoFleetStateRecord, dismissAfterSeconds: Double) in
      guard #available(iOS 16.2, *) else { return }
      await PaseoFleetActivityStore.shared.end(
        state: state.contentState,
        dismissAfterSeconds: dismissAfterSeconds
      )
    }
  }
}
