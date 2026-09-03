package sh.paseo.watch.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Text
import sh.paseo.watch.model.ActivityState
import sh.paseo.watch.model.Workspace
import sh.paseo.watch.model.sortedForWrist
import sh.paseo.watch.model.summaryLine
import sh.paseo.watch.theme.PaseoColors

/**
 * Root screen. Workspaces are the browsing unit — the project icon carries the
 * project, and the status dot on the icon aggregates the workspace.
 *
 * Tapping does NOT always land on a picker; see [sh.paseo.watch.model.destination].
 */
@Composable
fun WorkspaceListScreen(
  workspaces: List<Workspace>,
  listState: ScalingLazyListState,
  onWorkspaceClick: (Workspace) -> Unit,
  /** Raw icon bytes by projectKey; a missing key means the colored initial. */
  icons: Map<String, ByteArray> = emptyMap(),
) {
  ScalingLazyColumn(
    modifier = Modifier.fillMaxWidth(),
    state = listState,
    // autoCentering centers the first item, which on a 450px screen costs the top
    // third of the display before a single row is drawn. This list is read from the
    // top — needs-attention first — so it anchors to the top instead.
    autoCentering = null,
    contentPadding = PaddingValues(start = 8.dp, top = 30.dp, end = 8.dp, bottom = 34.dp),
  ) {
    item {
      Text(
        text = "Workspaces",
        color = PaseoColors.foreground,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        modifier = Modifier.padding(bottom = 2.dp),
      )
    }
    items(workspaces.sortedForWrist(), key = { it.id }) { workspace ->
      WorkspaceChip(
        workspace = workspace,
        icon = icons[workspace.projectKey],
        onClick = { onWorkspaceClick(workspace) },
      )
      Spacer(Modifier.height(4.dp))
    }
  }
}

@Composable
private fun WorkspaceChip(workspace: Workspace, icon: ByteArray?, onClick: () -> Unit) {
  val needsAttention = workspace.state == ActivityState.NeedsInput
  val background = if (needsAttention) PaseoColors.attentionSurface else PaseoColors.surface2

  Chip(
    onClick = onClick,
    // Wear's default chip height (52dp) only fits two rows on a 450px screen.
    // 46dp keeps the tap target well above the 40dp minimum while showing enough
    // of the next row to make it obvious the list scrolls.
    modifier = Modifier.fillMaxWidth().height(46.dp),
    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
    colors = ChipDefaults.chipColors(backgroundColor = background),
    border =
      if (needsAttention) {
        ChipDefaults.chipBorder(borderStroke = androidx.compose.foundation.BorderStroke(1.dp, PaseoColors.attentionBorder))
      } else {
        ChipDefaults.chipBorder()
      },
    icon = {
      ProjectIcon(
        projectKey = workspace.projectKey,
        projectName = workspace.projectName,
        size = 26,
        state = workspace.state,
        ringColor = background,
        icon = icon,
      )
    },
    label = {
      Column {
        Text(
          text = workspace.name,
          color = PaseoColors.foreground,
          fontSize = 13.sp,
          lineHeight = 15.sp,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text = workspace.summaryLine(),
          color = PaseoColors.foregroundMuted,
          fontSize = 10.5.sp,
          lineHeight = 13.sp,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    },
  )
}
