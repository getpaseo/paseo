#pragma once

#import "ENRMUIKit.h"
#import <React/RCTConversions.h>

/// Applies a codegen `selectionColor` to `textView`, falling back to the
/// system tint when the color is unset. Obj-C++ only — `.mm` consumers only.
static inline void ENRMApplySelectionColor(ENRMPlatformTextView *textView, const facebook::react::SharedColor &color) {
  if (isColorMeaningful(color)) {
    ENRMSetSelectionColor(textView, RCTUIColorFromSharedColor(color));
  } else {
    ENRMSetSelectionColor(textView, nil);
  }
}
