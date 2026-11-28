#import "ENRMAutoLinkDetector.h"

#import "ENRMFormattingRange.h"
#import "InputStylePropsUtils.h"

static NSAttributedStringKey const ENRMAutomaticLinkAttributeName = @"ENRMAutomaticLink";

@implementation ENRMAutoLinkDetector {
  __weak NSTextStorage *_textStorage;
  __weak ENRMFormattingStore *_formattingStore;
  __weak ENRMInputFormatterStyle *_style;
  ENRMLinkRegexConfig *_regexConfig;
}

- (instancetype)initWithTextStorage:(NSTextStorage *)textStorage
                    formattingStore:(ENRMFormattingStore *)store
                              style:(ENRMInputFormatterStyle *)style
{
  self = [super init];
  if (self) {
    _textStorage = textStorage;
    _formattingStore = store;
    _style = style;
  }
  return self;
}

- (void)setRegexConfig:(ENRMLinkRegexConfig *)config
{
  _regexConfig = config;
}

#pragma mark - ENRMTextDetector

- (void)processWord:(ENRMWordResult *)wordResult
{
  NSRange matchedRange = NSMakeRange(NSNotFound, 0);
  NSString *detectedUrl = [self detectNewLinkAtRange:wordResult.range
                                              inText:wordResult.word
                                        matchedRange:&matchedRange];
  if (detectedUrl != nil && _onLinkDetected != nil) {
    // Emit the actual linked slice, not the whole whitespace token — surrounding
    // punctuation is not part of the link.
    BOOL hasSlice = matchedRange.location != NSNotFound;
    NSString *matchedText = hasSlice ? [wordResult.word substringWithRange:matchedRange] : wordResult.word;
    NSRange absoluteRange = hasSlice
                                ? NSMakeRange(wordResult.range.location + matchedRange.location, matchedRange.length)
                                : wordResult.range;
    _onLinkDetected(matchedText, detectedUrl, absoluteRange);
  }
}

- (void)refreshStyling
{
  NSTextStorage *textStorage = _textStorage;
  if (textStorage == nil || textStorage.length == 0) {
    return;
  }

  [textStorage beginEditing];
  [textStorage enumerateAttribute:ENRMAutomaticLinkAttributeName
                          inRange:NSMakeRange(0, textStorage.length)
                          options:0
                       usingBlock:^(id value, NSRange range, BOOL *stop) {
                         if (value != nil) {
                           [self applyVisualStylingToRange:range];
                         }
                       }];
  [textStorage endEditing];
}

- (NSArray<ENRMFormattingRange *> *)transientFormattingRanges
{
  NSTextStorage *textStorage = _textStorage;
  if (textStorage == nil || textStorage.length == 0) {
    return @[];
  }

  NSMutableArray<ENRMFormattingRange *> *ranges = [NSMutableArray array];
  [textStorage enumerateAttribute:ENRMAutomaticLinkAttributeName
                          inRange:NSMakeRange(0, textStorage.length)
                          options:0
                       usingBlock:^(id value, NSRange range, BOOL *stop) {
                         if (value != nil && [value isKindOfClass:[NSString class]]) {
                           ENRMFormattingRange *fmtRange = [ENRMFormattingRange rangeWithType:ENRMInputStyleTypeLink
                                                                                        range:range
                                                                                          url:value];
                           [ranges addObject:fmtRange];
                         }
                       }];
  return ranges;
}

- (void)clearAutoLinkInRange:(NSRange)range
{
  NSTextStorage *textStorage = _textStorage;
  if (textStorage == nil || NSMaxRange(range) > textStorage.length) {
    return;
  }
  [textStorage removeAttribute:ENRMAutomaticLinkAttributeName range:range];
}

#pragma mark - Link matching

