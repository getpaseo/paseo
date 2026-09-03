package sh.paseo.watch.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp

/**
 * Hand-drawn glyphs instead of a vector-asset dependency.
 *
 * These are the only five icons the app needs, they are all simple strokes, and
 * drawing them keeps the APK free of a material-icons dependency — which matters
 * more than usual on a watch.
 */

@Composable
fun MicGlyph(tint: Color, size: Int = 22) {
  Canvas(modifier = Modifier.size(size.dp)) {
    val w = this.size.width
    val h = this.size.height
    val stroke = Stroke(width = w * 0.09f, cap = StrokeCap.Round)

    // Capsule body.
    val capsuleWidth = w * 0.26f
    val capsuleHeight = h * 0.42f
    drawRoundRect(
      color = tint,
      topLeft = Offset((w - capsuleWidth) / 2f, h * 0.12f),
      size = Size(capsuleWidth, capsuleHeight),
      cornerRadius = androidx.compose.ui.geometry.CornerRadius(capsuleWidth / 2f),
      style = stroke,
    )

    // Cradle arc.
    val cradleInset = w * 0.22f
    drawArc(
      color = tint,
      startAngle = 0f,
      sweepAngle = 180f,
      useCenter = false,
      topLeft = Offset(cradleInset, h * 0.35f),
      size = Size(w - cradleInset * 2f, h * 0.42f),
      style = stroke,
    )

    // Stand.
    drawLine(
      color = tint,
      start = Offset(w / 2f, h * 0.78f),
      end = Offset(w / 2f, h * 0.9f),
      strokeWidth = w * 0.09f,
      cap = StrokeCap.Round,
    )
  }
}

@Composable
fun KeyboardGlyph(tint: Color, size: Int = 19) {
  Canvas(modifier = Modifier.size(size.dp)) {
    val w = this.size.width
    val h = this.size.height
    val stroke = Stroke(width = w * 0.1f, cap = StrokeCap.Round)

    drawRoundRect(
      color = tint,
      topLeft = Offset(w * 0.06f, h * 0.24f),
      size = Size(w * 0.88f, h * 0.52f),
      cornerRadius = androidx.compose.ui.geometry.CornerRadius(w * 0.1f),
      style = stroke,
    )
    // Key dots.
    val dotY = h * 0.42f
    for (i in 0..3) {
      drawCircle(
        color = tint,
        radius = w * 0.045f,
        center = Offset(w * (0.24f + i * 0.175f), dotY),
      )
    }
    // Space bar.
    drawLine(
      color = tint,
      start = Offset(w * 0.32f, h * 0.62f),
      end = Offset(w * 0.68f, h * 0.62f),
      strokeWidth = w * 0.09f,
      cap = StrokeCap.Round,
    )
  }
}

@Composable
fun StopGlyph(tint: Color, size: Int = 20) {
  Canvas(modifier = Modifier.size(size.dp)) {
    val w = this.size.width
    drawRoundRect(
      color = tint,
      topLeft = Offset(w * 0.28f, w * 0.28f),
      size = Size(w * 0.44f, w * 0.44f),
      cornerRadius = androidx.compose.ui.geometry.CornerRadius(w * 0.06f),
      style = Stroke(width = w * 0.09f, cap = StrokeCap.Round),
    )
  }
}

@Composable
fun CheckGlyph(tint: Color, size: Int = 24) {
  Canvas(modifier = Modifier.size(size.dp)) {
    val w = this.size.width
    val h = this.size.height
    val path =
      Path().apply {
        moveTo(w * 0.2f, h * 0.52f)
        lineTo(w * 0.42f, h * 0.73f)
        lineTo(w * 0.82f, h * 0.29f)
      }
    drawPath(path = path, color = tint, style = Stroke(width = w * 0.11f, cap = StrokeCap.Round))
  }
}

@Composable
fun CrossGlyph(tint: Color, size: Int = 22) {
  Canvas(modifier = Modifier.size(size.dp)) {
    val w = this.size.width
    val h = this.size.height
    val stroke = w * 0.11f
    drawLine(
      color = tint,
      start = Offset(w * 0.26f, h * 0.26f),
      end = Offset(w * 0.74f, h * 0.74f),
      strokeWidth = stroke,
      cap = StrokeCap.Round,
    )
    drawLine(
      color = tint,
      start = Offset(w * 0.74f, h * 0.26f),
      end = Offset(w * 0.26f, h * 0.74f),
      strokeWidth = stroke,
      cap = StrokeCap.Round,
    )
  }
}

@Composable
fun WarningGlyph(tint: Color, size: Int = 26) {
  Canvas(modifier = Modifier.size(size.dp)) {
    val w = this.size.width
    val h = this.size.height
    val stroke = Stroke(width = w * 0.09f, cap = StrokeCap.Round)
    val path =
      Path().apply {
        moveTo(w * 0.5f, h * 0.14f)
        lineTo(w * 0.93f, h * 0.84f)
        lineTo(w * 0.07f, h * 0.84f)
        close()
      }
    drawPath(path = path, color = tint, style = stroke)
    drawLine(
      color = tint,
      start = Offset(w * 0.5f, h * 0.4f),
      end = Offset(w * 0.5f, h * 0.58f),
      strokeWidth = w * 0.09f,
      cap = StrokeCap.Round,
    )
    drawCircle(color = tint, radius = w * 0.045f, center = Offset(w * 0.5f, h * 0.71f))
  }
}
