#pragma once

#import "ENRMInputFormatter.h"
#import "ENRMInputFormatterStyle.h"
#import "ENRMUIKit.h"
#import "FontUtils.h"
#import "ParagraphStyleUtils.h"
#import <React/RCTConversions.h>

#if !TARGET_OS_OSX
static inline UITextAutocapitalizationType ENRMAutocapitalizationTypeFromString(NSString *value)
{
  if ([value isEqualToString:@"none"])
    return UITextAutocapitalizationTypeNone;
  if ([value isEqualToString:@"words"])
    return UITextAutocapitalizationTypeWords;
  if ([value isEqualToString:@"characters"])
    return UITextAutocapitalizationTypeAllCharacters;
  return UITextAutocapitalizationTypeSentences;
}
#endif

static inline NSMutableParagraphStyle *
ENRMInputParagraphStyleWithLineHeight(ENRMInputFormatterStyle *style, NSParagraphStyle *_Nullable existingParagraph)
{
  NSMutableParagraphStyle *paragraph =
      existingParagraph ? [existingParagraph mutableCopy] : [[NSMutableParagraphStyle alloc] init];
  ENRMApplyLineHeightToParagraphStyle(paragraph, style.baseLineHeight);
  return paragraph;
}

/// Headings h1..h6 share an identical struct shape (fontSize / fontWeight /
/// color) but are distinct codegen types, hence the template.
template <typename HeadingProps>
static BOOL applyHeadingLevelProps(ENRMInputFormatterStyle *style, NSInteger level, const HeadingProps &newHeading,
                                   const HeadingProps &oldHeading)
{
  BOOL changed = NO;

  if (newHeading.fontSize != oldHeading.fontSize) {
    [style setHeadingFontSize:newHeading.fontSize forLevel:level];
    changed = YES;
  }

  if (newHeading.fontWeight != oldHeading.fontWeight) {
    NSString *weight =
        newHeading.fontWeight.empty() ? nil : [NSString stringWithUTF8String:newHeading.fontWeight.c_str()];
    [style setHeadingFontWeight:weight forLevel:level];
    changed = YES;
  }

  if (newHeading.color != oldHeading.color) {
    RCTUIColor *color = isColorMeaningful(newHeading.color) ? RCTUIColorFromSharedColor(newHeading.color) : nil;
    [style setHeadingColor:color forLevel:level];
    changed = YES;
  }

  return changed;
}

