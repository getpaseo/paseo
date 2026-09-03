package sh.paseo.watch

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.lifecycleScope
import sh.paseo.watch.data.DataLayerRepository
import sh.paseo.watch.data.LinkState
import sh.paseo.watch.data.MockWatchRepository
import sh.paseo.watch.data.WatchRepository

class MainActivity : ComponentActivity() {
  private var dataLayer: DataLayerRepository? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setTheme(android.R.style.Theme_DeviceDefault)

    if (USE_MOCK_DATA) {
      val repository: WatchRepository = MockWatchRepository()
      setContent { PaseoWatchApp(repository) }
      return
    }

    val repository = DataLayerRepository(this, lifecycleScope)
    dataLayer = repository
    setContent {
      val error by repository.error.collectAsState()
      val link by repository.linkState.collectAsState()
      PaseoWatchApp(
        repository = repository,
        waitingMessage = error,
        linked = link == LinkState.Linked,
      )
    }
  }

  override fun onStart() {
    super.onStart()
    // Listening only between onStart/onStop keeps the Data Layer callback off the
    // battery budget while the screen is off. DataClient redelivers the latest item
    // when we re-register, so nothing is missed by not listening in the background.
    dataLayer?.start()
  }

  override fun onStop() {
    dataLayer?.stop()
    super.onStop()
  }

  private companion object {
    /**
     * Flip to true to exercise the UI on a bare emulator with no paired phone.
     * See design/README.md; the mock covers every workspace shape the navigation
     * rule has to handle.
     */
    const val USE_MOCK_DATA = false
  }
}
