#import "ENRMLinkRegexConfig.h"

#import <React/RCTLog.h>

@implementation ENRMLinkRegexConfig {
  NSRegularExpression *_parsedWholeSpanRegex;
  BOOL _wholeSpanResolved;
}

- (instancetype)initWithPattern:(NSString *)pattern
                caseInsensitive:(BOOL)caseInsensitive
                         dotAll:(BOOL)dotAll
                     isDisabled:(BOOL)isDisabled
                      isDefault:(BOOL)isDefault
{
  self = [super init];
  if (!self) {
    return nil;
  }

  _pattern = [pattern copy];
  _caseInsensitive = caseInsensitive;
  _dotAll = dotAll;
  _isDisabled = isDisabled;
  _isDefault = isDefault;
  _parsedRegex = nil;

  if (!_isDefault && !_isDisabled && _pattern.length > 0) {
    NSError *error = nil;
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:_pattern
                                                                           options:[self options]
                                                                             error:&error];
    if (error) {
      RCTLogWarn(@"[EnrichedMarkdown]: The link regex '%@' is not a valid NSRegularExpression and is ignored.",
                 _pattern);
    } else {
      _parsedRegex = regex;
    }
  }

  return self;
}

+ (instancetype)cachedConfigWithPattern:(NSString *)pattern caseInsensitive:(BOOL)caseInsensitive dotAll:(BOOL)dotAll
{
  static NSCache<NSString *, ENRMLinkRegexConfig *> *cache;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    cache = [[NSCache alloc] init];
    cache.countLimit = 64;
  });
  NSString *key = [NSString stringWithFormat:@"%d%d%@", caseInsensitive, dotAll, pattern];
  ENRMLinkRegexConfig *config = [cache objectForKey:key];
  if (!config) {
    config = [[self alloc] initWithPattern:pattern
                           caseInsensitive:caseInsensitive
                                    dotAll:dotAll
                                isDisabled:NO
                                 isDefault:NO];
    [cache setObject:config forKey:key];
  }
  return config;
}

- (NSRegularExpressionOptions)options
{
  NSRegularExpressionOptions options = 0;
  if (_caseInsensitive) {
    options |= NSRegularExpressionCaseInsensitive;
  }
  if (_dotAll) {
    options |= NSRegularExpressionDotMatchesLineSeparators;
  }
  return options;
}

- (NSRegularExpression *)parsedWholeSpanRegex
{
  if (_parsedRegex == nil) {
    return nil;
  }
  @synchronized(self) {
    if (!_wholeSpanResolved) {
      // Anchor the whole alternation so `a|ab` matches "ab" in full.
      _parsedWholeSpanRegex =
          [NSRegularExpression regularExpressionWithPattern:[NSString stringWithFormat:@"\\A(?:%@)\\z", _pattern]
                                                    options:[self options]
                                                      error:nil];
      _wholeSpanResolved = YES;
    }
    return _parsedWholeSpanRegex;
  }
}

- (BOOL)isEqualToConfig:(ENRMLinkRegexConfig *)other
{
  if (other == nil) {
    return NO;
  }
  return [_pattern isEqualToString:other.pattern] && _caseInsensitive == other.caseInsensitive &&
         _dotAll == other.dotAll && _isDefault == other.isDefault && _isDisabled == other.isDisabled;
}

@end
