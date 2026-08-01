package sh.paseo.watch.data

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.tasks.await
import sh.paseo.watch.model.LiveVoiceState

private const val TAG = "PaseoWear"

/**
 * Read the Live Voice state straight out of the Data Layer's cache.
 *
 * For [sh.paseo.watch.tile.LiveVoiceTileService], which has no activity, no
 * lifecycle to hang a listener on, and one shot to answer a tile request. A
 * [DataLayerRepository] would be the wrong shape here: it registers listeners and
 * publishes a flow, and the tile only ever needs the value once.
 *
 * DataClient persists the last item and redelivers it after the link drops, so
 * this reads the same bytes the app would show — no round trip to the phone, and
 * a correct answer even with the phone out of range.
 *
 * Returns [LiveVoiceState.Unknown] for a missing, unreadable, or
 * version-mismatched item. All three mean the same thing to a tile: there is
 * nothing to control, so offer to open the app.
 */
suspend fun readCachedLiveVoiceState(context: Context): LiveVoiceState {
  val items =
    runCatching { Wearable.getDataClient(context).dataItems.await() }
      .onFailure { Log.w(TAG, "Failed to read cached data items for tile", it) }
      .getOrNull() ?: return LiveVoiceState.Unknown

  try {
    for (item in items) {
      if (item.uri.path.orEmpty() != WearBridge.LIVE_VOICE_PATH) continue
      val raw = DataMapItem.fromDataItem(item).dataMap.getString(WearBridge.SNAPSHOT_KEY)
        ?: return LiveVoiceState.Unknown
      return decodeLiveVoice(raw)?.toLiveVoiceState() ?: LiveVoiceState.Unknown
    }
  } finally {
    items.release()
  }
  return LiveVoiceState.Unknown
}
