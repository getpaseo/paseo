#import "ENRMLinkCoordinator.h"

@implementation ENRMLinkCoordinator {
  ENRMFormattingStore *_formattingStore;
  id<ENRMAutoLinkDetecting> _autoLinkDetector;
}

- (instancetype)initWithFormattingStore:(ENRMFormattingStore *)formattingStore
                       autoLinkDetector:(id<ENRMAutoLinkDetecting>)autoLinkDetector
{
  if (self = [super init]) {
    _formattingStore = formattingStore;
    _autoLinkDetector = autoLinkDetector;
  }
  return self;
}

- (NSString *)sanitizeURL:(NSString *)url
{
  NSString *result = [url stringByReplacingOccurrencesOfString:@"(" withString:@"%28"];
  return [result stringByReplacingOccurrencesOfString:@")" withString:@"%29"];
}

- (nullable ENRMFormattingRange *)linkForSelection:(NSRange)selection
{
  ENRMFormattingRange *link = [_formattingStore rangeOfType:ENRMInputStyleTypeLink
                                         containingPosition:selection.location];
  if (link == nil && selection.length == 0 && selection.location > 0) {
    link = [_formattingStore rangeOfType:ENRMInputStyleTypeLink containingPosition:selection.location - 1];
  }
  return link;
}

- (BOOL)setLinkURL:(NSString *)url forSelection:(NSRange)selection
{
  ENRMFormattingRange *activeLink = [self linkForSelection:selection];

  // Update the link if selection is entirely within it
  if (activeLink != nil && selection.location >= activeLink.range.location &&
      NSMaxRange(selection) <= NSMaxRange(activeLink.range)) {
    activeLink.url = url;
    [_autoLinkDetector clearAutoLinkInRange:activeLink.range];
    return YES;
  }

  // Insert a link at the selection (removing any existing links that overlap)
  if (selection.length > 0) {
    ENRMFormattingRange *linkRange = [ENRMFormattingRange rangeWithType:ENRMInputStyleTypeLink range:selection url:url];
    [_formattingStore addRange:linkRange];
    [_autoLinkDetector clearAutoLinkInRange:selection];
    return YES;
  }

  return NO;
}

- (BOOL)removeLinkForSelection:(NSRange)selection
{
  ENRMFormattingRange *activeLink = [self linkForSelection:selection];
  if (activeLink == nil) {
    return NO;
  }
  [_formattingStore removeRange:activeLink];
  return YES;
}

- (nullable ENRMFormattingRange *)linkRangeForDeletionAtPosition:(NSUInteger)position
{
  if (position == 0) {
    return nil;
  }
  return [_formattingStore rangeOfType:ENRMInputStyleTypeLink containingPosition:position - 1];
}

@end
