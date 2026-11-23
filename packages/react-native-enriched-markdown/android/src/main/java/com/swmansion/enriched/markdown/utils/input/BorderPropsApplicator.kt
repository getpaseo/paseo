package com.swmansion.enriched.markdown.utils.input

import android.view.View
import com.facebook.react.uimanager.BackgroundStyleApplicator
import com.facebook.react.uimanager.LengthPercentage
import com.facebook.react.uimanager.LengthPercentageType
import com.facebook.react.uimanager.ReactStylesDiffMap
import com.facebook.react.uimanager.ViewProps
import com.facebook.react.uimanager.style.BorderRadiusProp
import com.facebook.react.uimanager.style.BorderStyle
import com.facebook.react.uimanager.style.LogicalEdge

object BorderPropsApplicator {
  private val RADIUS_PROPS =
    mapOf(
      ViewProps.BORDER_RADIUS to BorderRadiusProp.BORDER_RADIUS,
      ViewProps.BORDER_TOP_LEFT_RADIUS to BorderRadiusProp.BORDER_TOP_LEFT_RADIUS,
      ViewProps.BORDER_TOP_RIGHT_RADIUS to BorderRadiusProp.BORDER_TOP_RIGHT_RADIUS,
      ViewProps.BORDER_BOTTOM_RIGHT_RADIUS to BorderRadiusProp.BORDER_BOTTOM_RIGHT_RADIUS,
      ViewProps.BORDER_BOTTOM_LEFT_RADIUS to BorderRadiusProp.BORDER_BOTTOM_LEFT_RADIUS,
    )

  private val WIDTH_PROPS =
    mapOf(
      ViewProps.BORDER_WIDTH to LogicalEdge.ALL,
      ViewProps.BORDER_LEFT_WIDTH to LogicalEdge.LEFT,
      ViewProps.BORDER_RIGHT_WIDTH to LogicalEdge.RIGHT,
      ViewProps.BORDER_TOP_WIDTH to LogicalEdge.TOP,
      ViewProps.BORDER_BOTTOM_WIDTH to LogicalEdge.BOTTOM,
    )

  private val COLOR_PROPS =
    mapOf(
      "borderColor" to LogicalEdge.ALL,
      "borderLeftColor" to LogicalEdge.LEFT,
      "borderRightColor" to LogicalEdge.RIGHT,
      "borderTopColor" to LogicalEdge.TOP,
      "borderBottomColor" to LogicalEdge.BOTTOM,
    )

  fun apply(
    view: View,
    props: ReactStylesDiffMap,
  ) {
    for ((propName, radiusProp) in RADIUS_PROPS) {
      if (props.hasKey(propName)) {
        val value = props.getFloat(propName, Float.NaN)
        val radius = if (value.isNaN()) null else LengthPercentage(value, LengthPercentageType.POINT)
        BackgroundStyleApplicator.setBorderRadius(view, radiusProp, radius)
      }
    }

    for ((propName, edge) in WIDTH_PROPS) {
      if (props.hasKey(propName)) {
        val value = props.getFloat(propName, Float.NaN)
        BackgroundStyleApplicator.setBorderWidth(view, edge, value)
      }
    }

    for ((propName, edge) in COLOR_PROPS) {
      if (props.hasKey(propName)) {
        if (props.isNull(propName)) {
          BackgroundStyleApplicator.setBorderColor(view, edge, null)
        } else {
          val color = props.getInt(propName, 0)
          BackgroundStyleApplicator.setBorderColor(view, edge, color)
        }
      }
    }

    if (props.hasKey("borderStyle")) {
      val styleStr = props.getString("borderStyle")
      val parsed = styleStr?.let { BorderStyle.fromString(it) }
      BackgroundStyleApplicator.setBorderStyle(view, parsed)
    }
  }
}
