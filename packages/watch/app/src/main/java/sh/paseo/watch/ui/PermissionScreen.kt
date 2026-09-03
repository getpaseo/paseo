package sh.paseo.watch.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import sh.paseo.watch.model.AgentSession
import sh.paseo.watch.model.PermissionRequest
import sh.paseo.watch.model.Workspace
import sh.paseo.watch.theme.PaseoColors

/**
 * The screen that justifies the whole app: an agent is blocked and one tap
 * unblocks it.
 *
 * Allow and Deny are equal-sized targets — this is a real decision, so neither is
 * the "default". Allow carries the accent because it's the affirmative action, not
 * because it's recommended. The command is always shown in full-width monospace;
 * approving something you can't read is the failure mode to avoid.
 */
@Composable
fun PermissionScreen(
  workspace: Workspace,
  agent: AgentSession,
  request: PermissionRequest,
  onRespond: (Boolean) -> Unit,
  /** This workspace's project icon, if the phone published one. */
  icon: ByteArray? = null,
) {
  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .verticalScroll(rememberScrollState())
        // A 450px round screen is ~225dp tall. Glyph + title + agent + command +
        // two labelled 52dp buttons only fits if the outer padding stays tight;
        // top clears Scaffold's TimeText, bottom keeps the labels off the bezel.
        .padding(start = 16.dp, end = 16.dp, top = 24.dp, bottom = 6.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    WarningGlyph(tint = PaseoColors.warning, size = 22)
    Spacer(Modifier.height(5.dp))
    Text(
      text = request.title,
      color = PaseoColors.foreground,
      fontSize = 13.sp,
      fontWeight = FontWeight.Medium,
      textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(3.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
      ProjectIcon(
        projectKey = workspace.projectKey,
        projectName = workspace.projectName,
        size = 16,
        ringColor = PaseoColors.surface0,
        icon = icon,
      )
      Spacer(Modifier.width(4.dp))
      Text(
        text = "${workspace.name} · ${agent.provider}",
        color = PaseoColors.foregroundExtraMuted,
        fontSize = 10.5.sp,
        maxLines = 1,
      )
    }

    Spacer(Modifier.height(8.dp))
    CommandBlock(text = request.detail, modifier = Modifier.fillMaxWidth())

    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      ActionButton(
        label = "Allow",
        primary = true,
        onClick = { onRespond(true) },
        content = { CheckGlyph(tint = androidx.compose.ui.graphics.Color.White) },
      )
      ActionButton(
        label = "Deny",
        primary = false,
        onClick = { onRespond(false) },
        content = { CrossGlyph(tint = PaseoColors.destructive) },
      )
    }
  }
}
