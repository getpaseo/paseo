#import "ENRMMentionCoordinator.h"
#import "ENRMWordsUtils.h"

@implementation ENRMMentionEvent

+ (instancetype)startWithIndicator:(NSString *)indicator
{
  ENRMMentionEvent *e = [[ENRMMentionEvent alloc] init];
  e.type = ENRMMentionEventStart;
  e.indicator = indicator;
  return e;
}

+ (instancetype)changeWithIndicator:(NSString *)indicator text:(NSString *)text
{
  ENRMMentionEvent *e = [[ENRMMentionEvent alloc] init];
  e.type = ENRMMentionEventChange;
  e.indicator = indicator;
  e.text = text;
  return e;
}

+ (instancetype)endWithIndicator:(NSString *)indicator
{
  ENRMMentionEvent *e = [[ENRMMentionEvent alloc] init];
  e.type = ENRMMentionEventEnd;
  e.indicator = indicator;
  return e;
}

@end

@implementation ENRMMentionCoordinator {
  ENRMFormattingStore *_formattingStore;
  NSArray<NSString *> *_indicators;
  NSString *_activeIndicator;
  NSRange _activeRange;
  NSString *_activeText;
}

- (instancetype)initWithFormattingStore:(ENRMFormattingStore *)formattingStore
{
  if (self = [super init]) {
    _formattingStore = formattingStore;
    _indicators = @[];
    _activeRange = NSMakeRange(NSNotFound, 0);
    _activeText = @"";
  }
  return self;
}

- (NSString *)activeIndicator
{
  return _activeIndicator;
}

- (NSRange)activeRange
{
  return _activeRange;
}

- (NSString *)activeText
{
  return _activeText;
}

- (BOOL)isActive
{
  return _activeIndicator != nil;
}

- (BOOL)containsIndicator:(NSString *)indicator
{
  return [_indicators containsObject:indicator];
}

- (NSArray<ENRMMentionEvent *> *)setIndicators:(NSArray<NSString *> *)indicators
{
  if ([indicators isEqualToArray:_indicators]) {
    return @[];
  }
  _indicators = [indicators copy];
  NSMutableArray<ENRMMentionEvent *> *events = [NSMutableArray array];
  if (_activeIndicator != nil && ![_indicators containsObject:_activeIndicator]) {
    [events addObjectsFromArray:[self clearWithIndicatorOverride:_activeIndicator]];
  }
  return events;
}

- (NSArray<ENRMMentionEvent *> *)updateWithText:(nullable NSString *)plainText selectedRange:(NSRange)selectedRange
{
  if (plainText == nil || selectedRange.length != 0) {
    return [self clearWithIndicatorOverride:nil];
  }
  NSUInteger cursor = selectedRange.location;
  if (cursor > plainText.length) {
    return [self clearWithIndicatorOverride:nil];
  }

  ENRMInputMentionCandidate *candidate = [self detectCandidateInText:plainText atCursor:cursor];
  if (candidate == nil) {
    return [self clearWithIndicatorOverride:nil];
  }

  NSMutableArray<ENRMMentionEvent *> *events = [NSMutableArray array];

  if (_activeIndicator == nil || ![_activeIndicator isEqualToString:candidate.indicator] ||
      _activeRange.location != candidate.start) {
    if (_activeIndicator != nil) {
      [events addObject:[ENRMMentionEvent endWithIndicator:_activeIndicator]];
    }
    _activeIndicator = candidate.indicator;
    [events addObject:[ENRMMentionEvent startWithIndicator:candidate.indicator]];
  }

  _activeRange = NSMakeRange(candidate.start, candidate.end - candidate.start);

  if (![_activeText isEqualToString:candidate.text]) {
    _activeText = candidate.text;
    [events addObject:[ENRMMentionEvent changeWithIndicator:candidate.indicator text:candidate.text]];
  }

  return events;
}

- (NSArray<ENRMMentionEvent *> *)clearWithIndicatorOverride:(nullable NSString *)indicatorOverride
{
  NSString *indicator = indicatorOverride ?: _activeIndicator;
  _activeIndicator = nil;
  _activeRange = NSMakeRange(NSNotFound, 0);
  _activeText = @"";
  if (indicator.length > 0) {
    return @[ [ENRMMentionEvent endWithIndicator:indicator] ];
  }
  return @[];
}

- (nullable ENRMInputMentionCandidate *)detectCandidateInText:(NSString *)plainText atCursor:(NSUInteger)cursor
{
  if (_indicators.count == 0) {
    return nil;
  }

  NSUInteger start = [ENRMWordsUtils tokenStartInText:plainText beforePosition:cursor];
  NSString *token = [plainText substringWithRange:NSMakeRange(start, cursor - start)];
  NSString *matchedIndicator = nil;
  for (NSString *indicator in _indicators) {
    if ([token hasPrefix:indicator]) {
      matchedIndicator = indicator;
      break;
    }
  }
  if (matchedIndicator == nil) {
    return nil;
  }

  if ([_formattingStore rangeOfType:ENRMInputStyleTypeLink containingPosition:start] != nil) {
    return nil;
  }

  return [ENRMInputMentionCandidate candidateWithIndicator:matchedIndicator
                                                     start:start
                                                       end:cursor
                                                      text:[token substringFromIndex:matchedIndicator.length]];
}

@end
