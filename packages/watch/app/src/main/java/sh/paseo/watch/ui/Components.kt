package sh.paseo.watch.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import sh.paseo.watch.model.ActivityState
import sh.paseo.watch.theme.PaseoColors
import sh.paseo.watch.theme.deriveProjectIconColor
import sh.paseo.watch.theme.projectIconLabel

fun ActivityState.dotColor(): Color =
  when (this) {
    ActivityState.NeedsInput -> PaseoColors.warning
    ActivityState.Running -> PaseoColors.accentBright
    ActivityState.Idle -> PaseoColors.foregroundExtraMuted
  }

/**
 * Project icon: the project's real icon when the phone has published one, otherwise
 * a colored rounded square with the project initial — matching <ProjectIconView> on
 * the phone, which makes the same choice.
 *
 * [icon] is the raw image file straight out of the project repo (see
 * [sh.paseo.watch.data.WatchRepository.icons]). Undecodable bytes fall through to
 * the initial rather than leaving a hole: `BitmapFactory` returns null on anything
 * it can't read, and that null is load-bearing.
 *
 * The status dot rides the icon's bottom-right corner so one glyph carries
 * project, identity, and state — horizontal room is the scarcest thing on a
 * 450px screen. [ringColor] must match whatever surface the icon sits on, since
 * the dot punches a hole in it.
 */
@Composable
fun ProjectIcon(
  projectKey: String,
  projectName: String,
  modifier: Modifier = Modifier,
  size: Int = 26,
  state: ActivityState? = null,
  ringColor: Color = PaseoColors.surface2,
  icon: ByteArray? = null,
) {
  val bitmap = rememberIconBitmap(icon)
  Box(modifier = modifier.size(size.dp)) {
    Box(
      modifier =
        Modifier
          .size(size.dp)
          .clip(RoundedCornerShape((size / 3.2f).dp))
          // A real icon supplies its own field; the derived color would only show
          // through its transparent pixels as a colored halo.
          .background(if (bitmap == null) deriveProjectIconColor(projectKey) else Color.Transparent),
      contentAlignment = Alignment.Center,
    ) {
      if (bitmap == null) {
        Text(
          text = projectIconLabel(projectName),
          color = Color.White,
          fontSize = (size * 0.5f).sp,
          fontWeight = FontWeight.Medium,
        )
      } else {
        Image(
          bitmap = bitmap,
          contentDescription = null,
          modifier = Modifier.size(size.dp),
          // Repo icons are square in practice but not by contract; cropping keeps a
          // stray rectangle from being letterboxed inside the rounded square.
          contentScale = ContentScale.Crop,
        )
      }
    }
    if (state != null) {
      val dot = (size * 0.42f).dp
      Box(
        modifier =
          Modifier
            .align(Alignment.BottomEnd)
            .size(dot)
            .clip(CircleShape)
            .background(ringColor),
        contentAlignment = Alignment.Center,
      ) {
        Box(
          modifier =
            Modifier
              .size(dot - 4.dp)
              .clip(CircleShape)
              .background(state.dotColor()),
        )
      }
    }
  }
}

/**
 * Decode once per distinct payload, not once per frame.
 *
 * Keyed on the array reference, which is exactly right here: the repository only
 * ever hands out a new array when new bytes arrive, so an unchanged icon keeps its
 * decoded bitmap across recomposition and a changed one is guaranteed to re-decode.
 * A failed decode is cached as null just like a successful one, so a corrupt payload
 * costs one attempt rather than one per frame.
 */
@Composable
private fun rememberIconBitmap(bytes: ByteArray?): ImageBitmap? =
  remember(bytes) {
    if (bytes == null || bytes.isEmpty()) {
      null
    } else {
      // Never throws for us in practice, but a decoder fed arbitrary repo bytes is
      // not somewhere to find out — a crash here would take down the workspace list.
      runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
        .getOrNull()
    }
  }

/** Small status dot + label, used as the secondary line on detail screens. */
@Composable
fun StatusLine(state: ActivityState, text: String, modifier: Modifier = Modifier) {
  Row(
    modifier = modifier,
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.Center,
  ) {
    Box(
      modifier =
        Modifier
          .size(7.dp)
          .clip(CircleShape)
          .background(state.dotColor()),
    )
    Spacer(Modifier.width(6.dp))
    Text(
      text = text,
      color = if (state == ActivityState.Idle) PaseoColors.foregroundMuted else state.dotColor(),
      fontSize = 12.sp,
    )
  }
}

/** Workspace context header: project icon + workspace name. */
@Composable
fun WorkspaceHeader(
  projectKey: String,
  projectName: String,
  workspaceName: String,
  modifier: Modifier = Modifier,
  muted: Boolean = false,
  icon: ByteArray? = null,
) {
  Row(
    modifier = modifier,
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.Center,
  ) {
    ProjectIcon(
      projectKey = projectKey,
      projectName = projectName,
      size = 20,
      ringColor = PaseoColors.surface0,
      icon = icon,
    )
    Spacer(Modifier.width(7.dp))
    Text(
      text = workspaceName,
      color = if (muted) PaseoColors.foregroundMuted else PaseoColors.foreground,
      fontSize = 13.sp,
      fontWeight = if (muted) FontWeight.Normal else FontWeight.Medium,
      maxLines = 1,
    )
  }
}

/** Monospace block for the thing being approved. */
@Composable
fun CommandBlock(text: String, modifier: Modifier = Modifier) {
  Box(
    modifier =
      modifier
        .clip(RoundedCornerShape(14.dp))
        .background(Color(0xFF121413))
        .border(1.dp, PaseoColors.border, RoundedCornerShape(14.dp)),
  ) {
    Text(
      text = text,
      color = PaseoColors.foreground,
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
    )
  }
}
