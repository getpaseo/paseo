#import "ENRMLatexErrorCoordinator.h"

@interface ENRMPendingLatexError : NSObject
@property (nonatomic, copy, readonly) NSString *source;
@property (nonatomic, copy, readonly) NSString *message;
@property (nonatomic, readonly) BOOL displayMode;
@end

@implementation ENRMPendingLatexError
- (instancetype)initWithSource:(NSString *)source message:(NSString *)message displayMode:(BOOL)displayMode
{
  if (self = [super init]) {
    _source = [source copy];
    _message = [message copy];
    _displayMode = displayMode;
  }
  return self;
}
@end

@implementation ENRMLatexErrorCoordinator {
  ENRMLatexErrorEmit _emit;
  NSMutableSet<NSString *> *_reportedErrors;
  NSMutableArray<ENRMPendingLatexError *> *_pendingErrors;
}

- (instancetype)initWithEmit:(ENRMLatexErrorEmit)emit
{
  if (self = [super init]) {
    _emit = [emit copy];
    _reportedErrors = [NSMutableSet set];
    _pendingErrors = [NSMutableArray array];
  }
  return self;
}

- (void)wireReporters:(NSArray<id<ENRMLatexErrorReporting>> *)reporters
{
  if (reporters.count == 0)
    return;
  __weak __typeof(self) weakSelf = self;
  ENRMLatexErrorHandler handler = ^(NSString *source, NSString *message, BOOL displayMode) {
    [weakSelf reportSource:source message:message displayMode:displayMode];
  };
  for (id<ENRMLatexErrorReporting> reporter in reporters) {
    reporter.onLatexError = handler;
    [reporter reportLatexErrorIfNeeded];
  }
}

- (void)reportSource:(NSString *)source message:(NSString *)message displayMode:(BOOL)displayMode
{
  NSString *key = [NSString stringWithFormat:@"%@ %@", displayMode ? @"B" : @"I", source];
  if ([_reportedErrors containsObject:key])
    return;
  [_reportedErrors addObject:key];
  if (!_emit(source, message, displayMode)) {
    [_pendingErrors addObject:[[ENRMPendingLatexError alloc] initWithSource:source
                                                                    message:message
                                                                displayMode:displayMode]];
  }
}

- (void)flushPending
{
  if (_pendingErrors.count == 0)
    return;
  NSArray<ENRMPendingLatexError *> *pending = [_pendingErrors copy];
  [_pendingErrors removeAllObjects];
  for (ENRMPendingLatexError *e in pending) {
    _emit(e.source, e.message, e.displayMode);
  }
}

@end
