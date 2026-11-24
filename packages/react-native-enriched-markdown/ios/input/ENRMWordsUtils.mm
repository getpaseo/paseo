#import "ENRMWordsUtils.h"

@implementation ENRMWordResult

+ (instancetype)resultWithWord:(NSString *)word range:(NSRange)range
{
  ENRMWordResult *result = [[ENRMWordResult alloc] init];
  result->_word = [word copy];
  result->_range = range;
  return result;
}

@end

@implementation ENRMWordsUtils

+ (NSUInteger)tokenStartInText:(NSString *)text beforePosition:(NSUInteger)position
{
  NSCharacterSet *whitespace = [NSCharacterSet whitespaceAndNewlineCharacterSet];
  NSUInteger start = position;
  while (start > 0) {
    unichar previous = [text characterAtIndex:start - 1];
    if ([whitespace characterIsMember:previous]) {
      break;
    }
    start--;
  }
  return start;
}

+ (NSArray<ENRMWordResult *> *)getAffectedWordsFromText:(NSString *)text modificationRange:(NSRange)range
{
  NSUInteger textLength = text.length;
  if (textLength == 0) {
    return @[];
  }

  NSCharacterSet *whitespace = [NSCharacterSet whitespaceAndNewlineCharacterSet];
  NSCharacterSet *nonWhitespace = [whitespace invertedSet];

  NSUInteger left = range.location;
  if (left > 0) {
    NSRange searchRange = NSMakeRange(0, left);
    NSRange whitespaceHit = [text rangeOfCharacterFromSet:whitespace options:NSBackwardsSearch range:searchRange];
    left = (whitespaceHit.location != NSNotFound) ? NSMaxRange(whitespaceHit) : 0;
  }

  NSUInteger right = MIN(range.location + range.length, textLength);
  if (right < textLength) {
    NSRange searchRange = NSMakeRange(right, textLength - right);
    NSRange whitespaceHit = [text rangeOfCharacterFromSet:whitespace options:0 range:searchRange];
    right = (whitespaceHit.location != NSNotFound) ? whitespaceHit.location : textLength;
  }

  if (left >= right) {
    return @[];
  }

  NSMutableArray<ENRMWordResult *> *results = [NSMutableArray array];

  NSUInteger scanStart = left;
  while (scanStart < right) {
    NSRange scanRange = NSMakeRange(scanStart, right - scanStart);
    NSRange wordStart = [text rangeOfCharacterFromSet:nonWhitespace options:0 range:scanRange];
    if (wordStart.location == NSNotFound) {
      break;
    }

    NSRange remaining = NSMakeRange(NSMaxRange(wordStart), right - NSMaxRange(wordStart));
    NSRange wordEnd;
    if (remaining.length > 0) {
      wordEnd = [text rangeOfCharacterFromSet:whitespace options:0 range:remaining];
    } else {
      wordEnd.location = NSNotFound;
    }

    NSUInteger wordEndPosition = (wordEnd.location != NSNotFound) ? wordEnd.location : right;
    NSRange wordRange = NSMakeRange(wordStart.location, wordEndPosition - wordStart.location);
    NSString *word = [text substringWithRange:wordRange];

    [results addObject:[ENRMWordResult resultWithWord:word range:wordRange]];
    scanStart = wordEndPosition;
  }

  return results;
}

@end
