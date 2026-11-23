#pragma once
#import "ENRMUIKit.h"
#import <React/RCTUtils.h>
#include <memory>
#import <react/utils/ManagedObjectWrapper.h>

/// Returns YES if the measured content height differs from the frame height
/// Yoga assigned, comparing at physical-pixel granularity to avoid
/// false positives from sub-pixel floating-point differences.
static inline BOOL needsHeightUpdate(CGSize measuredSize, CGRect bounds)
{
  CGFloat scale = RCTScreenScale();
  CGFloat assignedHeight = ceil(bounds.size.height * scale) / scale;
  CGFloat measuredHeight = ceil(measuredSize.height * scale) / scale;
  return assignedHeight != measuredHeight;
}

template <typename StateDataT, typename ConcreteStateT>
inline void ENRMRequestHeightUpdate(std::shared_ptr<const ConcreteStateT> const &state, int &counter, id self)
{
  if (!state)
    return;
  counter++;
  state->updateState(StateDataT(counter, facebook::react::wrapManagedObjectWeakly(self)));
}
