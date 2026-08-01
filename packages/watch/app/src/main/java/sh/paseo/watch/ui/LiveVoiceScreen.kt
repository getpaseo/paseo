package sh.paseo.watch.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Text
import sh.paseo.watch.model.LiveVoiceHost
import sh.paseo.watch.model.LiveVoicePhase
import sh.paseo.watch.model.LiveVoiceState
import sh.paseo.watch.model.LiveVoiceTranscriptEntry
import sh.paseo.watch.model.liveVoiceErrorMessage
import sh.paseo.watch.model.liveVoiceUnavailableMessage
import sh.paseo.watch.theme.PaseoColors

/**
 * One row of the Live Voice screen, built as data for the same reason
 * [AgentScreen] does it: the tail index has to be a property of the list rather
 * than arithmetic repeated next to the scroll call.
 */
private sealed interface LiveVoiceRow {
  data object Header : LiveVoiceRow

  data object Status : LiveVoiceRow

  /** Why no call can be placed — shown instead of any control. */
  data object Unavailable : LiveVoiceRow

  /** The last call's failure, kept on screen after it ended. */
  data object Error : LiveVoiceRow

  /** One host to choose from, when there is more than one. */
  data class Host(val host: LiveVoiceHost) : LiveVoiceRow

  data class Turn(val entry: LiveVoiceTranscriptEntry) : LiveVoiceRow

  /** Start, or hang-up plus mute — never both sets. */
  data object Actions : LiveVoiceRow
}

/**
 * Live Voice from the wrist: start a call, hang it up, mute it, and read it.
 *
 * No audio passes through this screen. The phone holds the WebRTC peer and routes
 * the call to whichever communication device it prefers — often this watch — so
 * the controls here are a remote for a call happening elsewhere. That is why the
 * primary action is a phone-call verb rather than a mic: pressing it places a
 * call, it does not open a microphone. See the package README.
 *
 * The screen has exactly two shapes and never mixes them. Idle: a start control,
 * and a host list only when the choice is real. Live: hang up as the primary,
 * mute as the satellite, and the transcript filling everything above. That split
 * is what keeps a 450px circle legible — a screen carrying both a start button
 * and a hang-up button has already lost.
 */
@Composable
fun LiveVoiceScreen(
  state: LiveVoiceState,
  onStart: (String) -> Unit,
  onStop: () -> Unit,
  onToggleMute: () -> Unit,
  listState: ScalingLazyListState = rememberScalingLazyListState(),
) {
  val soleHost = state.soleHost
  val rows =
    buildList {
      add(LiveVoiceRow.Header)
      add(LiveVoiceRow.Status)
      if (state.isLive) {
        state.transcripts.forEach { add(LiveVoiceRow.Turn(it)) }
      } else {
        if (state.errorCode != null) add(LiveVoiceRow.Error)
        if (state.hosts.isEmpty()) {
          add(LiveVoiceRow.Unavailable)
        } else if (soleHost == null) {
          // More than one callable host: the chips *are* the start control, so
          // there is no separate start button to press afterwards.
          state.hosts.forEach { add(LiveVoiceRow.Host(it)) }
        }
      }
      // A multi-host idle screen has already offered its action as chips.
      if (state.isLive || soleHost != null) add(LiveVoiceRow.Actions)
    }

  ScalingLazyColumn(
    modifier = Modifier.fillMaxWidth(),
    state = listState,
    // Same as every other list here: autoCentering would spend the top third of a
    // 450px screen before the header renders.
    autoCentering = null,
    // Round-screen geometry, not taste — see the note in AgentScreen.
    contentPadding = PaddingValues(start = 22.dp, top = 28.dp, end = 22.dp, bottom = 14.dp),
  ) {
    items(rows.size) { index ->
      when (val row = rows[index]) {
        LiveVoiceRow.Header -> LiveVoiceHeader()

        LiveVoiceRow.Status -> LiveVoiceStatus(state)

        LiveVoiceRow.Unavailable -> UnavailableCard(state.unavailableReason)

        LiveVoiceRow.Error -> ErrorCard(state.errorCode, state.errorMessage)

        is LiveVoiceRow.Host -> {
          HostChip(host = row.host, onClick = { onStart(row.host.serverId) })
          Spacer(Modifier.height(6.dp))
        }

        is LiveVoiceRow.Turn -> {
          LiveVoiceTurn(row.entry)
          Spacer(Modifier.height(6.dp))
        }

        LiveVoiceRow.Actions ->
          LiveVoiceActions(
            state = state,
            soleHost = soleHost,
            onStart = onStart,
            onStop = onStop,
            onToggleMute = onToggleMute,
          )
      }
    }
  }

  // Follow the newest phrase the way the agent screen follows the newest turn,
  // and for the same reason: a call pushes updates continuously, so following
  // unconditionally would yank a reader out of the backlog every second.
  var followTail by remember(state.serverId) { mutableStateOf(true) }
  LaunchedEffect(listState) {
    snapshotFlow { listState.isScrollInProgress to listState.canScrollForward }
      .collect { (scrolling, canScrollForward) ->
        if (scrolling) followTail = !canScrollForward
      }
  }
  LaunchedEffect(rows.size, state.phase) {
    if (followTail) listState.scrollToItem(rows.lastIndex)
  }
}

@Composable
private fun LiveVoiceHeader() {
  Text(
    text = "Live Voice",
    color = PaseoColors.foreground,
    fontSize = 14.sp,
    fontWeight = FontWeight.Medium,
    textAlign = TextAlign.Center,
    modifier = Modifier.fillMaxWidth(),
  )
}

