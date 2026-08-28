import SwiftUI
import WidgetKit

@main
struct PaseoLiveActivityBundle: WidgetBundle {
  var body: some Widget {
    // The extension ships no home-screen widget; the Live Activity is the only
    // member. Deployment target is 16.2, so no availability fence is needed.
    PaseoFleetLiveActivity()
  }
}
