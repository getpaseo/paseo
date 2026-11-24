#import "ENRMUIKit.h"
#include <TargetConditionals.h>

@class AccessibilityInfo;
@class ENRMAccessibilityLabels;

NS_ASSUME_NONNULL_BEGIN

@interface MarkdownAccessibilityElementBuilder : NSObject

#if !TARGET_OS_OSX
+ (NSMutableArray<UIAccessibilityElement *> *)buildElementsForTextView:(UITextView *)textView
                                                                  info:(AccessibilityInfo *)info
                                                                labels:(ENRMAccessibilityLabels *)labels
                                                             container:(id)container;
+ (NSArray<UIAccessibilityElement *> *)filterHeadingElements:(NSArray<UIAccessibilityElement *> *)elements;
+ (NSArray<UIAccessibilityElement *> *)filterLinkElements:(NSArray<UIAccessibilityElement *> *)elements;
+ (NSArray<UIAccessibilityElement *> *)filterImageElements:(NSArray<UIAccessibilityElement *> *)elements;
+ (UIAccessibilityCustomRotor *)createHeadingRotorWithElements:(NSArray<UIAccessibilityElement *> *)elements
                                                          name:(NSString *)name;
+ (UIAccessibilityCustomRotor *)createLinkRotorWithElements:(NSArray<UIAccessibilityElement *> *)elements
                                                       name:(NSString *)name;
+ (UIAccessibilityCustomRotor *)createImageRotorWithElements:(NSArray<UIAccessibilityElement *> *)elements
                                                        name:(NSString *)name;
+ (NSArray<UIAccessibilityCustomRotor *> *)buildRotorsFromElements:(NSArray<UIAccessibilityElement *> *)elements
                                                            labels:(ENRMAccessibilityLabels *)labels;
#else
+ (NSMutableArray *)buildElementsForTextView:(id)textView
                                        info:(AccessibilityInfo *)info
                                      labels:(ENRMAccessibilityLabels *)labels
                                   container:(id)container;
+ (NSArray *)filterHeadingElements:(NSArray *)elements;
+ (NSArray *)filterLinkElements:(NSArray *)elements;
+ (NSArray *)filterImageElements:(NSArray *)elements;
+ (id _Nullable)createHeadingRotorWithElements:(NSArray *)elements name:(NSString *)name;
+ (id _Nullable)createLinkRotorWithElements:(NSArray *)elements name:(NSString *)name;
+ (id _Nullable)createImageRotorWithElements:(NSArray *)elements name:(NSString *)name;
+ (NSArray *)buildRotorsFromElements:(NSArray *)elements labels:(ENRMAccessibilityLabels *)labels;
#endif

@end

NS_ASSUME_NONNULL_END
