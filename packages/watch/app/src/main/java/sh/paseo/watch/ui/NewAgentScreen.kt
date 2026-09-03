package sh.paseo.watch.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Text
import sh.paseo.watch.theme.PaseoColors

/**
 * The first prompt for a brand-new agent.
 *
 * This is the one composer that still gets a screen of its own. Replying to an
 * existing agent launches speech recognition straight off the agent screen's Reply
 * button — there is a conversation there to anchor the buttons to, and an
 * intermediate screen was one tap of pure overhead. A new agent has no conversation,
 * so the choice of input method has to live somewhere, and this is it.
 *
 * Mic and keyboard only. There were canned replies here once; "Yes, continue" was
 * never a sensible thing to open an agent with.
 */
@Composable
fun NewAgentScreen(
  workspaceName: String,
  projectKey: String,
  projectName: String,
  listState: ScalingLazyListState,
  onSubmit: (String) -> Unit,
  /** This workspace's project icon, if the phone published one. */
  icon: ByteArray? = null,
) {
  val composer = rememberComposerLaunchers(prompt = "New agent in $workspaceName", onText = onSubmit)

  ScalingLazyColumn(
    modifier = Modifier.fillMaxWidth(),
    state = listState,
    // Top-anchored for the same reason as the workspace list: autoCentering would
    // spend the top third of the screen before the mic button appears.
    autoCentering = null,
    contentPadding = PaddingValues(start = 8.dp, top = 28.dp, end = 8.dp, bottom = 34.dp),
  ) {
    item {
      WorkspaceHeader(
        projectKey = projectKey,
        projectName = projectName,
        workspaceName = workspaceName,
        muted = true,
        icon = icon,
      )
    }
    item {
      Text(
        text = "What should it do?",
        color = PaseoColors.foregroundMuted,
        fontSize = 11.5.sp,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
      )
    }
    item {
      Row(
        modifier = Modifier.padding(vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
      ) {
        Button(
          onClick = composer.launchVoice,
          colors = ButtonDefaults.buttonColors(backgroundColor = PaseoColors.accent),
          modifier = Modifier.size(46.dp),
        ) {
          MicGlyph(tint = Color.White, size = 19)
        }
        Button(
          onClick = composer.launchText,
          colors = ButtonDefaults.buttonColors(backgroundColor = PaseoColors.surface2),
          modifier = Modifier.size(46.dp),
        ) {
          KeyboardGlyph(tint = PaseoColors.foregroundMuted)
        }
      }
    }
  }
}
