#pragma once

#import "ENRMBlockRange.h"
#import "ENRMEditSession.h"
#import "ENRMInputFormatterStyle.h"
#import "ENRMInputStyledRange.h"
#import "ENRMInputTextView.h"
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@protocol ENRMInputTypingAttributesDataSource <NSObject>

- (NSRange)selectedRange;
- (NSInteger)headingLevelForCursorParagraph;
- (nullable ENRMBlockRange *)listBlockForCursorParagraph;
- (BOOL)isStyleAdjacentBefore:(ENRMInputStyleType)type position:(NSUInteger)position;
- (BOOL)isStyleActive:(ENRMInputStyleType)type atPosition:(NSUInteger)position;

@end

@interface ENRMInputTypingAttributesController : NSObject

- (instancetype)initWithTextView:(ENRMPlatformTextView *)textView
                  formatterStyle:(ENRMInputFormatterStyle *)style
                      dataSource:(id<ENRMInputTypingAttributesDataSource>)dataSource
                     editSession:(ENRMEditSession *)editSession;

- (BOOL)isEffectiveStyleActive:(ENRMInputStyleType)type atPosition:(NSUInteger)position;
- (void)togglePendingStyle:(ENRMInputStyleType)type wasActive:(BOOL)wasActive hasSelection:(BOOL)hasSelection;
- (void)clearPendingStyle:(ENRMInputStyleType)type;
- (void)syncWithCursorBlock;
- (void)syncWithPendingStyles;
- (void)resetForSelectionChange;
- (void)clearListParagraphStyle;

@property (nonatomic, readonly) NSSet<NSNumber *> *pendingStyles;
@property (nonatomic, readonly) NSSet<NSNumber *> *pendingStyleRemovals;

@end

NS_ASSUME_NONNULL_END
