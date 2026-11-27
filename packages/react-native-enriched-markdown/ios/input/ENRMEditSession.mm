#import "ENRMEditSession.h"

static const CFTimeInterval kPostEditGracePeriod = 0.1;

@implementation ENRMEditSession {
  __weak ENRMPlatformTextView *_textView;
  CFTimeInterval _lastTextChangeTime;
}

- (instancetype)initWithTextView:(ENRMPlatformTextView *)textView
{
  if (self = [super init]) {
    _textView = textView;
    _phase = ENRMEditPhaseIdle;
    _lastTextChangeTime = 0;
  }
  return self;
}

- (void)enterPhase:(ENRMEditPhase)newPhase
{
  _phase = newPhase;
}

- (void)exitPhase
{
  _phase = ENRMEditPhaseIdle;
}

- (void)recordTextChange
{
  _lastTextChangeTime = CACurrentMediaTime();
}

- (BOOL)isComposing
{
  ENRMPlatformTextView *tv = _textView;
  if (!tv)
    return NO;
  return ENRMHasMarkedText(tv);
}

- (BOOL)isPostEditGracePeriod
{
  return _lastTextChangeTime > 0 && (CACurrentMediaTime() - _lastTextChangeTime) < kPostEditGracePeriod;
}

- (BOOL)shouldSuppressFormatting
{
  return _phase == ENRMEditPhaseFormatting || _phase == ENRMEditPhaseImporting;
}

- (BOOL)shouldSuppressEvents
{
  return _phase == ENRMEditPhaseImporting;
}

- (BOOL)shouldSuppressSelectionSideEffects
{
  return _phase != ENRMEditPhaseIdle;
}

@end
