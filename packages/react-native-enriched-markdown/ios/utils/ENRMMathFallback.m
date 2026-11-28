#import "ENRMMathFallback.h"

NS_ASSUME_NONNULL_BEGIN

NSAttributedString *ENRMMathFallbackString(NSString *_Nullable latex, NSString *delimiter, CGFloat fontSize,
                                           RCTUIColor *_Nullable color)
{
  CGFloat size = fontSize > 0 ? fontSize : kENRMMathFallbackDefaultFontSize;
  UIFont *font = [UIFont systemFontOfSize:size];
  NSString *source = [NSString stringWithFormat:@"%@%@%@", delimiter, latex ?: @"", delimiter];
  return [[NSAttributedString alloc] initWithString:source
                                         attributes:@{
                                           NSFontAttributeName : font,
                                           NSForegroundColorAttributeName : color ?: [RCTUIColor blackColor],
                                         }];
}

NS_ASSUME_NONNULL_END
