#pragma once
#import "ENRMUIKit.h"

/**
 * StylePropsHelper.h
 *
 * C++ template that maps codegen-generated markdownStyle props → StyleConfig setters.
 * Both EnrichedMarkdownText and EnrichedMarkdown share identical markdownStyle fields
 * but codegen produces two distinct C++ struct types. A template lets us write the
 * mapping once and instantiate it for each type.
 */

#import "CodeBlockHighlighter.hpp"
#import "ParagraphStyleUtils.h"
#import "StyleConfig.h"
#import <React/RCTConversions.h>

template <typename MarkdownStyle>
BOOL applyMarkdownStyleToConfig(StyleConfig *config, const MarkdownStyle &newStyle, const MarkdownStyle &oldStyle)
{
  BOOL changed = NO;

  // ── Paragraph ──────────────────────────────────────────────────────────────

  if (newStyle.paragraph.fontSize != oldStyle.paragraph.fontSize) {
    [config setParagraphFontSize:newStyle.paragraph.fontSize];
    changed = YES;
  }

  if (newStyle.paragraph.fontFamily != oldStyle.paragraph.fontFamily) {
    if (!newStyle.paragraph.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.paragraph.fontFamily.c_str()];
      [config setParagraphFontFamily:fontFamily];
    } else {
      [config setParagraphFontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.paragraph.fontWeight != oldStyle.paragraph.fontWeight) {
    if (!newStyle.paragraph.fontWeight.empty()) {
      NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.paragraph.fontWeight.c_str()];
      [config setParagraphFontWeight:fontWeight];
    } else {
      [config setParagraphFontWeight:nullptr];
    }
    changed = YES;
  }

  if (newStyle.paragraph.color != oldStyle.paragraph.color) {
    if (newStyle.paragraph.color) {
      RCTUIColor *paragraphColor = RCTUIColorFromSharedColor(newStyle.paragraph.color);
      [config setParagraphColor:paragraphColor];
    } else {
      [config setParagraphColor:nullptr];
    }
    changed = YES;
  }

  if (newStyle.paragraph.marginTop != oldStyle.paragraph.marginTop) {
    [config setParagraphMarginTop:newStyle.paragraph.marginTop];
    changed = YES;
  }

  if (newStyle.paragraph.marginBottom != oldStyle.paragraph.marginBottom) {
    [config setParagraphMarginBottom:newStyle.paragraph.marginBottom];
    changed = YES;
  }

  if (newStyle.paragraph.lineHeight != oldStyle.paragraph.lineHeight) {
    [config setParagraphLineHeight:newStyle.paragraph.lineHeight];
    changed = YES;
  }

  if (newStyle.paragraph.textAlign != oldStyle.paragraph.textAlign) {
    [config setParagraphTextAlign:textAlignmentFromString(@(newStyle.paragraph.textAlign.c_str()))];
    changed = YES;
  }

  // ── H1 ─────────────────────────────────────────────────────────────────────

  if (newStyle.h1.fontSize != oldStyle.h1.fontSize) {
    [config setH1FontSize:newStyle.h1.fontSize];
    changed = YES;
  }

  if (newStyle.h1.fontFamily != oldStyle.h1.fontFamily) {
    if (!newStyle.h1.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.h1.fontFamily.c_str()];
      [config setH1FontFamily:fontFamily];
    } else {
      [config setH1FontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h1.fontWeight != oldStyle.h1.fontWeight) {
    if (!newStyle.h1.fontWeight.empty()) {
      NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.h1.fontWeight.c_str()];
      [config setH1FontWeight:fontWeight];
    } else {
      [config setH1FontWeight:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h1.color != oldStyle.h1.color) {
    if (newStyle.h1.color) {
      RCTUIColor *h1Color = RCTUIColorFromSharedColor(newStyle.h1.color);
      [config setH1Color:h1Color];
    } else {
      [config setH1Color:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h1.marginTop != oldStyle.h1.marginTop) {
    [config setH1MarginTop:newStyle.h1.marginTop];
    changed = YES;
  }

  if (newStyle.h1.marginBottom != oldStyle.h1.marginBottom) {
    [config setH1MarginBottom:newStyle.h1.marginBottom];
    changed = YES;
  }

  if (newStyle.h1.lineHeight != oldStyle.h1.lineHeight) {
    [config setH1LineHeight:newStyle.h1.lineHeight];
    changed = YES;
  }

  if (newStyle.h1.textAlign != oldStyle.h1.textAlign) {
    [config setH1TextAlign:textAlignmentFromString(@(newStyle.h1.textAlign.c_str()))];
    changed = YES;
  }

  // ── H2 ─────────────────────────────────────────────────────────────────────

  if (newStyle.h2.fontSize != oldStyle.h2.fontSize) {
    [config setH2FontSize:newStyle.h2.fontSize];
    changed = YES;
  }

  if (newStyle.h2.fontFamily != oldStyle.h2.fontFamily) {
    if (!newStyle.h2.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.h2.fontFamily.c_str()];
      [config setH2FontFamily:fontFamily];
    } else {
      [config setH2FontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h2.fontWeight != oldStyle.h2.fontWeight) {
    if (!newStyle.h2.fontWeight.empty()) {
      NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.h2.fontWeight.c_str()];
      [config setH2FontWeight:fontWeight];
    } else {
      [config setH2FontWeight:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h2.color != oldStyle.h2.color) {
    if (newStyle.h2.color) {
      RCTUIColor *h2Color = RCTUIColorFromSharedColor(newStyle.h2.color);
      [config setH2Color:h2Color];
    } else {
      [config setH2Color:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h2.marginTop != oldStyle.h2.marginTop) {
    [config setH2MarginTop:newStyle.h2.marginTop];
    changed = YES;
  }

  if (newStyle.h2.marginBottom != oldStyle.h2.marginBottom) {
    [config setH2MarginBottom:newStyle.h2.marginBottom];
    changed = YES;
  }

  if (newStyle.h2.lineHeight != oldStyle.h2.lineHeight) {
    [config setH2LineHeight:newStyle.h2.lineHeight];
    changed = YES;
  }

  if (newStyle.h2.textAlign != oldStyle.h2.textAlign) {
    [config setH2TextAlign:textAlignmentFromString(@(newStyle.h2.textAlign.c_str()))];
    changed = YES;
  }

  // ── H3 ─────────────────────────────────────────────────────────────────────

  if (newStyle.h3.fontSize != oldStyle.h3.fontSize) {
    [config setH3FontSize:newStyle.h3.fontSize];
    changed = YES;
  }

  if (newStyle.h3.fontFamily != oldStyle.h3.fontFamily) {
    if (!newStyle.h3.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.h3.fontFamily.c_str()];
      [config setH3FontFamily:fontFamily];
    } else {
      [config setH3FontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h3.fontWeight != oldStyle.h3.fontWeight) {
    if (!newStyle.h3.fontWeight.empty()) {
      NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.h3.fontWeight.c_str()];
      [config setH3FontWeight:fontWeight];
    } else {
      [config setH3FontWeight:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h3.color != oldStyle.h3.color) {
    if (newStyle.h3.color) {
      RCTUIColor *h3Color = RCTUIColorFromSharedColor(newStyle.h3.color);
      [config setH3Color:h3Color];
    } else {
      [config setH3Color:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h3.marginTop != oldStyle.h3.marginTop) {
    [config setH3MarginTop:newStyle.h3.marginTop];
    changed = YES;
  }

  if (newStyle.h3.marginBottom != oldStyle.h3.marginBottom) {
    [config setH3MarginBottom:newStyle.h3.marginBottom];
    changed = YES;
  }

  if (newStyle.h3.lineHeight != oldStyle.h3.lineHeight) {
    [config setH3LineHeight:newStyle.h3.lineHeight];
    changed = YES;
  }

  if (newStyle.h3.textAlign != oldStyle.h3.textAlign) {
    [config setH3TextAlign:textAlignmentFromString(@(newStyle.h3.textAlign.c_str()))];
    changed = YES;
  }

  // ── H4 ─────────────────────────────────────────────────────────────────────

  if (newStyle.h4.fontSize != oldStyle.h4.fontSize) {
    [config setH4FontSize:newStyle.h4.fontSize];
    changed = YES;
  }

  if (newStyle.h4.fontFamily != oldStyle.h4.fontFamily) {
    if (!newStyle.h4.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.h4.fontFamily.c_str()];
      [config setH4FontFamily:fontFamily];
    } else {
      [config setH4FontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h4.fontWeight != oldStyle.h4.fontWeight) {
    if (!newStyle.h4.fontWeight.empty()) {
      NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.h4.fontWeight.c_str()];
      [config setH4FontWeight:fontWeight];
    } else {
      [config setH4FontWeight:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h4.color != oldStyle.h4.color) {
    if (newStyle.h4.color) {
      RCTUIColor *h4Color = RCTUIColorFromSharedColor(newStyle.h4.color);
      [config setH4Color:h4Color];
    } else {
      [config setH4Color:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h4.marginTop != oldStyle.h4.marginTop) {
    [config setH4MarginTop:newStyle.h4.marginTop];
    changed = YES;
  }

  if (newStyle.h4.marginBottom != oldStyle.h4.marginBottom) {
    [config setH4MarginBottom:newStyle.h4.marginBottom];
    changed = YES;
  }

  if (newStyle.h4.lineHeight != oldStyle.h4.lineHeight) {
    [config setH4LineHeight:newStyle.h4.lineHeight];
    changed = YES;
  }

  if (newStyle.h4.textAlign != oldStyle.h4.textAlign) {
    [config setH4TextAlign:textAlignmentFromString(@(newStyle.h4.textAlign.c_str()))];
    changed = YES;
  }

  // ── H5 ─────────────────────────────────────────────────────────────────────

  if (newStyle.h5.fontSize != oldStyle.h5.fontSize) {
    [config setH5FontSize:newStyle.h5.fontSize];
    changed = YES;
  }

  if (newStyle.h5.fontFamily != oldStyle.h5.fontFamily) {
    if (!newStyle.h5.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.h5.fontFamily.c_str()];
      [config setH5FontFamily:fontFamily];
    } else {
      [config setH5FontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h5.fontWeight != oldStyle.h5.fontWeight) {
    if (!newStyle.h5.fontWeight.empty()) {
      NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.h5.fontWeight.c_str()];
      [config setH5FontWeight:fontWeight];
    } else {
      [config setH5FontWeight:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h5.color != oldStyle.h5.color) {
    if (newStyle.h5.color) {
      RCTUIColor *h5Color = RCTUIColorFromSharedColor(newStyle.h5.color);
      [config setH5Color:h5Color];
    } else {
      [config setH5Color:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h5.marginTop != oldStyle.h5.marginTop) {
    [config setH5MarginTop:newStyle.h5.marginTop];
    changed = YES;
  }

  if (newStyle.h5.marginBottom != oldStyle.h5.marginBottom) {
    [config setH5MarginBottom:newStyle.h5.marginBottom];
    changed = YES;
  }

  if (newStyle.h5.lineHeight != oldStyle.h5.lineHeight) {
    [config setH5LineHeight:newStyle.h5.lineHeight];
    changed = YES;
  }

  if (newStyle.h5.textAlign != oldStyle.h5.textAlign) {
    [config setH5TextAlign:textAlignmentFromString(@(newStyle.h5.textAlign.c_str()))];
    changed = YES;
  }

  // ── H6 ─────────────────────────────────────────────────────────────────────

  if (newStyle.h6.fontSize != oldStyle.h6.fontSize) {
    [config setH6FontSize:newStyle.h6.fontSize];
    changed = YES;
  }

  if (newStyle.h6.fontFamily != oldStyle.h6.fontFamily) {
    if (!newStyle.h6.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.h6.fontFamily.c_str()];
      [config setH6FontFamily:fontFamily];
    } else {
      [config setH6FontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h6.fontWeight != oldStyle.h6.fontWeight) {
    if (!newStyle.h6.fontWeight.empty()) {
      NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.h6.fontWeight.c_str()];
      [config setH6FontWeight:fontWeight];
    } else {
      [config setH6FontWeight:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h6.color != oldStyle.h6.color) {
    if (newStyle.h6.color) {
      RCTUIColor *h6Color = RCTUIColorFromSharedColor(newStyle.h6.color);
      [config setH6Color:h6Color];
    } else {
      [config setH6Color:nullptr];
    }
    changed = YES;
  }

  if (newStyle.h6.marginTop != oldStyle.h6.marginTop) {
    [config setH6MarginTop:newStyle.h6.marginTop];
    changed = YES;
  }

  if (newStyle.h6.marginBottom != oldStyle.h6.marginBottom) {
    [config setH6MarginBottom:newStyle.h6.marginBottom];
    changed = YES;
  }

  if (newStyle.h6.lineHeight != oldStyle.h6.lineHeight) {
    [config setH6LineHeight:newStyle.h6.lineHeight];
    changed = YES;
  }

  if (newStyle.h6.textAlign != oldStyle.h6.textAlign) {
    [config setH6TextAlign:textAlignmentFromString(@(newStyle.h6.textAlign.c_str()))];
    changed = YES;
  }

  // ── Blockquote ─────────────────────────────────────────────────────────────

  if (newStyle.blockquote.fontSize != oldStyle.blockquote.fontSize) {
    [config setBlockquoteFontSize:newStyle.blockquote.fontSize];
    changed = YES;
  }

  if (newStyle.blockquote.fontFamily != oldStyle.blockquote.fontFamily) {
    NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.blockquote.fontFamily.c_str()];
    [config setBlockquoteFontFamily:fontFamily];
    changed = YES;
  }

  if (newStyle.blockquote.fontWeight != oldStyle.blockquote.fontWeight) {
    NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.blockquote.fontWeight.c_str()];
    [config setBlockquoteFontWeight:fontWeight];
    changed = YES;
  }

  if (newStyle.blockquote.color != oldStyle.blockquote.color) {
    RCTUIColor *blockquoteColor = RCTUIColorFromSharedColor(newStyle.blockquote.color);
    [config setBlockquoteColor:blockquoteColor];
    changed = YES;
  }

  if (newStyle.blockquote.marginTop != oldStyle.blockquote.marginTop) {
    [config setBlockquoteMarginTop:newStyle.blockquote.marginTop];
    changed = YES;
  }

  if (newStyle.blockquote.marginBottom != oldStyle.blockquote.marginBottom) {
    [config setBlockquoteMarginBottom:newStyle.blockquote.marginBottom];
    changed = YES;
  }

  if (newStyle.blockquote.lineHeight != oldStyle.blockquote.lineHeight) {
    [config setBlockquoteLineHeight:newStyle.blockquote.lineHeight];
    changed = YES;
  }

  if (newStyle.blockquote.borderColor != oldStyle.blockquote.borderColor) {
    RCTUIColor *blockquoteBorderColor = RCTUIColorFromSharedColor(newStyle.blockquote.borderColor);
    [config setBlockquoteBorderColor:blockquoteBorderColor];
    changed = YES;
  }

  if (newStyle.blockquote.borderWidth != oldStyle.blockquote.borderWidth) {
    [config setBlockquoteBorderWidth:newStyle.blockquote.borderWidth];
    changed = YES;
  }

  if (newStyle.blockquote.gapWidth != oldStyle.blockquote.gapWidth) {
    [config setBlockquoteGapWidth:newStyle.blockquote.gapWidth];
    changed = YES;
  }

  if (newStyle.blockquote.backgroundColor != oldStyle.blockquote.backgroundColor) {
    RCTUIColor *blockquoteBackgroundColor = RCTUIColorFromSharedColor(newStyle.blockquote.backgroundColor);
    [config setBlockquoteBackgroundColor:blockquoteBackgroundColor];
    changed = YES;
  }

  if (newStyle.blockquote.borderRadius != oldStyle.blockquote.borderRadius) {
    [config setBlockquoteBorderRadius:newStyle.blockquote.borderRadius];
    changed = YES;
  }

  if (newStyle.blockquote.padding != oldStyle.blockquote.padding) {
    [config setBlockquotePadding:newStyle.blockquote.padding];
    changed = YES;
  }

  const auto &newAdm = newStyle.blockquote.admonitions;
  const auto &oldAdm = oldStyle.blockquote.admonitions;
  BOOL admonitionsChanged =
      newAdm.note.color != oldAdm.note.color || newAdm.note.backgroundColor != oldAdm.note.backgroundColor ||
      newAdm.tip.color != oldAdm.tip.color || newAdm.tip.backgroundColor != oldAdm.tip.backgroundColor ||
      newAdm.important.color != oldAdm.important.color ||
      newAdm.important.backgroundColor != oldAdm.important.backgroundColor ||
      newAdm.warning.color != oldAdm.warning.color ||
      newAdm.warning.backgroundColor != oldAdm.warning.backgroundColor ||
      newAdm.caution.color != oldAdm.caution.color || newAdm.caution.backgroundColor != oldAdm.caution.backgroundColor;
  if (admonitionsChanged) {
    RCTUIColor *clear = [RCTUIColor clearColor];
    NSDictionary<NSString *, RCTUIColor *> *admonitionColors = @{
      @"note" : RCTUIColorFromSharedColor(newAdm.note.color) ?: clear,
      @"tip" : RCTUIColorFromSharedColor(newAdm.tip.color) ?: clear,
      @"important" : RCTUIColorFromSharedColor(newAdm.important.color) ?: clear,
      @"warning" : RCTUIColorFromSharedColor(newAdm.warning.color) ?: clear,
      @"caution" : RCTUIColorFromSharedColor(newAdm.caution.color) ?: clear,
    };
    NSDictionary<NSString *, RCTUIColor *> *admonitionBackgroundColors = @{
      @"note" : RCTUIColorFromSharedColor(newAdm.note.backgroundColor) ?: clear,
      @"tip" : RCTUIColorFromSharedColor(newAdm.tip.backgroundColor) ?: clear,
      @"important" : RCTUIColorFromSharedColor(newAdm.important.backgroundColor) ?: clear,
      @"warning" : RCTUIColorFromSharedColor(newAdm.warning.backgroundColor) ?: clear,
      @"caution" : RCTUIColorFromSharedColor(newAdm.caution.backgroundColor) ?: clear,
    };
    [config setAdmonitionColors:admonitionColors backgroundColors:admonitionBackgroundColors];
    changed = YES;
  }

  // ── Link ───────────────────────────────────────────────────────────────────

  if (newStyle.link.fontFamily != oldStyle.link.fontFamily) {
    if (!newStyle.link.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.link.fontFamily.c_str()];
      [config setLinkFontFamily:fontFamily];
    } else {
      [config setLinkFontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.link.color != oldStyle.link.color) {
    RCTUIColor *linkColor = RCTUIColorFromSharedColor(newStyle.link.color);
    [config setLinkColor:linkColor];
    changed = YES;
  }

  {
    BOOL newUnderline = newStyle.link.underline ? YES : NO;
    if (newStyle.link.underline != oldStyle.link.underline || [config linkUnderline] != newUnderline) {
      [config setLinkUnderline:newUnderline];
      changed = YES;
    }
  }

  if (newStyle.link.backgroundColor != oldStyle.link.backgroundColor) {
    RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.link.backgroundColor);
    [config setLinkBackgroundColor:CGColorGetAlpha(color.CGColor) > 0 ? color : nil];
    changed = YES;
  }

  {
    BOOL linkVariantsChanged = newStyle.linkVariants.size() != oldStyle.linkVariants.size();
    if (!linkVariantsChanged) {
      for (size_t i = 0; i < newStyle.linkVariants.size(); i++) {
        const auto &newVariant = newStyle.linkVariants[i];
        const auto &oldVariant = oldStyle.linkVariants[i];
        if (newVariant.pattern != oldVariant.pattern || newVariant.color != oldVariant.color ||
            newVariant.underline != oldVariant.underline || newVariant.backgroundColor != oldVariant.backgroundColor ||
            newVariant.fontFamily != oldVariant.fontFamily || newVariant.pill.enabled != oldVariant.pill.enabled ||
            newVariant.pill.label != oldVariant.pill.label || newVariant.pill.iconUri != oldVariant.pill.iconUri ||
            newVariant.pill.iconTintColor != oldVariant.pill.iconTintColor ||
            newVariant.pill.borderRadius != oldVariant.pill.borderRadius ||
            newVariant.pill.paddingHorizontal != oldVariant.pill.paddingHorizontal ||
            newVariant.pill.paddingVertical != oldVariant.pill.paddingVertical ||
            newVariant.pill.lineHeight != oldVariant.pill.lineHeight ||
            newVariant.pill.borderWidth != oldVariant.pill.borderWidth ||
            newVariant.pill.borderColor != oldVariant.pill.borderColor ||
            newVariant.pill.maxWidth != oldVariant.pill.maxWidth) {
          linkVariantsChanged = YES;
          break;
        }
      }
    }
    if (linkVariantsChanged) {
      NSMutableArray<LinkVariantConfig *> *variants = [NSMutableArray array];
      for (const auto &entry : newStyle.linkVariants) {
        LinkVariantConfig *variant = [[LinkVariantConfig alloc] init];
        variant.pattern = [[NSString alloc] initWithUTF8String:entry.pattern.c_str()];
        variant.color = RCTUIColorFromSharedColor(entry.color);
        variant.underline = entry.underline;
        variant.fontFamily = [[NSString alloc] initWithUTF8String:entry.fontFamily.c_str()];
        if (entry.pill.enabled) {
          LinkPillConfig *pill = [[LinkPillConfig alloc] init];
          pill.label = [[NSString alloc] initWithUTF8String:entry.pill.label.c_str()];
          pill.iconUri = [[NSString alloc] initWithUTF8String:entry.pill.iconUri.c_str()];
          pill.iconTintColor = entry.pill.iconTintColor ? RCTUIColorFromSharedColor(entry.pill.iconTintColor) : nil;
          pill.borderRadius = entry.pill.borderRadius;
          pill.paddingHorizontal = entry.pill.paddingHorizontal;
          pill.paddingVertical = entry.pill.paddingVertical;
          pill.lineHeight = entry.pill.lineHeight;
          pill.borderWidth = entry.pill.borderWidth;
          pill.borderColor = RCTUIColorFromSharedColor(entry.pill.borderColor);
          pill.maxWidth = entry.pill.maxWidth;
          variant.pill = pill;
        }
        RCTUIColor *backgroundColor = RCTUIColorFromSharedColor(entry.backgroundColor);
        variant.backgroundColor = CGColorGetAlpha(backgroundColor.CGColor) > 0 ? backgroundColor : nil;
        [variants addObject:variant];
      }
      [config setLinkVariants:variants];
      changed = YES;
    }
  }

  // ── Strong ─────────────────────────────────────────────────────────────────

  if (newStyle.strong.fontFamily != oldStyle.strong.fontFamily) {
    if (!newStyle.strong.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.strong.fontFamily.c_str()];
      [config setStrongFontFamily:fontFamily];
    } else {
      [config setStrongFontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.strong.fontWeight != oldStyle.strong.fontWeight) {
    if (!newStyle.strong.fontWeight.empty()) {
      NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.strong.fontWeight.c_str()];
      [config setStrongFontWeight:fontWeight];
    } else {
      [config setStrongFontWeight:nullptr];
    }
    changed = YES;
  }

  if (newStyle.strong.color != oldStyle.strong.color) {
    if (newStyle.strong.color) {
      RCTUIColor *strongColor = RCTUIColorFromSharedColor(newStyle.strong.color);
      [config setStrongColor:strongColor];
    } else {
      [config setStrongColor:nullptr];
    }
    changed = YES;
  }

  // ── Emphasis ───────────────────────────────────────────────────────────────

  if (newStyle.em.fontFamily != oldStyle.em.fontFamily) {
    if (!newStyle.em.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.em.fontFamily.c_str()];
      [config setEmphasisFontFamily:fontFamily];
    } else {
      [config setEmphasisFontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.em.fontStyle != oldStyle.em.fontStyle) {
    if (!newStyle.em.fontStyle.empty()) {
      NSString *fontStyle = [[NSString alloc] initWithUTF8String:newStyle.em.fontStyle.c_str()];
      [config setEmphasisFontStyle:fontStyle];
    } else {
      [config setEmphasisFontStyle:nullptr];
    }
    changed = YES;
  }

  if (newStyle.em.color != oldStyle.em.color) {
    if (newStyle.em.color) {
      RCTUIColor *emphasisColor = RCTUIColorFromSharedColor(newStyle.em.color);
      [config setEmphasisColor:emphasisColor];
    } else {
      [config setEmphasisColor:nullptr];
    }
    changed = YES;
  }

  // ── Strikethrough ──────────────────────────────────────────────────────────

  if (newStyle.strikethrough.color != oldStyle.strikethrough.color) {
    RCTUIColor *strikethroughColor = RCTUIColorFromSharedColor(newStyle.strikethrough.color);
    [config setStrikethroughColor:strikethroughColor];
    changed = YES;
  }

  // ── Highlight ──────────────────────────────────────────────────────────────

  if (newStyle.highlight.color != oldStyle.highlight.color) {
    RCTUIColor *highlightColor = RCTUIColorFromSharedColor(newStyle.highlight.color);
    [config setHighlightColor:highlightColor];
    changed = YES;
  }

  if (newStyle.highlight.backgroundColor != oldStyle.highlight.backgroundColor) {
    RCTUIColor *highlightBackgroundColor = RCTUIColorFromSharedColor(newStyle.highlight.backgroundColor);
    [config setHighlightBackgroundColor:highlightBackgroundColor];
    changed = YES;
  }

  // ── Underline ──────────────────────────────────────────────────────────────

  if (newStyle.underline.color != oldStyle.underline.color) {
    RCTUIColor *underlineColor = RCTUIColorFromSharedColor(newStyle.underline.color);
    [config setUnderlineColor:underlineColor];
    changed = YES;
  }

  // ── Code ───────────────────────────────────────────────────────────────────

  if (newStyle.code.fontFamily != oldStyle.code.fontFamily) {
    if (!newStyle.code.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.code.fontFamily.c_str()];
      [config setCodeFontFamily:fontFamily];
    } else {
      [config setCodeFontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.code.fontScale != oldStyle.code.fontScale) {
    [config setCodeFontScale:newStyle.code.fontScale];
    changed = YES;
  }

  if (newStyle.code.fontSize != oldStyle.code.fontSize) {
    [config setCodeFontSize:newStyle.code.fontSize];
    changed = YES;
  }

  if (newStyle.code.color != oldStyle.code.color) {
    if (newStyle.code.color) {
      RCTUIColor *codeColor = RCTUIColorFromSharedColor(newStyle.code.color);
      [config setCodeColor:codeColor];
    } else {
      [config setCodeColor:nullptr];
    }
    changed = YES;
  }

  if (newStyle.code.backgroundColor != oldStyle.code.backgroundColor) {
    if (newStyle.code.backgroundColor) {
      RCTUIColor *codeBackgroundColor = RCTUIColorFromSharedColor(newStyle.code.backgroundColor);
      [config setCodeBackgroundColor:codeBackgroundColor];
    } else {
      [config setCodeBackgroundColor:nullptr];
    }
    changed = YES;
  }

  if (newStyle.code.borderColor != oldStyle.code.borderColor) {
    if (newStyle.code.borderColor) {
      RCTUIColor *codeBorderColor = RCTUIColorFromSharedColor(newStyle.code.borderColor);
      [config setCodeBorderColor:codeBorderColor];
    } else {
      [config setCodeBorderColor:nullptr];
    }
    changed = YES;
  }

  // ── Image ──────────────────────────────────────────────────────────────────

  if (newStyle.image.height != oldStyle.image.height) {
    [config setImageHeight:newStyle.image.height];
    changed = YES;
  }

  if (newStyle.image.maxHeight != oldStyle.image.maxHeight) {
    [config setImageMaxHeight:newStyle.image.maxHeight];
    changed = YES;
  }

  if (newStyle.image.aspectRatio != oldStyle.image.aspectRatio) {
    [config setImageAspectRatio:newStyle.image.aspectRatio];
    changed = YES;
  }

  if (newStyle.image.resizeMode != oldStyle.image.resizeMode) {
    [config setImageResizeMode:@(newStyle.image.resizeMode.c_str())];
    changed = YES;
  }

  if (newStyle.image.borderRadius != oldStyle.image.borderRadius) {
    [config setImageBorderRadius:newStyle.image.borderRadius];
    changed = YES;
  }

  if (newStyle.image.marginTop != oldStyle.image.marginTop) {
    [config setImageMarginTop:newStyle.image.marginTop];
    changed = YES;
  }

  if (newStyle.image.marginBottom != oldStyle.image.marginBottom) {
    [config setImageMarginBottom:newStyle.image.marginBottom];
    changed = YES;
  }

  // ── Video ───────────────────────────────────────────────────────────────────

  if (newStyle.video.marginTop != oldStyle.video.marginTop) {
    [config setVideoMarginTop:newStyle.video.marginTop];
    changed = YES;
  }

  if (newStyle.video.marginBottom != oldStyle.video.marginBottom) {
    [config setVideoMarginBottom:newStyle.video.marginBottom];
    changed = YES;
  }

  if (newStyle.video.borderRadius != oldStyle.video.borderRadius) {
    [config setVideoBorderRadius:newStyle.video.borderRadius];
    changed = YES;
  }

  if (newStyle.video.aspectRatio != oldStyle.video.aspectRatio) {
    [config setVideoAspectRatio:newStyle.video.aspectRatio];
    changed = YES;
  }

  if (newStyle.video.backgroundColor != oldStyle.video.backgroundColor) {
    [config setVideoBackgroundColor:RCTUIColorFromSharedColor(newStyle.video.backgroundColor)];
    changed = YES;
  }

  // ── Inline Image ───────────────────────────────────────────────────────────

  if (newStyle.inlineImage.size != oldStyle.inlineImage.size) {
    [config setInlineImageSize:newStyle.inlineImage.size];
    changed = YES;
  }

  // ── List ───────────────────────────────────────────────────────────────────

  if (newStyle.list.fontSize != oldStyle.list.fontSize) {
    [config setListStyleFontSize:newStyle.list.fontSize];
    changed = YES;
  }

  if (newStyle.list.fontFamily != oldStyle.list.fontFamily) {
    NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.list.fontFamily.c_str()];
    [config setListStyleFontFamily:fontFamily];
    changed = YES;
  }

  if (newStyle.list.fontWeight != oldStyle.list.fontWeight) {
    NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.list.fontWeight.c_str()];
    [config setListStyleFontWeight:fontWeight];
    changed = YES;
  }

  if (newStyle.list.color != oldStyle.list.color) {
    RCTUIColor *listColor = RCTUIColorFromSharedColor(newStyle.list.color);
    [config setListStyleColor:listColor];
    changed = YES;
  }

  if (newStyle.list.marginTop != oldStyle.list.marginTop) {
    [config setListStyleMarginTop:newStyle.list.marginTop];
    changed = YES;
  }

  if (newStyle.list.marginBottom != oldStyle.list.marginBottom) {
    [config setListStyleMarginBottom:newStyle.list.marginBottom];
    changed = YES;
  }

  if (newStyle.list.lineHeight != oldStyle.list.lineHeight) {
    [config setListStyleLineHeight:newStyle.list.lineHeight];
    changed = YES;
  }

  if (newStyle.list.bulletColor != oldStyle.list.bulletColor) {
    RCTUIColor *bulletColor = RCTUIColorFromSharedColor(newStyle.list.bulletColor);
    [config setListStyleBulletColor:bulletColor];
    changed = YES;
  }

  if (newStyle.list.bulletSize != oldStyle.list.bulletSize) {
    [config setListStyleBulletSize:newStyle.list.bulletSize];
    changed = YES;
  }

  if (newStyle.list.markerMinWidth != oldStyle.list.markerMinWidth) {
    [config setListStyleMarkerMinWidth:newStyle.list.markerMinWidth];
    changed = YES;
  }

  if (newStyle.list.markerColor != oldStyle.list.markerColor) {
    RCTUIColor *markerColor = RCTUIColorFromSharedColor(newStyle.list.markerColor);
    [config setListStyleMarkerColor:markerColor];
    changed = YES;
  }

  if (newStyle.list.markerFontWeight != oldStyle.list.markerFontWeight) {
    NSString *markerFontWeight = [[NSString alloc] initWithUTF8String:newStyle.list.markerFontWeight.c_str()];
    [config setListStyleMarkerFontWeight:markerFontWeight];
    changed = YES;
  }

  if (newStyle.list.gapWidth != oldStyle.list.gapWidth) {
    [config setListStyleGapWidth:newStyle.list.gapWidth];
    changed = YES;
  }

  if (newStyle.list.marginLeft != oldStyle.list.marginLeft) {
    [config setListStyleMarginLeft:newStyle.list.marginLeft];
    changed = YES;
  }

  if (newStyle.list.itemSpacing != oldStyle.list.itemSpacing) {
    [config setListStyleItemSpacing:newStyle.list.itemSpacing];
    changed = YES;
  }

  // ── Code Block ─────────────────────────────────────────────────────────────

  if (newStyle.codeBlock.fontSize != oldStyle.codeBlock.fontSize) {
    [config setCodeBlockFontSize:newStyle.codeBlock.fontSize];
    changed = YES;
  }

  if (newStyle.codeBlock.fontFamily != oldStyle.codeBlock.fontFamily) {
    NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.codeBlock.fontFamily.c_str()];
    [config setCodeBlockFontFamily:fontFamily];
    changed = YES;
  }

  if (newStyle.codeBlock.fontWeight != oldStyle.codeBlock.fontWeight) {
    NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.codeBlock.fontWeight.c_str()];
    [config setCodeBlockFontWeight:fontWeight];
    changed = YES;
  }

  if (newStyle.codeBlock.color != oldStyle.codeBlock.color) {
    RCTUIColor *codeBlockColor = RCTUIColorFromSharedColor(newStyle.codeBlock.color);
    [config setCodeBlockColor:codeBlockColor];
    changed = YES;
  }

  if (newStyle.codeBlock.marginTop != oldStyle.codeBlock.marginTop) {
    [config setCodeBlockMarginTop:newStyle.codeBlock.marginTop];
    changed = YES;
  }

  if (newStyle.codeBlock.marginBottom != oldStyle.codeBlock.marginBottom) {
    [config setCodeBlockMarginBottom:newStyle.codeBlock.marginBottom];
    changed = YES;
  }

  if (newStyle.codeBlock.lineHeight != oldStyle.codeBlock.lineHeight) {
    [config setCodeBlockLineHeight:newStyle.codeBlock.lineHeight];
    changed = YES;
  }

  if (newStyle.codeBlock.backgroundColor != oldStyle.codeBlock.backgroundColor) {
    RCTUIColor *codeBlockBackgroundColor = RCTUIColorFromSharedColor(newStyle.codeBlock.backgroundColor);
    [config setCodeBlockBackgroundColor:codeBlockBackgroundColor];
    changed = YES;
  }

  if (newStyle.codeBlock.borderColor != oldStyle.codeBlock.borderColor) {
    RCTUIColor *codeBlockBorderColor = RCTUIColorFromSharedColor(newStyle.codeBlock.borderColor);
    [config setCodeBlockBorderColor:codeBlockBorderColor];
    changed = YES;
  }

  if (newStyle.codeBlock.borderRadius != oldStyle.codeBlock.borderRadius) {
    [config setCodeBlockBorderRadius:newStyle.codeBlock.borderRadius];
    changed = YES;
  }

  if (newStyle.codeBlock.borderWidth != oldStyle.codeBlock.borderWidth) {
    [config setCodeBlockBorderWidth:newStyle.codeBlock.borderWidth];
    changed = YES;
  }

  if (newStyle.codeBlock.padding != oldStyle.codeBlock.padding) {
    [config setCodeBlockPadding:newStyle.codeBlock.padding];
    changed = YES;
  }

#define ENRM_SET_SYNTAX_COLOR(field, token)                                                                            \
  if (newStyle.codeBlock.syntaxColors.field != oldStyle.codeBlock.syntaxColors.field) {                                \
    [config setCodeBlockSyntaxColor:RCTUIColorFromSharedColor(newStyle.codeBlock.syntaxColors.field)                   \
                           forToken:(NSInteger)Markdown::HighlightTokenType::token];                                   \
    changed = YES;                                                                                                     \
  }
  ENRM_SET_SYNTAX_COLOR(keyword, Keyword)
  ENRM_SET_SYNTAX_COLOR(operatorColor, Operator)
  ENRM_SET_SYNTAX_COLOR(punctuation, Punctuation)
  ENRM_SET_SYNTAX_COLOR(string, String)
  ENRM_SET_SYNTAX_COLOR(number, Number)
  ENRM_SET_SYNTAX_COLOR(constant, Constant)
  ENRM_SET_SYNTAX_COLOR(comment, Comment)
  ENRM_SET_SYNTAX_COLOR(function, Function)
  ENRM_SET_SYNTAX_COLOR(type, Type)
  ENRM_SET_SYNTAX_COLOR(variable, Variable)
  ENRM_SET_SYNTAX_COLOR(property, Property)
  ENRM_SET_SYNTAX_COLOR(tag, Tag)
  ENRM_SET_SYNTAX_COLOR(attribute, Attribute)
  ENRM_SET_SYNTAX_COLOR(embedded, Embedded)
#undef ENRM_SET_SYNTAX_COLOR

  // ── Thematic Break ─────────────────────────────────────────────────────────

  if (newStyle.thematicBreak.color != oldStyle.thematicBreak.color) {
    RCTUIColor *thematicBreakColor = RCTUIColorFromSharedColor(newStyle.thematicBreak.color);
    [config setThematicBreakColor:thematicBreakColor];
    changed = YES;
  }

  if (newStyle.thematicBreak.height != oldStyle.thematicBreak.height) {
    [config setThematicBreakHeight:newStyle.thematicBreak.height];
    changed = YES;
  }

  if (newStyle.thematicBreak.marginTop != oldStyle.thematicBreak.marginTop) {
    [config setThematicBreakMarginTop:newStyle.thematicBreak.marginTop];
    changed = YES;
  }

  if (newStyle.thematicBreak.marginBottom != oldStyle.thematicBreak.marginBottom) {
    [config setThematicBreakMarginBottom:newStyle.thematicBreak.marginBottom];
    changed = YES;
  }

  // ── Table ───────────────────────────────────────────────────────────────────

  if (newStyle.table.fontSize != oldStyle.table.fontSize) {
    [config setTableFontSize:newStyle.table.fontSize];
    changed = YES;
  }

  if (newStyle.table.fontFamily != oldStyle.table.fontFamily) {
    if (!newStyle.table.fontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.table.fontFamily.c_str()];
      [config setTableFontFamily:fontFamily];
    } else {
      [config setTableFontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.table.fontWeight != oldStyle.table.fontWeight) {
    if (!newStyle.table.fontWeight.empty()) {
      NSString *fontWeight = [[NSString alloc] initWithUTF8String:newStyle.table.fontWeight.c_str()];
      [config setTableFontWeight:fontWeight];
    } else {
      [config setTableFontWeight:nullptr];
    }
    changed = YES;
  }

  if (newStyle.table.color != oldStyle.table.color) {
    if (newStyle.table.color) {
      RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.table.color);
      [config setTableColor:color];
    } else {
      [config setTableColor:nullptr];
    }
    changed = YES;
  }

  if (newStyle.table.marginTop != oldStyle.table.marginTop) {
    [config setTableMarginTop:newStyle.table.marginTop];
    changed = YES;
  }

  if (newStyle.table.marginBottom != oldStyle.table.marginBottom) {
    [config setTableMarginBottom:newStyle.table.marginBottom];
    changed = YES;
  }

  if (newStyle.table.lineHeight != oldStyle.table.lineHeight) {
    [config setTableLineHeight:newStyle.table.lineHeight];
    changed = YES;
  }

  if (newStyle.table.headerFontFamily != oldStyle.table.headerFontFamily) {
    if (!newStyle.table.headerFontFamily.empty()) {
      NSString *fontFamily = [[NSString alloc] initWithUTF8String:newStyle.table.headerFontFamily.c_str()];
      [config setTableHeaderFontFamily:fontFamily];
    } else {
      [config setTableHeaderFontFamily:nullptr];
    }
    changed = YES;
  }

  if (newStyle.table.headerBackgroundColor != oldStyle.table.headerBackgroundColor) {
    RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.table.headerBackgroundColor);
    [config setTableHeaderBackgroundColor:color];
    changed = YES;
  }

  if (newStyle.table.headerTextColor != oldStyle.table.headerTextColor) {
    RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.table.headerTextColor);
    [config setTableHeaderTextColor:color];
    changed = YES;
  }

  if (newStyle.table.rowEvenBackgroundColor != oldStyle.table.rowEvenBackgroundColor) {
    RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.table.rowEvenBackgroundColor);
    [config setTableRowEvenBackgroundColor:color];
    changed = YES;
  }

  if (newStyle.table.rowOddBackgroundColor != oldStyle.table.rowOddBackgroundColor) {
    RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.table.rowOddBackgroundColor);
    [config setTableRowOddBackgroundColor:color];
    changed = YES;
  }

  if (newStyle.table.borderColor != oldStyle.table.borderColor) {
    RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.table.borderColor);
    [config setTableBorderColor:color];
    changed = YES;
  }

  if (newStyle.table.borderWidth != oldStyle.table.borderWidth) {
    [config setTableBorderWidth:newStyle.table.borderWidth];
    changed = YES;
  }

  if (newStyle.table.borderRadius != oldStyle.table.borderRadius) {
    [config setTableBorderRadius:newStyle.table.borderRadius];
    changed = YES;
  }

  if (newStyle.table.cellPaddingHorizontal != oldStyle.table.cellPaddingHorizontal) {
    [config setTableCellPaddingHorizontal:newStyle.table.cellPaddingHorizontal];
    changed = YES;
  }

  if (newStyle.table.cellPaddingVertical != oldStyle.table.cellPaddingVertical) {
    [config setTableCellPaddingVertical:newStyle.table.cellPaddingVertical];
    changed = YES;
  }

  if (newStyle.table.horizontalOverflow != oldStyle.table.horizontalOverflow) {
    [config setTableHorizontalOverflow:newStyle.table.horizontalOverflow];
    changed = YES;
  }

  if (newStyle.table.align != oldStyle.table.align) {
    [config setTableAlign:@(newStyle.table.align.c_str())];
    changed = YES;
  }

  // ── Task List ───────────────────────────────────────────────────────────────

  if (newStyle.taskList.checkedColor != oldStyle.taskList.checkedColor) {
    RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.taskList.checkedColor);
    [config setTaskListCheckedColor:color];
    changed = YES;
  }

  if (newStyle.taskList.borderColor != oldStyle.taskList.borderColor) {
    RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.taskList.borderColor);
    [config setTaskListBorderColor:color];
    changed = YES;
  }

  if (newStyle.taskList.checkboxSize != oldStyle.taskList.checkboxSize) {
    [config setTaskListCheckboxSize:newStyle.taskList.checkboxSize];
    changed = YES;
  }

  if (newStyle.taskList.checkboxBorderRadius != oldStyle.taskList.checkboxBorderRadius) {
    [config setTaskListCheckboxBorderRadius:newStyle.taskList.checkboxBorderRadius];
    changed = YES;
  }

  if (newStyle.taskList.checkmarkColor != oldStyle.taskList.checkmarkColor) {
    RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.taskList.checkmarkColor);
    [config setTaskListCheckmarkColor:color];
    changed = YES;
  }

  if (newStyle.taskList.checkedTextColor != oldStyle.taskList.checkedTextColor) {
    if (newStyle.taskList.checkedTextColor) {
      RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.taskList.checkedTextColor);
      [config setTaskListCheckedTextColor:color];
    } else {
      [config setTaskListCheckedTextColor:nullptr];
    }
    changed = YES;
  }

  if (newStyle.taskList.checkedStrikethrough != oldStyle.taskList.checkedStrikethrough) {
    [config setTaskListCheckedStrikethrough:newStyle.taskList.checkedStrikethrough];
    changed = YES;
  }

  // ── Math ───────────────────────────────────────────────────────────────────

  if (newStyle.math.fontSize != oldStyle.math.fontSize) {
    [config setMathFontSize:newStyle.math.fontSize];
    changed = YES;
  }

  if (newStyle.math.color != oldStyle.math.color) {
    if (newStyle.math.color) {
      RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.math.color);
      [config setMathColor:color];
    } else {
      [config setMathColor:nullptr];
    }
    changed = YES;
  }

  if (newStyle.math.backgroundColor != oldStyle.math.backgroundColor) {
    if (newStyle.math.backgroundColor) {
      RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.math.backgroundColor);
      [config setMathBackgroundColor:color];
    } else {
      [config setMathBackgroundColor:nullptr];
    }
    changed = YES;
  }

  if (newStyle.math.padding != oldStyle.math.padding) {
    [config setMathPadding:newStyle.math.padding];
    changed = YES;
  }

  if (newStyle.math.marginTop != oldStyle.math.marginTop) {
    [config setMathMarginTop:newStyle.math.marginTop];
    changed = YES;
  }

  if (newStyle.math.marginBottom != oldStyle.math.marginBottom) {
    [config setMathMarginBottom:newStyle.math.marginBottom];
    changed = YES;
  }

  if (newStyle.math.textAlign != oldStyle.math.textAlign) {
    [config setMathTextAlign:@(newStyle.math.textAlign.c_str())];
    changed = YES;
  }

  // ── Inline Math ───────────────────────────────────────────────────────────

  if (newStyle.inlineMath.color != oldStyle.inlineMath.color) {
    if (newStyle.inlineMath.color) {
      RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.inlineMath.color);
      [config setInlineMathColor:color];
    } else {
      [config setInlineMathColor:nullptr];
    }
    changed = YES;
  }

  // ── Spoiler ─────────────────────────────────────────────────────────────

  if (newStyle.spoiler.color != oldStyle.spoiler.color) {
    RCTUIColor *color = RCTUIColorFromSharedColor(newStyle.spoiler.color);
    [config setSpoilerColor:color];
    changed = YES;
  }

  if (newStyle.spoiler.particles.density != oldStyle.spoiler.particles.density) {
    [config setSpoilerParticleDensity:newStyle.spoiler.particles.density];
    changed = YES;
  }

  if (newStyle.spoiler.particles.speed != oldStyle.spoiler.particles.speed) {
    [config setSpoilerParticleSpeed:newStyle.spoiler.particles.speed];
    changed = YES;
  }

  if (newStyle.spoiler.solid.borderRadius != oldStyle.spoiler.solid.borderRadius) {
    [config setSpoilerSolidBorderRadius:newStyle.spoiler.solid.borderRadius];
    changed = YES;
  }

  // ── Superscript ──────────────────────────────────────────────────────────

  if (newStyle.superscript.fontScale != oldStyle.superscript.fontScale) {
    [config setSuperscriptFontScale:newStyle.superscript.fontScale];
    changed = YES;
  }

  if (newStyle.superscript.baselineOffsetScale != oldStyle.superscript.baselineOffsetScale) {
    [config setSuperscriptBaselineOffsetScale:newStyle.superscript.baselineOffsetScale];
    changed = YES;
  }

  // ── Subscript ────────────────────────────────────────────────────────────

  if (newStyle.subscript.fontScale != oldStyle.subscript.fontScale) {
    [config setSubscriptFontScale:newStyle.subscript.fontScale];
    changed = YES;
  }

  if (newStyle.subscript.baselineOffsetScale != oldStyle.subscript.baselineOffsetScale) {
    [config setSubscriptBaselineOffsetScale:newStyle.subscript.baselineOffsetScale];
    changed = YES;
  }

  return changed;
}
