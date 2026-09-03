package sh.paseo.watch.theme

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme

/**
 * Paseo's dark theme tokens, from packages/app/src/styles/theme.ts (the default
 * "paseo" tint). Kept as literals rather than re-derived so the wrist matches the
 * phone exactly; if the phone's tint changes, these change with it.
 */
object PaseoColors {
  val surface0 = Color(0xFF181B1A)
  val surface1 = Color(0xFF1E2120)
  val surface2 = Color(0xFF272A29)
  val surface3 = Color(0xFF434645)

  val foreground = Color(0xFFFAFAFA)
  val foregroundMuted = Color(0xFFA1A5A4)
  val foregroundExtraMuted = Color(0xFF717574)

  val border = Color(0xFF252B2A)

  val accent = Color(0xFF20744A)
  val accentBright = Color(0xFF239956)

  val destructive = Color(0xFFC4564C)
  val warning = Color(0xFFD9A13B)

  /** Needs-attention row treatment — warm, low-chroma, readable at a glance. */
  val attentionSurface = Color(0xFF2A2420)
  val attentionBorder = Color(0xFF4A3C22)
}

private val WearColors =
  Colors(
    primary = PaseoColors.accent,
    primaryVariant = PaseoColors.accentBright,
    secondary = PaseoColors.surface2,
    secondaryVariant = PaseoColors.surface3,
    background = PaseoColors.surface0,
    surface = PaseoColors.surface2,
    error = PaseoColors.destructive,
    onPrimary = Color.White,
    onSecondary = PaseoColors.foreground,
    onBackground = PaseoColors.foreground,
    onSurface = PaseoColors.foreground,
    onSurfaceVariant = PaseoColors.foregroundMuted,
    onError = Color.White,
  )

@Composable
fun PaseoWatchTheme(content: @Composable () -> Unit) {
  MaterialTheme(colors = WearColors, content = content)
}

/**
 * Project icon palette and hash, ported verbatim from
 * packages/app/src/utils/project-icon-color.ts so a project is the same color on
 * the wrist as on the phone. Do not "improve" either copy independently.
 */
private val PROJECT_ICON_COLORS =
  listOf(
    Color(0xFF8B5CF6), // violet
    Color(0xFF0EA5E9), // sky
    Color(0xFF10B981), // emerald
    Color(0xFFF97316), // orange
    Color(0xFFEC4899), // pink
    Color(0xFF6366F1), // indigo
    Color(0xFF14B8A6), // teal
    Color(0xFFEF4444), // red
    Color(0xFFEAB308), // amber
    Color(0xFF3B82F6), // blue
  )

fun deriveProjectIconColor(projectKey: String): Color {
  // JS: hash = (hash * 31 + charCode) >>> 0 — unsigned 32-bit wraparound.
  var hash = 0L
  for (character in projectKey) {
    hash = (hash * 31 + character.code.toLong()) and 0xFFFFFFFFL
  }
  return PROJECT_ICON_COLORS[(hash % PROJECT_ICON_COLORS.size).toInt()]
}

/** First alphanumeric character of the display name, uppercased. */
fun projectIconLabel(displayName: String): String =
  displayName.firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "?"
