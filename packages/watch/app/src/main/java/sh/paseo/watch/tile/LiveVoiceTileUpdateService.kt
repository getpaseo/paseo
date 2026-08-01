package sh.paseo.watch.tile

import android.util.Log
import androidx.wear.tiles.TileService
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.WearableListenerService

private const val TAG = "PaseoWear"

/**
 * Wakes the Live Voice tile when the phone publishes new call state.
 *
 * Without this the tile would only be as fresh as the last time the system
 * happened to ask for it, which for a call that starts and ends in ninety seconds
 * means showing the wrong thing for most of it. Polling is the alternative, and
 * it is the wrong one: state changes are already a push, and a freshness interval
 * short enough to catch a call would re-render all day to catch nothing.
 *
 * Play Services starts this service on its own when a matching DataItem lands, so
 * it works with no activity running and the app never launched since boot. That
 * is also why it does no work of its own beyond the update request — it may be
 * running in a process that exists solely to handle this callback.
 *
 * The path filter is in the manifest, not here — a manifest-declared listener
 * declares it in its intent-filter, and Play Services will not start the service
 * at all for paths that don't match. It has to spell out `/paseo/livevoice`
 * literally, since a manifest cannot reference a Kotlin constant — change
 * `WearBridge.LIVE_VOICE_PATH` and change the manifest with it.
 */
class LiveVoiceTileUpdateService : WearableListenerService() {
  override fun onDataChanged(events: DataEventBuffer) {
    try {
      // Deliberately not inspecting the events: the manifest filter already
      // guarantees they are Live Voice, and the tile re-reads the cache anyway.
      // A delete counts too — a signed-out phone should clear the tile.
      if (events.count == 0) return
      TileService.getUpdater(this).requestUpdate(LiveVoiceTileService::class.java)
    } catch (error: Throwable) {
      // This runs on a Play Services callback in a process that may exist only
      // for it; an escaping exception is a crash the user sees with no context.
      Log.w(TAG, "Failed to request live voice tile update", error)
    } finally {
      events.release()
    }
  }
}
