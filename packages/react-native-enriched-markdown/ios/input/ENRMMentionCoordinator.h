#pragma once

#import "ENRMFormattingStore.h"
#import "ENRMInputMentionCandidate.h"
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, ENRMMentionEventType) {
  ENRMMentionEventStart,
  ENRMMentionEventChange,
  ENRMMentionEventEnd,
};

@interface ENRMMentionEvent : NSObject
@property (nonatomic, assign) ENRMMentionEventType type;
@property (nonatomic, copy) NSString *indicator;
@property (nonatomic, copy, nullable) NSString *text;
+ (instancetype)startWithIndicator:(NSString *)indicator;
+ (instancetype)changeWithIndicator:(NSString *)indicator text:(NSString *)text;
+ (instancetype)endWithIndicator:(NSString *)indicator;
@end

@interface ENRMMentionCoordinator : NSObject

@property (nonatomic, readonly, nullable) NSString *activeIndicator;
@property (nonatomic, readonly) NSRange activeRange;
@property (nonatomic, readonly, copy) NSString *activeText;
@property (nonatomic, readonly) BOOL isActive;

- (instancetype)initWithFormattingStore:(ENRMFormattingStore *)formattingStore;

- (BOOL)containsIndicator:(NSString *)indicator;
- (NSArray<ENRMMentionEvent *> *)setIndicators:(NSArray<NSString *> *)indicators;

/// Re-evaluates the active mention. Returns events for the view to dispatch.
- (NSArray<ENRMMentionEvent *> *)updateWithText:(nullable NSString *)plainText selectedRange:(NSRange)selectedRange;

- (NSArray<ENRMMentionEvent *> *)clearWithIndicatorOverride:(nullable NSString *)indicatorOverride;

- (nullable ENRMInputMentionCandidate *)detectCandidateInText:(NSString *)plainText atCursor:(NSUInteger)cursor;

@end

NS_ASSUME_NONNULL_END
