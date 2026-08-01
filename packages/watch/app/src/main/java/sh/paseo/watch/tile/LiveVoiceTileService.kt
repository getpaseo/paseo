package sh.paseo.watch.tile

import android.content.Context
import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DeviceParametersBuilders.DeviceParameters
import androidx.wear.protolayout.LayoutElementBuilders.LayoutElement
import androidx.wear.protolayout.ModifiersBuilders.Clickable
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.material.CompactChip
import androidx.wear.protolayout.material.Text
import androidx.wear.protolayout.material.Typography
import androidx.wear.protolayout.material.layouts.PrimaryLayout
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import sh.paseo.watch.LiveVoiceActivity
import sh.paseo.watch.data.readCachedLiveVoiceState
import sh.paseo.watch.model.LiveVoicePhase
import sh.paseo.watch.model.LiveVoiceState
import sh.paseo.watch.model.liveVoiceUnavailableMessage

/**
 * Live Voice on the tile carousel: is a call up, and one tap to do something
 * about it.
 *
 * A tile is not Compose and does not run in the app's process — the system
 * renders this layout in its own carousel, on its own schedule, whether or not
 * the app has ever been opened. So the layout is a ProtoLayout tree, the state
 * comes from the Data Layer's own cache rather than from a repository
 * ([readCachedLiveVoiceState]), and every tap is an intent rather than a
 * callback.
 *
 * The tile deliberately does not offer hang-up or mute. Tile taps are cheap and
 * unconfirmed — a swipe past the carousel with a stray thumb would end a call —
 * and the controls need the state the tile is by nature stale about. Every tap
 * here opens [LiveVoiceActivity], which has the live state and the real controls.
 *
 * Refreshes come from the phone: the Data Layer write that lands new state also
 * wakes this service through [TileService.getUpdater]. There is no polling.
 */
class LiveVoiceTileService : TileService() {
  // Tile requests arrive without a lifecycle to scope work to, so the service
  // owns its scope and cancels it in onDestroy.
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  override fun onDestroy() {
    scope.cancel()
    super.onDestroy()
  }

  override fun onTileRequest(
    requestParams: RequestBuilders.TileRequest,
  ): ListenableFuture<TileBuilders.Tile> =
    CallbackToFutureAdapter.getFuture { completer ->
      scope.launch {
        val state = runCatching { readCachedLiveVoiceState(this@LiveVoiceTileService) }
          // A tile that fails to render is a blank card in the carousel with no
          // way out. Unknown renders the "open the app" shape, which is always
          // useful and never wrong.
          .getOrDefault(LiveVoiceState.Unknown)
        completer.set(
          buildTile(
            this@LiveVoiceTileService,
            state,
            requestParams.deviceConfiguration,
          ),
        )
      }
      "LiveVoiceTileRequest"
    }

  /**
   * No image or font resources — the tile is text and a chip.
   *
   * The version still has to be a stable non-empty string: the system caches
   * resources by it and will not re-request them while it is unchanged.
   */
  override fun onTileResourcesRequest(
    requestParams: RequestBuilders.ResourcesRequest,
  ): ListenableFuture<ResourceBuilders.Resources> =
    CallbackToFutureAdapter.getFuture { completer ->
      completer.set(ResourceBuilders.Resources.Builder().setVersion(RESOURCES_VERSION).build())
      "LiveVoiceTileResources"
    }

  private companion object {
    const val RESOURCES_VERSION = "1"
  }
}

private fun buildTile(
  context: Context,
  state: LiveVoiceState,
  device: DeviceParameters,
): TileBuilders.Tile =
  TileBuilders.Tile.Builder()
    .setResourcesVersion("1")
    // Freshness is push-driven: the phone's Data Layer write wakes this service
    // through the updater, so a polling interval would only cost battery to
    // re-render state that has not moved.
    .setFreshnessIntervalMillis(0)
    .setTileTimeline(
      TimelineBuilders.Timeline.fromLayoutElement(buildLayout(context, state, device)),
    )
    .build()

