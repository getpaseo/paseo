#pragma once

#import "ENRMInputStyleStateBuilder.h"
#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

#ifdef __cplusplus
#import <ReactNativeEnrichedMarkdown/EventEmitters.h>
#import <memory>
#endif

NS_ASSUME_NONNULL_BEGIN

@protocol ENRMInputEventEmitterDataSource <ENRMInputStyleStateDataSource>

#ifdef __cplusplus
- (std::shared_ptr<facebook::react::EnrichedMarkdownTextInputEventEmitter const>)fabricEventEmitter;
#endif

- (NSString *)plainText;
- (NSString *)currentMarkdown;
- (CGRect)computeCaretRect;

@end

@interface ENRMInputEventEmitter : NSObject

@property (nonatomic, assign) BOOL emitMarkdown;

- (instancetype)initWithDataSource:(id<ENRMInputEventEmitterDataSource>)dataSource;

- (void)emitOnChangeText;
- (void)emitOnKeyPress:(NSString *)text;
- (void)emitOnChangeMarkdown;
- (void)emitOnChangeSelection;
- (void)emitOnChangeState;
- (void)emitFormattingChanged;
- (void)emitCaretRectChangeIfNeeded;
- (void)invalidateCachedState;
- (void)emitContextMenuItemPress:(NSString *)itemText;
- (void)emitOnFocus;
- (void)emitOnBlur;
- (void)emitOnLinkDetectedWithText:(NSString *)text url:(NSString *)url range:(NSRange)range;
- (void)emitOnStartMention:(NSString *)indicator;
- (void)emitOnChangeMentionWithIndicator:(NSString *)indicator text:(NSString *)text;
- (void)emitOnEndMention:(NSString *)indicator;
- (void)requestMarkdown:(NSInteger)requestId;
- (void)requestCaretRect:(NSInteger)requestId;

@end

NS_ASSUME_NONNULL_END
