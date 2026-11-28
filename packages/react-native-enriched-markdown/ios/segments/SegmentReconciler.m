#import "SegmentReconciler.h"
#import "RenderedMarkdownSegment.h"

@implementation ENRMSegmentReconciliationResult
@end

@implementation ENRMSegmentReconciler
+ (ENRMSegmentReconciliationResult *)
    reconcileCurrentViews:(NSArray<RCTUIView *> *)currentViews
        currentSignatures:(NSArray<NSNumber *> *)currentSignatures
         renderedSegments:(NSArray<ENRMRenderedSegment *> *)renderedSegments
                    reset:(BOOL)reset
               createView:(RCTUIView * (^)(ENRMRenderedSegment *segment))createView
               updateView:(void (^)(RCTUIView *view, ENRMRenderedSegment *segment))updateView
               attachView:(void (^)(RCTUIView *view))attachView
               removeView:(void (^)(RCTUIView *view))removeView
              matchesKind:(BOOL (^)(RCTUIView *view, ENRMRenderedSegment *segment))matchesKind
{
  NSArray<RCTUIView *> *sourceViews = currentViews;
  NSArray<NSNumber *> *sourceSignatures = currentSignatures;

  if (reset) {
    [currentViews enumerateObjectsUsingBlock:^(RCTUIView *view, NSUInteger index, BOOL *stop) { removeView(view); }];
    sourceViews = @[];
    sourceSignatures = @[];
  }

  // Build a signature -> (view, index) lookup for fallback reuse when
  // positional matching fails (e.g. a new segment inserted before an
  // existing table shifts it to a different index).
  NSMutableDictionary<NSNumber *, NSMutableArray<NSNumber *> *> *signatureToIndices =
      [NSMutableDictionary dictionaryWithCapacity:sourceSignatures.count];
  [sourceSignatures enumerateObjectsUsingBlock:^(NSNumber *sig, NSUInteger idx, BOOL *stop) {
    NSMutableArray<NSNumber *> *indices = signatureToIndices[sig];
    if (!indices) {
      indices = [NSMutableArray arrayWithObject:@(idx)];
      signatureToIndices[sig] = indices;
    } else {
      [indices addObject:@(idx)];
    }
  }];

  NSMutableDictionary<NSNumber *, NSNumber *> *remainingNextSignatureCounts =
      [NSMutableDictionary dictionaryWithCapacity:renderedSegments.count];
  for (ENRMRenderedSegment *segment in renderedSegments) {
    NSNumber *signature = @(segment.signature);
    NSUInteger count = remainingNextSignatureCounts[signature].unsignedIntegerValue;
    remainingNextSignatureCounts[signature] = @(count + 1);
  }

  NSMutableArray<RCTUIView *> *nextViews = [NSMutableArray arrayWithCapacity:renderedSegments.count];
  NSMutableArray<NSNumber *> *nextSignatures = [NSMutableArray arrayWithCapacity:renderedSegments.count];
  NSMutableSet<RCTUIView *> *reusedViews = [NSMutableSet setWithCapacity:sourceViews.count];

  [renderedSegments enumerateObjectsUsingBlock:^(ENRMRenderedSegment *segment, NSUInteger index, BOOL *stop) {
    RCTUIView *existingView = index < sourceViews.count ? sourceViews[index] : nil;
    NSNumber *existingSignature = index < sourceSignatures.count ? sourceSignatures[index] : nil;
    RCTUIView *view = nil;
    NSNumber *nextSignature = @(segment.signature);

    NSUInteger remainingNextSignatureCount = remainingNextSignatureCounts[nextSignature].unsignedIntegerValue;
    if (remainingNextSignatureCount > 1) {
      remainingNextSignatureCounts[nextSignature] = @(remainingNextSignatureCount - 1);
    } else {
      [remainingNextSignatureCounts removeObjectForKey:nextSignature];
    }

    // 1. Exact positional match: the same view still represents the same segment.
    if (existingView && ![reusedViews containsObject:existingView] && matchesKind(existingView, segment) &&
        [existingSignature isEqual:nextSignature]) {
      view = existingView;
    }

    // 2. Signature-based fallback: find an unused view with exact same signature.
    if (!view) {
      NSMutableArray<NSNumber *> *candidateIndices = signatureToIndices[nextSignature];
      while (candidateIndices.count > 0) {
        NSUInteger candidateIdx = candidateIndices.firstObject.unsignedIntegerValue;
        [candidateIndices removeObjectAtIndex:0];
        RCTUIView *candidate = sourceViews[candidateIdx];
        if (![reusedViews containsObject:candidate] && matchesKind(candidate, segment)) {
          view = candidate;
          break;
        }
      }
    }

    // 3. Same-kind positional update. If this old signature appears later in
    // the new list, leave the view available for that exact reuse instead.
    if (!view && existingView && ![reusedViews containsObject:existingView] && matchesKind(existingView, segment) &&
        (existingSignature == nil || remainingNextSignatureCounts[existingSignature].unsignedIntegerValue == 0)) {
      updateView(existingView, segment);
      view = existingView;
    }

    // 4. No reusable view found — create a new one.
    if (!view) {
      view = createView(segment);
      attachView(view);
    }

    [nextViews addObject:view];
    [nextSignatures addObject:nextSignature];
    [reusedViews addObject:view];
  }];

  [sourceViews enumerateObjectsUsingBlock:^(RCTUIView *view, NSUInteger index, BOOL *stop) {
    if (![reusedViews containsObject:view]) {
      removeView(view);
    }
  }];

  ENRMSegmentReconciliationResult *result = [[ENRMSegmentReconciliationResult alloc] init];
  result.views = nextViews;
  result.signatures = nextSignatures;
  return result;
}
@end
