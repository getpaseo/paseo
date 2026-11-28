#pragma once

#import "ENRMUIKit.h"

@class ENRMRenderedSegment;

NS_ASSUME_NONNULL_BEGIN

@interface ENRMSegmentReconciliationResult : NSObject
@property (nonatomic, strong) NSMutableArray<RCTUIView *> *views;
@property (nonatomic, strong) NSMutableArray<NSNumber *> *signatures;
@end

@interface ENRMSegmentReconciler : NSObject
// Reconciles segment views using a two-pass strategy:
// 1. Try positional match: if the view at the same index matches kind, reuse it.
// 2. Fall back to signature-based lookup: find an unused view with the same
//    kind+signature elsewhere in the old list. This handles mid-stream segment
//    insertions where a completed table/math block shifts position.
+ (ENRMSegmentReconciliationResult *)
    reconcileCurrentViews:(NSArray<RCTUIView *> *)currentViews
        currentSignatures:(NSArray<NSNumber *> *)currentSignatures
         renderedSegments:(NSArray<ENRMRenderedSegment *> *)renderedSegments
                    reset:(BOOL)reset
               createView:(RCTUIView * (^)(ENRMRenderedSegment *segment))createView
               updateView:(void (^)(RCTUIView *view, ENRMRenderedSegment *segment))updateView
               attachView:(void (^)(RCTUIView *view))attachView
               removeView:(void (^)(RCTUIView *view))removeView
              matchesKind:(BOOL (^)(RCTUIView *view, ENRMRenderedSegment *segment))matchesKind;
@end

NS_ASSUME_NONNULL_END
