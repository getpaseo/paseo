package com.swmansion.enriched.markdown.utils.common.layout

import android.content.res.Resources
import android.view.View

fun Resources.isLayoutRTL(): Boolean = configuration.layoutDirection == View.LAYOUT_DIRECTION_RTL
