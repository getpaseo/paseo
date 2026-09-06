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

/// Owns one fleet activity per connected daemon.
///
/// Several controllers can be live at once (one per daemon the app is connected
/// to), so every operation is keyed by `serverId` and never touches another
/// server's activity. `PaseoFleetAttributes.serverId` is the durable key: the
/// dictionary is only a cache, and after a relaunch or JS reload the store
/// re-adopts activities by matching their attributes.
///
/// An actor because `AsyncFunction` calls from two controllers can overlap and
/// each one suspends mid-operation (`Activity.end` is async). A plain class
/// would let a second `start` interleave between the end and the request and
/// leave the dictionary pointing at an activity it does not own.
///
/// Isolated in its own `@available` type so the module class itself stays
/// buildable against the app's iOS 15.1 deployment target.
@available(iOS 16.2, *)
internal actor PaseoFleetActivityStore {
  static let shared = PaseoFleetActivityStore()

  private var activities: [String: Activity<PaseoFleetAttributes>] = [:]

  /// Every live activity this app owns for `serverId`. More than one only
  /// happens if a previous launch left one behind.
  private func systemActivities(serverId: String) -> [Activity<PaseoFleetAttributes>] {
    Activity<PaseoFleetAttributes>.activities.filter { $0.attributes.serverId == serverId }
  }

  /// Adopts an activity that outlived the JS handle (app relaunch, JS reload).
  /// Without this, `update` after a reload would silently do nothing while a
  /// stale banner stayed on the lock screen.
  private func liveActivity(serverId: String) -> Activity<PaseoFleetAttributes>? {
    if let cached = activities[serverId], cached.activityState == .active {
      return cached
    }
    let adopted = systemActivities(serverId: serverId).first { $0.activityState == .active }
    activities[serverId] = adopted
    return adopted
  }

  private func endOwn(serverId: String, dismissalPolicy: ActivityUIDismissalPolicy) async {
    activities[serverId] = nil
    for existing in systemActivities(serverId: serverId) {
      await existing.end(nil, dismissalPolicy: dismissalPolicy)
    }
  }

  func start(serverId: String, state: PaseoFleetAttributes.ContentState) async throws {
    // Idempotent per daemon: replaces this server's activity, including a
    // leftover from a previous launch that ActivityKit still considers live.
    // Activities belonging to other daemons are left alone.
    await endOwn(serverId: serverId, dismissalPolicy: .immediate)
    do {
      activities[serverId] = try Activity.request(
        attributes: PaseoFleetAttributes(serverId: serverId),
        content: ActivityContent(state: state, staleDate: nil),
        pushType: nil
      )
    } catch {
      throw LiveActivityRequestFailedException(error.localizedDescription)
    }
  }

  func update(serverId: String, state: PaseoFleetAttributes.ContentState) async {
    guard let activity = liveActivity(serverId: serverId) else { return }
    await activity.update(ActivityContent(state: state, staleDate: nil))
  }

  func end(
    serverId: String,
    state: PaseoFleetAttributes.ContentState,
    dismissAfterSeconds: Double
  ) async {
    guard let activity = liveActivity(serverId: serverId) else { return }
    let policy: ActivityUIDismissalPolicy =
      dismissAfterSeconds > 0
      ? .after(Date().addingTimeInterval(dismissAfterSeconds))
      : .immediate
    await activity.end(
      ActivityContent(state: state, staleDate: nil),
      dismissalPolicy: policy
    )
    activities[serverId] = nil
  }
}

public final class PaseoLiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoLiveActivity")

    Function("isSupported") { () -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      return ActivityAuthorizationInfo().areActivitiesEnabled
    }

    AsyncFunction("start") { (serverId: String, state: PaseoFleetStateRecord) in
      guard #available(iOS 16.2, *) else { throw LiveActivityUnsupportedException() }
      try await PaseoFleetActivityStore.shared.start(
        serverId: serverId,
        state: state.contentState
      )
    }

    AsyncFunction("update") { (serverId: String, state: PaseoFleetStateRecord) in
      guard #available(iOS 16.2, *) else { return }
      await PaseoFleetActivityStore.shared.update(
        serverId: serverId,
        state: state.contentState
      )
    }

    AsyncFunction("end") {
      (serverId: String, state: PaseoFleetStateRecord, dismissAfterSeconds: Double) in
      guard #available(iOS 16.2, *) else { return }
      await PaseoFleetActivityStore.shared.end(
        serverId: serverId,
        state: state.contentState,
        dismissAfterSeconds: dismissAfterSeconds
      )
    }
  }
}
