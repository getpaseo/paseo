#import "ENRMTextHitTest.h"

NSUInteger ENRMCharacterIndexAtPoint(ENRMPlatformTextView *textView, CGPoint point)
{
  NSLayoutManager *layoutManager = textView.layoutManager;
  CGPoint adjusted = CGPointMake(point.x - textView.textContainerInset.left, point.y - textView.textContainerInset.top);

  NSUInteger index = [layoutManager characterIndexForPoint:adjusted
                                           inTextContainer:textView.textContainer
                  fractionOfDistanceBetweenInsertionPoints:NULL];

  NSUInteger length = ENRMGetAttributedText(textView).length;
  return index < length ? index : NSNotFound;
}

NSUInteger ENRMCharacterIndexForTap(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer)
{
  CGPoint location = [recognizer locationInView:textView];
  return ENRMCharacterIndexAtPoint(textView, location);
}
