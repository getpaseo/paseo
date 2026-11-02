#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

extern "C" void rn_gpui_accessibility_setting_changed(
    const char *eventName,
    bool enabled);

static id accessibilityOptionsObserver = nil;
static bool lastReduceMotion = false;
static bool lastReduceTransparency = false;
static bool lastIncreaseContrast = false;
static bool lastInvertColors = false;

@interface GpuiVoiceOverObserver : NSObject
@end

@implementation GpuiVoiceOverObserver
- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context
{
  if ([keyPath isEqualToString:@"voiceOverEnabled"]) {
    const bool enabled = NSWorkspace.sharedWorkspace.isVoiceOverEnabled;
    dispatch_async(dispatch_get_main_queue(), ^{
      rn_gpui_accessibility_setting_changed("screenReaderChanged", enabled);
    });
  } else {
    [super observeValueForKeyPath:keyPath
                         ofObject:object
                           change:change
                          context:context];
  }
}
@end

static GpuiVoiceOverObserver *voiceOverObserver = nil;

extern "C" bool rn_gpui_get_voice_over()
{
  return NSWorkspace.sharedWorkspace.isVoiceOverEnabled;
}

extern "C" bool rn_gpui_get_invert_colors()
{
  return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldInvertColors;
}

extern "C" bool rn_gpui_get_reduce_motion()
{
  return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
}

extern "C" bool rn_gpui_get_reduce_transparency()
{
  return NSWorkspace.sharedWorkspace
      .accessibilityDisplayShouldReduceTransparency;
}

extern "C" bool rn_gpui_get_increase_contrast()
{
  return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldIncreaseContrast;
}

extern "C" void rn_gpui_start_accessibility_observing()
{
  dispatch_block_t start = ^{
    if (accessibilityOptionsObserver != nil) {
      return;
    }
    NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
    lastReduceMotion = workspace.accessibilityDisplayShouldReduceMotion;
    lastReduceTransparency =
        workspace.accessibilityDisplayShouldReduceTransparency;
    lastIncreaseContrast = workspace.accessibilityDisplayShouldIncreaseContrast;
    lastInvertColors = workspace.accessibilityDisplayShouldInvertColors;
    voiceOverObserver = [GpuiVoiceOverObserver new];
    [workspace addObserver:voiceOverObserver
                forKeyPath:@"voiceOverEnabled"
                   options:NSKeyValueObservingOptionNew
                   context:nullptr];
    accessibilityOptionsObserver = [workspace.notificationCenter
        addObserverForName:
            NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification
                    object:nil
                     queue:NSOperationQueue.mainQueue
                usingBlock:^(__unused NSNotification *notification) {
                  NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
                  const bool reduceMotion =
                      workspace.accessibilityDisplayShouldReduceMotion;
                  const bool reduceTransparency =
                      workspace.accessibilityDisplayShouldReduceTransparency;
                  const bool increaseContrast =
                      workspace.accessibilityDisplayShouldIncreaseContrast;
                  const bool invertColors =
                      workspace.accessibilityDisplayShouldInvertColors;
                  if (invertColors != lastInvertColors) {
                    lastInvertColors = invertColors;
                    rn_gpui_accessibility_setting_changed(
                        "invertColorsChanged", invertColors);
                  }
                  if (reduceMotion != lastReduceMotion) {
                    lastReduceMotion = reduceMotion;
                    rn_gpui_accessibility_setting_changed(
                        "reduceMotionChanged", reduceMotion);
                  }
                  if (reduceTransparency != lastReduceTransparency) {
                    lastReduceTransparency = reduceTransparency;
                    rn_gpui_accessibility_setting_changed(
                        "reduceTransparencyChanged", reduceTransparency);
                  }
                  if (increaseContrast != lastIncreaseContrast) {
                    lastIncreaseContrast = increaseContrast;
                    rn_gpui_accessibility_setting_changed(
                        "darkerSystemColorsChanged", increaseContrast);
                  }
                }];
  };
  if (NSThread.isMainThread) {
    start();
  } else {
    dispatch_sync(dispatch_get_main_queue(), start);
  }
}

extern "C" void rn_gpui_stop_accessibility_observing()
{
  dispatch_block_t stop = ^{
    if (accessibilityOptionsObserver != nil) {
      [NSWorkspace.sharedWorkspace.notificationCenter
          removeObserver:accessibilityOptionsObserver];
      accessibilityOptionsObserver = nil;
      [NSWorkspace.sharedWorkspace removeObserver:voiceOverObserver
                                       forKeyPath:@"voiceOverEnabled"];
      voiceOverObserver = nil;
    }
  };
  if (NSThread.isMainThread) {
    stop();
  } else {
    dispatch_sync(dispatch_get_main_queue(), stop);
  }
}

extern "C" void rn_gpui_announce_accessibility(
    const char *message,
    int priorityLevel)
{
  if (message == nullptr || message[0] == '\0') {
    return;
  }
  NSString *announcement = [[NSString alloc] initWithUTF8String:message];
  if (announcement == nil) {
    return;
  }
  const auto priority = priorityLevel == 2 ? NSAccessibilityPriorityHigh
      : priorityLevel == 0                 ? NSAccessibilityPriorityLow
                                           : NSAccessibilityPriorityMedium;
  NSDictionary *info = @{
    NSAccessibilityAnnouncementKey : announcement,
    NSAccessibilityPriorityKey : @(priority),
  };
  dispatch_async(dispatch_get_main_queue(), ^{
    NSAccessibilityPostNotificationWithUserInfo(
        NSApp, NSAccessibilityAnnouncementRequestedNotification, info);
  });
}
