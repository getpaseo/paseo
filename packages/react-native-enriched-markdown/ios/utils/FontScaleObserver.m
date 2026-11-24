#import "FontScaleObserver.h"
#import <React/RCTUtils.h>
#include <TargetConditionals.h>

@implementation FontScaleObserver {
  CGFloat _currentFontScale;
}

- (instancetype)init
{
  if (self = [super init]) {
    _allowFontScaling = YES;
    _currentFontScale = RCTFontSizeMultiplier();

#if !TARGET_OS_OSX
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(contentSizeCategoryDidChange:)
                                                 name:UIContentSizeCategoryDidChangeNotification
                                               object:nil];
#endif
    // TODO: Observe macOS system font size changes. UIContentSizeCategoryDidChangeNotification
    // is iOS-only; macOS has no direct equivalent. Possible approaches: KVO on
    // NSApplication.effectiveAppearance or polling NSFont.systemFontSize.
  }
  return self;
}

- (void)dealloc
{
#if !TARGET_OS_OSX
  [[NSNotificationCenter defaultCenter] removeObserver:self name:UIContentSizeCategoryDidChangeNotification object:nil];
#endif
}

- (CGFloat)effectiveFontScale
{
  return _allowFontScaling ? _currentFontScale : 1.0;
}

- (void)contentSizeCategoryDidChange:(NSNotification *)notification
{
  if (!_allowFontScaling) {
    return;
  }

  CGFloat newFontScale = RCTFontSizeMultiplier();
  if (_currentFontScale != newFontScale) {
    _currentFontScale = newFontScale;
    if (self.onChange) {
      self.onChange();
    }
  }
}

@end
