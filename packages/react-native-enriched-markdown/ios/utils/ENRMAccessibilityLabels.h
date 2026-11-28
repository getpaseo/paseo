#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ENRMAccessibilityLabels : NSObject

@property (nonatomic, copy) NSString *bulletPoint;
@property (nonatomic, copy) NSString *nestedBulletPoint;
@property (nonatomic, copy) NSString *orderedItem;
@property (nonatomic, copy) NSString *nestedOrderedItem;
@property (nonatomic, copy) NSString *blockquote;
@property (nonatomic, copy) NSString *nestedBlockquote;
@property (nonatomic, copy) NSString *tableRow;
@property (nonatomic, copy) NSString *mathEquation;
@property (nonatomic, copy) NSString *rotorHeadings;
@property (nonatomic, copy) NSString *rotorLinks;
@property (nonatomic, copy) NSString *rotorImages;

@end

NS_ASSUME_NONNULL_END

#ifdef __cplusplus
template <typename T> static bool ENRMAccessibilityLabelsChanged(const T &oldLabels, const T &newLabels)
{
  return oldLabels.list.bulletPoint != newLabels.list.bulletPoint ||
         oldLabels.list.nestedBulletPoint != newLabels.list.nestedBulletPoint ||
         oldLabels.list.orderedItem != newLabels.list.orderedItem ||
         oldLabels.list.nestedOrderedItem != newLabels.list.nestedOrderedItem ||
         oldLabels.blockquote.quote != newLabels.blockquote.quote ||
         oldLabels.blockquote.nestedQuote != newLabels.blockquote.nestedQuote ||
         oldLabels.table.row != newLabels.table.row || oldLabels.math.equation != newLabels.math.equation ||
         oldLabels.rotor.headings != newLabels.rotor.headings || oldLabels.rotor.links != newLabels.rotor.links ||
         oldLabels.rotor.images != newLabels.rotor.images;
}
#endif