- (nullable NSString *)detectNewLinkAtRange:(NSRange)wordRange
                                     inText:(NSString *)word
                               matchedRange:(NSRange *)outMatchedRange
{
  if (outMatchedRange != NULL) {
    *outMatchedRange = NSMakeRange(NSNotFound, 0);
  }

  if (_regexConfig != nil && _regexConfig.isDisabled) {
    return nil;
  }

  NSTextStorage *textStorage = _textStorage;
  if (textStorage == nil) {
    return nil;
  }

  if (NSMaxRange(wordRange) > textStorage.length) {
    return nil;
  }

  // Tokens carrying markdown link syntax (e.g. "[label](url)") belong to the
  // parser, not the auto-linker. Auto-linking them re-wraps the destination and
  // yields a corrupted URL like "https://[label](url)" on serialize.
  if ([word hasPrefix:@"["] || [word rangeOfString:@"]("].location != NSNotFound) {
    [self clearAutoLinkInRange:wordRange];
    return nil;
  }

  NSRange localMatch = NSMakeRange(NSNotFound, 0);
  NSString *matchedUrl = [self tryMatchWord:word matchedRange:&localMatch];

  if (matchedUrl == nil || localMatch.location == NSNotFound) {
    [self clearAutoLinkInRange:wordRange];
    return nil;
  }

  NSRange matchRange = NSMakeRange(wordRange.location + localMatch.location, localMatch.length);

  // A manual link overlapping the matched slice takes precedence — test the
  // whole slice, not just its first character.
  ENRMFormattingStore *store = _formattingStore;
  if (store != nil && [store isStyleActive:ENRMInputStyleTypeLink inRange:matchRange]) {
    [self clearAutoLinkInRange:wordRange];
    return nil;
  }

  NSRange effectiveRange;
  id existing = [textStorage attribute:ENRMAutomaticLinkAttributeName
                               atIndex:matchRange.location
                        effectiveRange:&effectiveRange];
  BOOL alreadyApplied = [matchedUrl isEqual:existing] && NSEqualRanges(effectiveRange, matchRange);

  if (!alreadyApplied) {
    [textStorage beginEditing];
    [textStorage removeAttribute:ENRMAutomaticLinkAttributeName range:wordRange];
    [textStorage addAttribute:ENRMAutomaticLinkAttributeName value:matchedUrl range:matchRange];
    [self applyVisualStylingToRange:matchRange];
    [textStorage endEditing];
  }

  if (outMatchedRange != NULL) {
    *outMatchedRange = localMatch;
  }
  return matchedUrl;
}

- (nullable NSString *)tryMatchWord:(NSString *)word matchedRange:(NSRange *)outRange
{
  if (outRange != NULL) {
    *outRange = NSMakeRange(NSNotFound, 0);
  }

  if (word.length == 0) {
    return nil;
  }

  NSRange fullRange = NSMakeRange(0, word.length);

  // A custom regex describes the whole-token contract, so keep whole-word
  // semantics for it. The default detector extracts just the matched URL slice
  // so surrounding punctuation isn't swallowed into the link.
  BOOL customExact = _regexConfig != nil && !_regexConfig.isDefault && _regexConfig.parsedRegex != nil;
  NSRegularExpression *regex = customExact ? _regexConfig.parsedRegex : [ENRMAutoLinkDetector defaultRegex];
  if (regex == nil) {
    return nil;
  }

  NSTextCheckingResult *match = [regex firstMatchInString:word options:0 range:fullRange];
  if (match == nil || match.range.location == NSNotFound) {
    return nil;
  }

  NSRange matchRange = customExact ? fullRange : match.range;
  if (outRange != NULL) {
    *outRange = matchRange;
  }
  return [ENRMAutoLinkDetector normalizeUrl:[word substringWithRange:matchRange]];
}

+ (NSString *)normalizeUrl:(NSString *)url
{
  if ([url hasPrefix:@"http://"] || [url hasPrefix:@"https://"]) {
    return url;
  }
  return [@"https://" stringByAppendingString:url];
}

#pragma mark - Visual styling

- (void)applyVisualStylingToRange:(NSRange)range
{
  NSTextStorage *textStorage = _textStorage;
  ENRMInputFormatterStyle *style = _style;
  if (textStorage == nil || style == nil) {
    return;
  }

  [textStorage addAttribute:NSForegroundColorAttributeName value:style.linkColor range:range];
  if (style.linkUnderline) {
    [textStorage addAttribute:NSUnderlineStyleAttributeName value:@(NSUnderlineStyleSingle) range:range];
  }
}

#pragma mark - Default regex

+ (NSRegularExpression *)defaultRegex
{
  static NSRegularExpression *regex;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSError *error = nil;
    regex = [NSRegularExpression
        regularExpressionWithPattern:
            @"(?:https?://[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-z]{2,6}\\b[-a-zA-Z0-9@:%_\\+.~#?&//=]*"
            @"|www\\.[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-z]{2,6}\\b[-a-zA-Z0-9@:%_\\+.~#?&//=]*"
            @"|[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-z]{2,6}\\b[-a-zA-Z0-9@:%_\\+.~#?&//=]*)"
                             options:NSRegularExpressionCaseInsensitive
                               error:&error];
    NSCAssert(regex != nil, @"ENRMAutoLinkDetector: failed to compile default regex: %@", error);
  });
  return regex;
}

@end