/**
 * The one line that says what is happening, with a dot in the matching colour.
 *
 * A live call says which host it is on, because that is the fact you cannot
 * recover from anywhere else on this screen.
 */
@Composable
private fun LiveVoiceStatus(state: LiveVoiceState) {
  val (color, label) =
    when (state.phase) {
      LiveVoicePhase.Starting -> PaseoColors.warning to "connecting…"
      LiveVoicePhase.Active ->
        PaseoColors.accentBright to
          (if (state.isMuted) "muted" else "on call") +
          (state.hostLabel?.let { " · $it" } ?: "")
      LiveVoicePhase.Stopping -> PaseoColors.foregroundMuted to "hanging up…"
      LiveVoicePhase.Error -> PaseoColors.destructive to "call ended"
      LiveVoicePhase.Idle ->
        PaseoColors.foregroundExtraMuted to
          if (state.hosts.isEmpty()) "unavailable" else "not on a call"
    }

  Row(
    modifier = Modifier.fillMaxWidth().padding(top = 3.dp, bottom = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.Center,
  ) {
    Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(color))
    Spacer(Modifier.width(6.dp))
    Text(text = label, color = color, fontSize = 12.sp, maxLines = 1)
  }
}

/** One callable host. On a multi-host phone these chips are the start control. */
@Composable
private fun HostChip(host: LiveVoiceHost, onClick: () -> Unit) {
  Chip(
    onClick = onClick,
    colors = ChipDefaults.chipColors(backgroundColor = PaseoColors.surface2),
    modifier = Modifier.fillMaxWidth(),
    label = {
      Text(
        text = host.label,
        color = PaseoColors.foreground,
        fontSize = 12.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    },
    icon = { MicGlyph(tint = PaseoColors.accentBright, size = 18) },
  )
}

@Composable
private fun UnavailableCard(reason: String?) {
  Box(
    modifier =
      Modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(16.dp))
        .background(PaseoColors.surface1)
        .border(1.dp, PaseoColors.border, RoundedCornerShape(16.dp))
        .padding(horizontal = 13.dp, vertical = 10.dp),
  ) {
    Text(
      text = liveVoiceUnavailableMessage(reason),
      color = PaseoColors.foregroundMuted,
      fontSize = 11.5.sp,
      lineHeight = 16.sp,
      textAlign = TextAlign.Center,
      modifier = Modifier.fillMaxWidth(),
    )
  }
}

@Composable
private fun ErrorCard(code: String?, message: String?) {
  Box(
    modifier =
      Modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(12.dp))
        .background(PaseoColors.surface1)
        .border(1.dp, PaseoColors.destructive.copy(alpha = 0.45f), RoundedCornerShape(12.dp))
        .padding(horizontal = 10.dp, vertical = 8.dp),
  ) {
    Text(
      text = liveVoiceErrorMessage(code, message),
      color = PaseoColors.destructive,
      fontSize = 11.sp,
      lineHeight = 15.sp,
      textAlign = TextAlign.Center,
      modifier = Modifier.fillMaxWidth(),
    )
  }
}

/**
 * One phrase of the call.
 *
 * Same weight split as the agent transcript: what the agent says is bare and
 * bright because it is the thing being read; your own words sit inset in a filled
 * bubble because they are context, not news.
 */
@Composable
private fun LiveVoiceTurn(entry: LiveVoiceTranscriptEntry) {
  if (entry.fromUser) {
    Box(
      modifier =
        Modifier
          .fillMaxWidth()
          .padding(start = 12.dp)
          .clip(RoundedCornerShape(14.dp))
          .background(PaseoColors.surface2)
          .padding(horizontal = 10.dp, vertical = 7.dp),
    ) {
      Text(text = entry.text, color = PaseoColors.foreground, fontSize = 11.5.sp, lineHeight = 15.sp)
    }
    return
  }
  Text(
    text = entry.text,
    color = PaseoColors.foreground,
    fontSize = 12.sp,
    lineHeight = 16.sp,
    modifier = Modifier.fillMaxWidth(),
  )
}

/**
 * The controls, in whichever of the two shapes applies.
 *
 * Live: hang up is the 52dp primary and mute is its 38dp satellite, separated on
 * both axes for the same reason Reply and Stop are on the agent screen — ending a
 * call by mis-tap is the expensive mistake here.
 *
 * Idle with exactly one host: a single start button, because a picker with one
 * entry is a tap that asks a question with one answer.
 */
@Composable
private fun LiveVoiceActions(
  state: LiveVoiceState,
  soleHost: LiveVoiceHost?,
  onStart: (String) -> Unit,
  onStop: () -> Unit,
  onToggleMute: () -> Unit,
) {
  Column(
    modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    if (state.isLive) {
      ActionButton(
        label = "Hang up",
        primary = true,
        onClick = onStop,
        // The one destructive-tinted primary in the app: it is the only control
        // that ends something pressing it again won't bring back.
        background = PaseoColors.destructive,
        content = { HangUpGlyph(tint = Color.White) },
      )
      Spacer(Modifier.height(10.dp))
      ActionButton(
        label = if (state.isMuted) "Unmute" else "Mute",
        primary = false,
        onClick = onToggleMute,
        size = 38,
        content = {
          if (state.isMuted) {
            MicOffGlyph(tint = PaseoColors.warning, size = 16)
          } else {
            MicGlyph(tint = PaseoColors.foregroundMuted, size = 16)
          }
        },
      )
      return@Column
    }

    if (soleHost != null) {
      ActionButton(
        label = "Call",
        primary = true,
        onClick = { onStart(soleHost.serverId) },
        content = { MicGlyph(tint = Color.White) },
      )
    }
  }
}
