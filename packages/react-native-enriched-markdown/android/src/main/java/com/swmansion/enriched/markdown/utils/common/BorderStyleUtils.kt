package com.swmansion.enriched.markdown.utils.common

import android.view.View
import com.facebook.react.bridge.ColorPropConverter
import com.facebook.react.uimanager.BackgroundStyleApplicator
import com.facebook.react.uimanager.LengthPercentage
import com.facebook.react.uimanager.ReactStylesDiffMap
import com.facebook.react.uimanager.style.BorderRadiusProp
import com.facebook.react.uimanager.style.BorderStyle
import com.facebook.react.uimanager.style.LogicalEdge

// BaseViewManagerDelegate (used by our SimpleViewManagers) ignores border
// width/color/style and no-ops borderRadius, so `containerStyle` borders vanish on
// Android. Replay them via BackgroundStyleApplicator like ReactViewManager does.
// Call after super.updateProperties so the composite background drawable exists.
fun applyReactBorderProps(
  view: View,
  props: ReactStylesDiffMap,
) {
  for ((name, edge) in BORDER_WIDTH_EDGES) {
    if (!props.hasKey(name)) continue
    val width = if (props.isNull(name)) null else props.getFloat(name, Float.NaN).takeUnless { it.isNaN() }
    BackgroundStyleApplicator.setBorderWidth(view, edge, width)
  }

  if (BORDER_COLOR_EDGES.keys.any { props.hasKey(it) }) {
    val rawProps = props.toMap()
    for ((name, edge) in BORDER_COLOR_EDGES) {
      if (!props.hasKey(name)) continue
      val color = if (props.isNull(name)) null else ColorPropConverter.getColor(rawProps[name], view.context)
      BackgroundStyleApplicator.setBorderColor(view, edge, color)
    }
  }

  if (props.hasKey("borderStyle")) {
    val style = if (props.isNull("borderStyle")) null else BorderStyle.fromString(props.getString("borderStyle") ?: "")
    BackgroundStyleApplicator.setBorderStyle(view, style)
  }

  // Radius last, so the border drawable created above already exists and picks
  // up the rounded corners.
  for ((name, corner) in BORDER_RADIUS_PROPS) {
    if (!props.hasKey(name)) continue
    val radius = if (props.isNull(name)) null else LengthPercentage.setFromDynamic(props.getDynamic(name))
    BackgroundStyleApplicator.setBorderRadius(view, corner, radius)
  }
}

private val BORDER_WIDTH_EDGES =
  linkedMapOf(
    "borderWidth" to LogicalEdge.ALL,
    "borderLeftWidth" to LogicalEdge.LEFT,
    "borderRightWidth" to LogicalEdge.RIGHT,
    "borderTopWidth" to LogicalEdge.TOP,
    "borderBottomWidth" to LogicalEdge.BOTTOM,
    "borderStartWidth" to LogicalEdge.START,
    "borderEndWidth" to LogicalEdge.END,
  )

private val BORDER_COLOR_EDGES =
  linkedMapOf(
    "borderColor" to LogicalEdge.ALL,
    "borderLeftColor" to LogicalEdge.LEFT,
    "borderRightColor" to LogicalEdge.RIGHT,
    "borderTopColor" to LogicalEdge.TOP,
    "borderBottomColor" to LogicalEdge.BOTTOM,
    "borderStartColor" to LogicalEdge.START,
    "borderEndColor" to LogicalEdge.END,
  )

private val BORDER_RADIUS_PROPS =
  linkedMapOf(
    "borderRadius" to BorderRadiusProp.BORDER_RADIUS,
    "borderTopLeftRadius" to BorderRadiusProp.BORDER_TOP_LEFT_RADIUS,
    "borderTopRightRadius" to BorderRadiusProp.BORDER_TOP_RIGHT_RADIUS,
    "borderBottomRightRadius" to BorderRadiusProp.BORDER_BOTTOM_RIGHT_RADIUS,
    "borderBottomLeftRadius" to BorderRadiusProp.BORDER_BOTTOM_LEFT_RADIUS,
    "borderTopStartRadius" to BorderRadiusProp.BORDER_TOP_START_RADIUS,
    "borderTopEndRadius" to BorderRadiusProp.BORDER_TOP_END_RADIUS,
    "borderBottomStartRadius" to BorderRadiusProp.BORDER_BOTTOM_START_RADIUS,
    "borderBottomEndRadius" to BorderRadiusProp.BORDER_BOTTOM_END_RADIUS,
    "borderEndEndRadius" to BorderRadiusProp.BORDER_END_END_RADIUS,
    "borderEndStartRadius" to BorderRadiusProp.BORDER_END_START_RADIUS,
    "borderStartEndRadius" to BorderRadiusProp.BORDER_START_END_RADIUS,
    "borderStartStartRadius" to BorderRadiusProp.BORDER_START_START_RADIUS,
  )
