package sh.paseo.watch.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import sh.paseo.watch.theme.PaseoColors

/**
 * Shown when there is nothing to list.
 *
 * Two genuinely different situations, and they must not share copy. "No snapshot
 * has ever arrived" is a setup problem the user can act on; "the phone is linked
 * and reported no workspaces" is not. Collapsing them — which this screen
 * originally did — told people to open an app that was already open and running
 * fine, and made a real bridge fault indistinguishable from an empty account.
 */
@Composable
fun WaitingScreen(linked: Boolean, message: String?) {
  val body =
    message
      ?: if (linked) {
        "No workspaces on your connected hosts"
      } else {
        "Open Paseo on your phone to connect"
      }

  Column(
    modifier = Modifier.fillMaxSize().padding(horizontal = 22.dp, vertical = 30.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Text(
      text = "Paseo",
      color = PaseoColors.foreground,
      fontSize = 15.sp,
      fontWeight = FontWeight.Medium,
    )
    Spacer(Modifier.height(8.dp))
    Text(
      text = body,
      color = PaseoColors.foregroundMuted,
      fontSize = 12.sp,
      lineHeight = 16.sp,
      textAlign = TextAlign.Center,
    )
    if (!linked) {
      Spacer(Modifier.height(6.dp))
      Text(
        text = "waiting for phone",
        color = PaseoColors.foregroundExtraMuted,
        fontSize = 10.sp,
        textAlign = TextAlign.Center,
      )
    }
  }
}
