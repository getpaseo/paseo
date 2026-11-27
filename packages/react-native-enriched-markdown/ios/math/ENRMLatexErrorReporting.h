#pragma once
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^ENRMLatexErrorHandler)(NSString *source, NSString *message, BOOL displayMode);

@protocol ENRMLatexErrorReporting <NSObject>
@property (nonatomic, copy, nullable) ENRMLatexErrorHandler onLatexError;
- (void)reportLatexErrorIfNeeded;
@end

NS_ASSUME_NONNULL_END
