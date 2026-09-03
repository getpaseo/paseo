package sh.paseo.watch.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
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
import sh.paseo.watch.model.AgentSession
import sh.paseo.watch.model.Workspace
import sh.paseo.watch.theme.PaseoColors

/**
 * Agent picker — reached ONLY when a workspace has 2+ agents and nothing is
 * demanding attention. A single-agent workspace never shows this screen; that is
 * the whole point of [sh.paseo.watch.model.destination].
 *
 * Agent rows lead with the provider, because within one workspace the provider is
 * what distinguishes the sessions.
 */
@Composable
fun AgentPickerScreen(
  workspace: Workspace,
  listState: ScalingLazyListState,
  onAgentClick: (AgentSession) -> Unit,
  onNewAgent: () -> Unit,
  /** This workspace's project icon, if the phone published one. */
  icon: ByteArray? = null,
) {
  ScalingLazyColumn(
    modifier = Modifier.fillMaxWidth(),
    state = listState,
    autoCentering = null,
    contentPadding = PaddingValues(start = 8.dp, top = 30.dp, end = 8.dp, bottom = 34.dp),
  ) {
    item {
      WorkspaceHeader(
        projectKey = workspace.projectKey,
        projectName = workspace.projectName,
        workspaceName = workspace.name,
        modifier = Modifier.padding(bottom = 4.dp),
        icon = icon,
      )
    }
    items(workspace.agents, key = { it.id }) { agent ->
      AgentChip(agent = agent, onClick = { onAgentClick(agent) })
      Spacer(Modifier.height(6.dp))
    }
    item {
      Chip(
        onClick = onNewAgent,
        modifier = Modifier.fillMaxWidth().height(40.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 2.dp),
        colors = ChipDefaults.chipColors(backgroundColor = Color.Transparent),
        border = ChipDefaults.chipBorder(borderStroke = BorderStroke(1.dp, PaseoColors.surface3)),
        label = {
          Text(
            text = "+ New agent",
            color = PaseoColors.foregroundMuted,
            fontSize = 12.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
          )
        },
      )
    }
  }
}

@Composable
private fun AgentChip(agent: AgentSession, onClick: () -> Unit) {
  Chip(
    onClick = onClick,
    modifier = Modifier.fillMaxWidth().height(46.dp),
    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
    colors = ChipDefaults.chipColors(backgroundColor = PaseoColors.surface2),
    icon = {
      Box(
        modifier = Modifier.size(26.dp),
        contentAlignment = Alignment.Center,
      ) {
        Box(
          modifier =
            Modifier
              .size(8.dp)
              .clip(CircleShape)
              .background(agent.state.dotColor()),
        )
      }
    },
    label = {
      Column {
        Text(
          text = agent.provider,
          color = PaseoColors.foreground,
          fontSize = 13.sp,
          maxLines = 1,
        )
        Text(
          text = agentSummary(agent),
          color = PaseoColors.foregroundMuted,
          fontSize = 10.5.sp,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    },
  )
}

private fun agentSummary(agent: AgentSession): String {
  val state =
    when (agent.state) {
      ActivityState.NeedsInput -> "needs approval"
      ActivityState.Running -> "running"
      ActivityState.Idle -> "idle"
    }
  return listOfNotNull(state, agent.age, agent.intent).joinToString(" · ")
}
