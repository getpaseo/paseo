#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ENRMInputMentionCandidate : NSObject

@property (nonatomic, copy) NSString *indicator;
@property (nonatomic, assign) NSUInteger start;
@property (nonatomic, assign) NSUInteger end;
@property (nonatomic, copy) NSString *text;

+ (instancetype)candidateWithIndicator:(NSString *)indicator
                                 start:(NSUInteger)start
                                   end:(NSUInteger)end
                                  text:(NSString *)text;

@end

NS_ASSUME_NONNULL_END
