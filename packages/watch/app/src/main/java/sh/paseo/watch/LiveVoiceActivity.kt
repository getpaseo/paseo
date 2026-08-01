package sh.paseo.watch

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.lifecycleScope
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import kotlinx.coroutines.launch
import sh.paseo.watch.data.DataLayerRepository
import sh.paseo.watch.data.MockWatchRepository
import sh.paseo.watch.data.WatchRepository
import sh.paseo.watch.theme.PaseoWatchTheme
import sh.paseo.watch.ui.LiveVoiceScreen

/**
 * Live Voice as its own launch point, separate from [MainActivity].
 *
 * Deliberately not a destination inside the triage nav graph. Triage is a list
 * you walk down — workspace, agent, approve — and Live Voice is a single action
 * you want to reach without walking anything. Hanging it off the workspace list
 * would put it behind at least one tap on the screen that is already the most
 * crowded thing on the wrist, and it would be unreachable from the tile.
 *
 * Its own activity is also what makes the tile work: [LiveVoiceTileService] taps
 * straight here, and a tile that opened the workspace list and asked the user to
 * navigate would defeat the point of a tile.
 *
 * The two activities share the repository *type* but not an instance. Each owns
 * its own [DataLayerRepository] and registers its own listeners between onStart
 * and onStop, which is what keeps the Data Layer callbacks off the battery budget
 * when neither is on screen. DataClient redelivers the latest item on
 * re-registration, so nothing is lost by not listening in between.
 */
class LiveVoiceActivity : ComponentActivity() {
  private var dataLayer: DataLayerRepository? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setTheme(android.R.style.Theme_DeviceDefault)

    if (USE_MOCK_DATA) {
      val repository: WatchRepository = MockWatchRepository()
      setContent { LiveVoiceRoot(repository) }
      return
    }

    val repository = DataLayerRepository(this, lifecycleScope)
    dataLayer = repository
    setContent { LiveVoiceRoot(repository) }
  }

  override fun onStart() {
    super.onStart()
    dataLayer?.start()
  }

  override fun onStop() {
    dataLayer?.stop()
    super.onStop()
  }

  private companion object {
    /** Same switch as [MainActivity]; see design/README.md. */
    const val USE_MOCK_DATA = false
  }
}

@androidx.compose.runtime.Composable
private fun LiveVoiceRoot(repository: WatchRepository) {
  PaseoWatchTheme {
    val scope = rememberCoroutineScope()
    val state by repository.liveVoice.collectAsState()

    Scaffold(
      timeText = { TimeText() },
      vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
    ) {
      LiveVoiceScreen(
        state = state,
        onStart = { serverId -> scope.launch { repository.startLiveVoice(serverId) } },
        onStop = { scope.launch { repository.stopLiveVoice() } },
        onToggleMute = { scope.launch { repository.toggleLiveVoiceMute() } },
      )
    }
  }
}