template <typename InputProps>
BOOL applyInputStyleProps(ENRMInputFormatterStyle *style, const InputProps &newProps, const InputProps &oldProps)
{
  BOOL changed = NO;

  if (newProps.fontSize != oldProps.fontSize) {
    CGFloat fontSize = newProps.fontSize > 0 ? newProps.fontSize : 16.0;
    style.baseFont = [style.baseFont fontWithSize:fontSize];
    changed = YES;
  }

  if (newProps.fontWeight != oldProps.fontWeight) {
    CGFloat fontSize = style.baseFont.pointSize;
    if (!newProps.fontWeight.empty()) {
      NSString *weightString = [NSString stringWithUTF8String:newProps.fontWeight.c_str()];
      UIFontWeight weight = ENRMFontWeightFromString(weightString);
      style.baseFont = [UIFont systemFontOfSize:fontSize weight:weight];
    } else {
      style.baseFont = [UIFont systemFontOfSize:fontSize];
    }
    changed = YES;
  }

  if (newProps.fontFamily != oldProps.fontFamily) {
    if (!newProps.fontFamily.empty()) {
      NSString *familyName = [NSString stringWithUTF8String:newProps.fontFamily.c_str()];
      UIFont *customFont = [UIFont fontWithName:familyName size:style.baseFont.pointSize];
      if (customFont) {
        style.baseFont = customFont;
      }
    } else {
      style.baseFont = [UIFont systemFontOfSize:style.baseFont.pointSize];
    }
    changed = YES;
  }

  if (newProps.color != oldProps.color) {
    if (isColorMeaningful(newProps.color)) {
      style.baseTextColor = RCTUIColorFromSharedColor(newProps.color);
    } else {
      style.baseTextColor = [RCTUIColor labelColor];
    }
    changed = YES;
  }

  if (newProps.lineHeight != oldProps.lineHeight) {
    style.baseLineHeight = newProps.lineHeight > 0 ? newProps.lineHeight : 0;
    changed = YES;
  }

  if (newProps.markdownStyle.strong.color != oldProps.markdownStyle.strong.color) {
    if (isColorMeaningful(newProps.markdownStyle.strong.color)) {
      style.boldColor = RCTUIColorFromSharedColor(newProps.markdownStyle.strong.color);
    } else {
      style.boldColor = nil;
    }
    changed = YES;
  }

  if (newProps.markdownStyle.em.color != oldProps.markdownStyle.em.color) {
    if (isColorMeaningful(newProps.markdownStyle.em.color)) {
      style.italicColor = RCTUIColorFromSharedColor(newProps.markdownStyle.em.color);
    } else {
      style.italicColor = nil;
    }
    changed = YES;
  }

  if (newProps.markdownStyle.link.color != oldProps.markdownStyle.link.color) {
    style.linkColor = RCTUIColorFromSharedColor(newProps.markdownStyle.link.color);
    changed = YES;
  }

  if (newProps.markdownStyle.link.underline != oldProps.markdownStyle.link.underline) {
    style.linkUnderline = newProps.markdownStyle.link.underline;
    changed = YES;
  }

  if (newProps.markdownStyle.link.backgroundColor != oldProps.markdownStyle.link.backgroundColor) {
    RCTUIColor *backgroundColor = RCTUIColorFromSharedColor(newProps.markdownStyle.link.backgroundColor);
    style.linkBackgroundColor = CGColorGetAlpha(backgroundColor.CGColor) > 0 ? backgroundColor : nil;
    changed = YES;
  }

  {
    BOOL linkVariantsChanged = newProps.markdownStyle.linkVariants.size() != oldProps.markdownStyle.linkVariants.size();
    if (!linkVariantsChanged) {
      for (size_t i = 0; i < newProps.markdownStyle.linkVariants.size(); i++) {
        const auto &newVariant = newProps.markdownStyle.linkVariants[i];
        const auto &oldVariant = oldProps.markdownStyle.linkVariants[i];
        if (newVariant.pattern != oldVariant.pattern || newVariant.color != oldVariant.color ||
            newVariant.underline != oldVariant.underline || newVariant.backgroundColor != oldVariant.backgroundColor) {
          linkVariantsChanged = YES;
          break;
        }
      }
    }

    if (linkVariantsChanged) {
      NSMutableArray<ENRMInputLinkVariantStyle *> *variants = [NSMutableArray array];
      for (const auto &entry : newProps.markdownStyle.linkVariants) {
        ENRMInputLinkVariantStyle *variant = [[ENRMInputLinkVariantStyle alloc] init];
        variant.pattern = [[NSString alloc] initWithUTF8String:entry.pattern.c_str()];
        variant.color = RCTUIColorFromSharedColor(entry.color);
        variant.underline = entry.underline;
        RCTUIColor *backgroundColor = RCTUIColorFromSharedColor(entry.backgroundColor);
        variant.backgroundColor = CGColorGetAlpha(backgroundColor.CGColor) > 0 ? backgroundColor : nil;
        variant.regex = [NSRegularExpression regularExpressionWithPattern:variant.pattern options:0 error:nil];
        if (variant.regex != nil) {
          [variants addObject:variant];
        }
      }
      style.linkVariants = variants;
      changed = YES;
    }
  }

  if (newProps.markdownStyle.spoiler.color != oldProps.markdownStyle.spoiler.color) {
    style.spoilerColor = RCTUIColorFromSharedColor(newProps.markdownStyle.spoiler.color);
    changed = YES;
  }

  if (newProps.markdownStyle.spoiler.backgroundColor != oldProps.markdownStyle.spoiler.backgroundColor) {
    style.spoilerBackgroundColor = RCTUIColorFromSharedColor(newProps.markdownStyle.spoiler.backgroundColor);
    changed = YES;
  }

  if (newProps.markdownStyle.list.itemSpacing != oldProps.markdownStyle.list.itemSpacing) {
    style.listItemSpacing = newProps.markdownStyle.list.itemSpacing;
    changed = YES;
  }

  changed |= applyHeadingLevelProps(style, 1, newProps.markdownStyle.h1, oldProps.markdownStyle.h1);
  changed |= applyHeadingLevelProps(style, 2, newProps.markdownStyle.h2, oldProps.markdownStyle.h2);
  changed |= applyHeadingLevelProps(style, 3, newProps.markdownStyle.h3, oldProps.markdownStyle.h3);
  changed |= applyHeadingLevelProps(style, 4, newProps.markdownStyle.h4, oldProps.markdownStyle.h4);
  changed |= applyHeadingLevelProps(style, 5, newProps.markdownStyle.h5, oldProps.markdownStyle.h5);
  changed |= applyHeadingLevelProps(style, 6, newProps.markdownStyle.h6, oldProps.markdownStyle.h6);

  return changed;
}
