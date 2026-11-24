#import "ENRMSpoilerOverlayManager.h"
#import "ENRMSpoilerOverlayView.h"
#import "ENRMSpoilerTapUtils.h"

static NSString *overlayKey(NSRange charRange, CGRect frame)
{
  return [NSString stringWithFormat:@"%lu-%lu-%.0f-%.0f-%.0f-%.0f", (unsigned long)charRange.location,
                                    (unsigned long)charRange.length, frame.origin.x, frame.origin.y, frame.size.width,
                                    frame.size.height];
}

@implementation ENRMSpoilerOverlayManager {
  __weak ENRMPlatformTextView *_textView;
  StyleConfig *_config;
  NSMutableDictionary<NSString *, ENRMSpoilerOverlayView *> *_overlaysByKey;
  BOOL _needsUpdate;
}

- (void)setSpoilerOverlay:(ENRMSpoilerOverlay)spoilerOverlay
{
  if (_spoilerOverlay == spoilerOverlay)
    return;
  _spoilerOverlay = spoilerOverlay;
  [self rebuildOverlays];
}

- (void)rebuildOverlays
{
  for (ENRMSpoilerOverlayView *overlay in _overlaysByKey.allValues) {
    [overlay removeFromSuperview];
  }
  [_overlaysByKey removeAllObjects];
  _needsUpdate = YES;
  [self updateIfNeeded];
}

- (instancetype)initWithTextView:(ENRMPlatformTextView *)textView config:(StyleConfig *)config
{
  if (self = [super init]) {
    _textView = textView;
    _config = config;
    _overlaysByKey = [NSMutableDictionary new];
  }
  return self;
}

#pragma mark - Public

- (void)setNeedsUpdate
{
  _needsUpdate = YES;
}

- (void)updateIfNeeded
{
  if (!_needsUpdate)
    return;
  ENRMPlatformTextView *textView = _textView;
  // Intentionally keep _needsUpdate=YES when the text view is unavailable
  // or has zero width — the update will be retried on the next layout pass.
  if (!textView || textView.bounds.size.width <= 0)
    return;
  [self updateOverlays];
}

- (void)removeOverlaysForCharRange:(NSRange)charRange
{
  NSMutableArray<NSString *> *keysToReveal = [NSMutableArray new];
  [_overlaysByKey enumerateKeysAndObjectsUsingBlock:^(NSString *key, ENRMSpoilerOverlayView *overlay, BOOL *stop) {
    if (NSIntersectionRange(overlay.charRange, charRange).length > 0) {
      [keysToReveal addObject:key];
    }
  }];

  // Keep revealing overlays in _overlaysByKey so updateOverlays won't create
  // duplicates during the animation. They are removed on completion.
  for (NSString *key in keysToReveal) {
    ENRMSpoilerOverlayView *overlay = _overlaysByKey[key];
    NSMutableDictionary *dict = _overlaysByKey;
    [overlay animateRevealWithCompletion:^{ [dict removeObjectForKey:key]; }];
  }
}

- (void)removeAllOverlays
{
  ENRMPlatformTextView *textView = _textView;
  if (textView && textView.textStorage.length > 0) {
    ENRMRestoreSpoilerTextColors(textView.textStorage, NSMakeRange(0, textView.textStorage.length));
  }
  for (ENRMSpoilerOverlayView *overlay in _overlaysByKey.allValues) {
    [overlay removeFromSuperview];
  }
  [_overlaysByKey removeAllObjects];
}

#pragma mark - Private

- (void)updateOverlays
{
  _needsUpdate = NO;

  ENRMPlatformTextView *textView = _textView;
  if (!textView) {
    [self removeAllOverlays];
    return;
  }

  NSTextStorage *textStorage = textView.textStorage;
  if (!textStorage || textStorage.length == 0) {
    [self removeAllOverlays];
    return;
  }

  NSLayoutManager *layoutManager = textView.layoutManager;
  NSTextContainer *textContainer = textView.textContainer;
  [layoutManager ensureLayoutForTextContainer:textContainer];

  UIEdgeInsets inset = textView.textContainerInset;

  NSMutableSet<NSString *> *desiredKeys = [NSMutableSet new];

  [textStorage
      enumerateAttribute:SpoilerAttributeName
                 inRange:NSMakeRange(0, textStorage.length)
                 options:0
              usingBlock:^(id value, NSRange charRange, BOOL *stop) {
                if (!value || charRange.length == 0)
                  return;

                NSRange glyphRange = [layoutManager glyphRangeForCharacterRange:charRange actualCharacterRange:NULL];
                if (glyphRange.location == NSNotFound || glyphRange.length == 0)
                  return;

                [layoutManager
                    enumerateLineFragmentsForGlyphRange:glyphRange
                                             usingBlock:^(CGRect lineRect, CGRect usedRect, NSTextContainer *container,
                                                          NSRange lineGlyphRange, BOOL *lineStop) {
                                               NSRange intersect = NSIntersectionRange(lineGlyphRange, glyphRange);
                                               if (intersect.length == 0)
                                                 return;

                                               CGRect textRect =
                                                   [layoutManager boundingRectForGlyphRange:intersect
                                                                            inTextContainer:textContainer];
                                               CGRect frame = CGRectMake(textRect.origin.x + inset.left,
                                                                         textRect.origin.y + inset.top,
                                                                         textRect.size.width, textRect.size.height);
                                               if (frame.size.width <= 0 || frame.size.height <= 0)
                                                 return;

                                               NSString *key = overlayKey(charRange, frame);
                                               [desiredKeys addObject:key];

                                               ENRMSpoilerOverlayView *existing = self->_overlaysByKey[key];
                                               if (existing && !existing.revealing)
                                                 return;

                                               ENRMSpoilerOverlayView *overlay =
                                                   [ENRMSpoilerOverlayView overlayWithMode:self->_spoilerOverlay
                                                                                    config:self->_config
                                                                                 charRange:charRange];
                                               overlay.frame = frame;
                                               [textView addSubview:overlay];
                                               self->_overlaysByKey[key] = overlay;
                                             }];
              }];

  NSMutableArray<NSString *> *staleKeys = [NSMutableArray new];
  [_overlaysByKey enumerateKeysAndObjectsUsingBlock:^(NSString *key, ENRMSpoilerOverlayView *overlay, BOOL *stop) {
    if (![desiredKeys containsObject:key] && !overlay.revealing) {
      [staleKeys addObject:key];
    }
  }];
  for (NSString *key in staleKeys) {
    ENRMSpoilerOverlayView *overlay = _overlaysByKey[key];
    [overlay removeFromSuperview];
    [_overlaysByKey removeObjectForKey:key];
  }
}

@end