private fun buildLayout(
  context: Context,
  state: LiveVoiceState,
  device: DeviceParameters,
): LayoutElement =
  PrimaryLayout.Builder(device)
    .setResponsiveContentInsetEnabled(true)
    .setPrimaryLabelTextContent(
      Text.Builder(context, "Live Voice")
        .setTypography(Typography.TYPOGRAPHY_CAPTION1)
        .setColor(argb(COLOR_FOREGROUND_MUTED))
        .build(),
    )
    .setContent(
      Text.Builder(context, statusLine(state))
        .setTypography(Typography.TYPOGRAPHY_BODY1)
        .setColor(argb(statusColor(state)))
        // A watch face's tile carousel is glanceable, not readable: three lines
        // is the honest budget before the text is just texture.
        .setMaxLines(3)
        .build(),
    )
    .setPrimaryChipContent(
      CompactChip.Builder(context, chipLabel(state), openAppAction(context), device).build(),
    )
    .build()

/**
 * The one line the tile exists to show.
 *
 * A live call says which host, because "on call" alone leaves the only question
 * worth asking at a glance unanswered.
 */
private fun statusLine(state: LiveVoiceState): String =
  when (state.phase) {
    LiveVoicePhase.Starting -> "Connecting…"
    LiveVoicePhase.Active -> {
      val muted = if (state.isMuted) "Muted" else "On call"
      state.hostLabel?.let { "$muted · $it" } ?: muted
    }
    LiveVoicePhase.Stopping -> "Hanging up…"
    LiveVoicePhase.Error -> "Call ended"
    LiveVoicePhase.Idle ->
      if (state.hosts.isEmpty()) {
        liveVoiceUnavailableMessage(state.unavailableReason)
      } else {
        "Not on a call"
      }
  }

private fun statusColor(state: LiveVoiceState): Int =
  when (state.phase) {
    LiveVoicePhase.Starting -> COLOR_WARNING
    LiveVoicePhase.Active -> COLOR_ACCENT_BRIGHT
    LiveVoicePhase.Error -> COLOR_DESTRUCTIVE
    LiveVoicePhase.Stopping, LiveVoicePhase.Idle -> COLOR_FOREGROUND
  }

/**
 * The chip says what the tap will do, not what the state is — the line above
 * already covers the state, and a chip that repeats it wastes the only
 * interactive element on the tile.
 */
private fun chipLabel(state: LiveVoiceState): String =
  when {
    state.isLive -> "Open call"
    state.hosts.isEmpty() -> "Open"
    else -> "Start a call"
  }

/**
 * Every tap opens the app.
 *
 * Even "Start a call" only opens [LiveVoiceActivity] rather than placing one: a
 * tile cannot send a Data Layer message, and starting a call from a surface that
 * cannot then show you the call — or let you end it — would be the wrong trade
 * even if it could.
 */
private fun openAppAction(context: Context): Clickable =
  Clickable.Builder()
    .setId("open-live-voice")
    .setOnClick(
      ActionBuilders.LaunchAction.Builder()
        .setAndroidActivity(
          ActionBuilders.AndroidActivity.Builder()
            .setPackageName(context.packageName)
            .setClassName(LiveVoiceActivity::class.java.name)
            .build(),
        )
        .build(),
    )
    .build()

// Paseo's dark tokens, duplicated from theme/Theme.kt because a tile renders
// outside Compose and cannot read a MaterialTheme. Keep the two in step.
private const val COLOR_FOREGROUND = 0xFFFAFAFA.toInt()
private const val COLOR_FOREGROUND_MUTED = 0xFFA1A5A4.toInt()
private const val COLOR_ACCENT_BRIGHT = 0xFF239956.toInt()
private const val COLOR_WARNING = 0xFFD9A13B.toInt()
private const val COLOR_DESTRUCTIVE = 0xFFC4564C.toInt()
