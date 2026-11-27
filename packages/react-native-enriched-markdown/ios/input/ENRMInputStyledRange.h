#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, ENRMInputStyleType) {
  ENRMInputStyleTypeStrong,
  ENRMInputStyleTypeEmphasis,
  ENRMInputStyleTypeUnderline,
  ENRMInputStyleTypeStrikethrough,
  ENRMInputStyleTypeLink,
  ENRMInputStyleTypeSpoiler,
};

@interface ENRMInputStyledRange : NSObject

@property (nonatomic, assign) ENRMInputStyleType type;
@property (nonatomic, assign) NSRange contentRange;
@property (nonatomic, strong) NSArray<NSValue *> *syntaxRanges;
@property (nonatomic, assign) NSRange fullRange;
@property (nonatomic, strong, nullable) NSString *url;

/// YES if both delimiters are present in the original text (before remend completion).
@property (nonatomic, assign) BOOL isComplete;

@end

NS_ASSUME_NONNULL_END
