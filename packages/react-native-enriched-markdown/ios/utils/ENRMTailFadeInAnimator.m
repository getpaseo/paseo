#import "ENRMTailFadeInAnimator.h"
#import "LinkTapUtils.h"
#import <QuartzCore/QuartzCore.h>
#include <TargetConditionals.h>

static const NSTimeInterval kFadeDuration = 0.20;

typedef struct {
  NSRange range;
  __unsafe_unretained RCTUIColor *color;
} ENRMColorEntry;

@implementation ENRMTailFadeInAnimator {
  __weak ENRMPlatformTextView *_textView;
#if !TARGET_OS_OSX
  CADisplayLink *_displayLink;
#endif
  CFTimeInterval _startTime;

  NSArray<RCTUIColor *> *_retainedColors;
  ENRMColorEntry *_colorEntries;
  NSUInteger _entriesCount;
}

- (instancetype)initWithTextView:(ENRMPlatformTextView *)textView
{
  self = [super init];
  if (self) {
    _textView = textView;
  }
  return self;
}

- (void)dealloc
{
#if !TARGET_OS_OSX
  [_displayLink invalidate];
  _displayLink = nil;
#endif
  [self cleanupEntries];
}

- (void)animateFrom:(NSUInteger)tailStart to:(NSUInteger)tailEnd
{
  [self cancel];

  NSTextStorage *storage = _textView.textStorage;
  if (!storage || tailEnd <= tailStart || tailEnd > storage.length)
    return;

#if !TARGET_OS_OSX
  if (UIAccessibilityIsReduceMotionEnabled()) {
    return;
  }
#endif

  NSRange range = NSMakeRange(tailStart, tailEnd - tailStart);

  [self snapshotColorsInRange:range storage:storage];
  [self updateAlpha:0.0];

#if !TARGET_OS_OSX
  _startTime = CACurrentMediaTime();
  _displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(step:)];
  // 0 tells the system to use the display's maximum frame rate — 60 Hz on standard displays and 120 Hz on ProMotion ones
  _displayLink.preferredFramesPerSecond = 0;
  [_displayLink addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
#else
  // TODO: Implement the tail fade-in animation on macOS.
  // CADisplayLink doesn't exist on macOS; the equivalent is CVDisplayLink (Core Video)
  // or an NSTimer driven at the display refresh rate. The iOS step:/eased-progress
  // logic below can be reused directly once a display-sync callback is wired up.
  // TODO: When this is implemented, gate it on
  // NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion so macOS
  // users with Reduce Motion enabled also skip the fade.
  [self updateAlpha:1.0];
  [self cleanupEntries];
#endif
}

#if !TARGET_OS_OSX
- (void)step:(CADisplayLink *)link
{
  CFTimeInterval elapsed = CACurrentMediaTime() - _startTime;
  CGFloat progress = fmin(elapsed / kFadeDuration, 1.0);

  CGFloat eased = 1.0 - (1.0 - progress) * (1.0 - progress);

  [self updateAlpha:eased];

  if (progress >= 1.0) {
    [self cancel];
  }
}
#endif

- (void)updateAlpha:(CGFloat)alpha
{
  NSTextStorage *storage = _textView.textStorage;
  if (!storage || _entriesCount == 0)
    return;

  [storage beginEditing];
  for (NSUInteger i = 0; i < _entriesCount; i++) {
    ENRMColorEntry entry = _colorEntries[i];
    if (NSMaxRange(entry.range) <= storage.length) {
      RCTUIColor *fadedColor = [entry.color colorWithAlphaComponent:alpha];
      [storage addAttribute:NSForegroundColorAttributeName value:fadedColor range:entry.range];
    }
  }
  [storage endEditing];
}

- (void)snapshotColorsInRange:(NSRange)range storage:(NSTextStorage *)storage
{
  [self cleanupEntries];

  NSMutableArray<RCTUIColor *> *colors = [NSMutableArray array];
  NSMutableArray<NSValue *> *ranges = [NSMutableArray array];
  [storage enumerateAttribute:NSForegroundColorAttributeName
                      inRange:range
                      options:0
                   usingBlock:^(RCTUIColor *color, NSRange subRange, BOOL *stop) {
                     [colors addObject:color ?: [RCTUIColor labelColor]];
                     [ranges addObject:[NSValue valueWithRange:subRange]];
                   }];

  _entriesCount = colors.count;
  _retainedColors = [colors copy];
  _colorEntries = malloc(sizeof(ENRMColorEntry) * _entriesCount);

  for (NSUInteger i = 0; i < _entriesCount; i++) {
    _colorEntries[i].color = _retainedColors[i];
    _colorEntries[i].range = [ranges[i] rangeValue];
  }
}

- (void)cancel
{
#if !TARGET_OS_OSX
  [_displayLink invalidate];
  _displayLink = nil;
#endif

  if (_entriesCount > 0) {
    [self updateAlpha:1.0];
    [self cleanupEntries];
  }
}

- (void)cleanupEntries
{
  if (_colorEntries) {
    free(_colorEntries);
    _colorEntries = NULL;
  }
  _retainedColors = nil;
  _entriesCount = 0;
}

@end
