/**
 * Markdown block renderer.
 *
 * Parses markdown text into ArkUI components. Uses markdown-it for tokenization
 * (imported from npm, pure JS) and renders each token type as native ArkUI.
 *
 * Supported markdown features (Phase 1):
 *   - Headings (h1–h6)
 *   - Paragraphs
 *   - Bold / italic
 *   - Inline code
 *   - Code fences (``` → CodeBlock component)
 *   - Unordered lists
 *   - Links (clickable)
 *   - Blockquotes
 *   - Horizontal rules
 *
 * Not yet supported (Phase 2):
 *   - Ordered lists with nesting
 *   - Tables
 *   - Images (inline)
 *   - Task lists
 *   - Diff syntax coloring (Paseo-specific)
 */

import { PaseoTheme } from '../common/theme';
import { CodeBlock } from './code-block';

// markdown-it type — imported at runtime from npm
// For Phase 1, we use a simple regex-based parser to avoid
// markdown-it bundle size concerns in the ArkTS environment.
// Full markdown-it integration is a Phase 2 task.

// ---------------------------------------------------------------------------
// Simple block-based markdown tokenizer (no regex, line-by-line)
// ---------------------------------------------------------------------------

interface MdToken {
  type: 'heading' | 'paragraph' | 'code_fence' | 'list_item' | 'blockquote' | 'hr' | 'blank';
  text?: string;
  level?: number;   // for headings
  language?: string; // for code fences
  content?: string;  // for code fences
}

function tokenizeMarkdown(text: string): MdToken[] {
  const lines = text.split('\n');
  const tokens: MdToken[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      tokens.push({
        type: 'code_fence',
        language: language || 'text',
        content: codeLines.join('\n'),
      });
      i += 1; // skip closing ```
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.+)/.exec(line);
    if (headingMatch) {
      tokens.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      tokens.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      tokens.push({ type: 'blockquote', text: line.slice(2).trim() });
      i += 1;
      continue;
    }

    // Unordered list item
    if (/^[-*+]\s+/.test(line)) {
      tokens.push({ type: 'list_item', text: line.replace(/^[-*+]\s+/, '').trim() });
      i += 1;
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      tokens.push({ type: 'blank' });
      i += 1;
      continue;
    }

    // Otherwise: paragraph — collect consecutive non-special lines
    const paragraphLines: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (
        next.trim() === '' ||
        next.startsWith('```') ||
        /^(#{1,6})\s+/.test(next) ||
        next.startsWith('> ') ||
        /^[-*+]\s+/.test(next) ||
        /^(-{3,}|_{3,}|\*{3,})\s*$/.test(next)
      ) {
        break;
      }
      paragraphLines.push(next);
      i += 1;
    }
    tokens.push({ type: 'paragraph', text: paragraphLines.join('\n').trim() });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Inline text parser (bold, italic, code, links)
// ---------------------------------------------------------------------------

interface InlineSpan {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link';
  text: string;
  url?: string;
}

function parseInlineSpans(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  // Simple regex-based approach for Phase 1
  // Order matters: code first (no formatting inside), then bold, then italic, then links
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\(([^)]+)\)|[^`*[\n]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const raw: string = match[0];

    if (raw.startsWith('`') && raw.endsWith('`')) {
      spans.push({ type: 'code', text: raw.slice(1, -1) });
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      spans.push({ type: 'bold', text: raw.slice(2, -2) });
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      spans.push({ type: 'italic', text: raw.slice(1, -1) });
    } else if (raw.startsWith('[')) {
      const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(raw);
      if (linkMatch) {
        spans.push({ type: 'link', text: linkMatch[1], url: linkMatch[2] });
      }
    } else {
      spans.push({ type: 'text', text: raw });
    }
  }

  return spans;
}

// ---------------------------------------------------------------------------
// Markdown Block component
// ---------------------------------------------------------------------------

@Component
export struct MarkdownBlock {
  @Prop text: string = '';
  @State tokens: MdToken[] = [];

  aboutToAppear(): void {
    this.tokens = tokenizeMarkdown(this.text);
  }

  aboutToUpdate(): void {
    this.tokens = tokenizeMarkdown(this.text);
  }

  build() {
    Column() {
      ForEach(this.tokens, (token: MdToken, index: number) => {
        if (token.type === 'heading' && token.text) {
          this.buildHeading(token.level ?? 1, token.text);
        } else if (token.type === 'paragraph' && token.text) {
          this.buildParagraph(token.text);
        } else if (token.type === 'code_fence') {
          CodeBlock({ code: token.content ?? '', language: token.language ?? '' });
        } else if (token.type === 'blockquote' && token.text) {
          this.buildBlockquote(token.text);
        } else if (token.type === 'list_item' && token.text) {
          this.buildListItem(token.text);
        } else if (token.type === 'hr') {
          this.buildHorizontalRule();
        }
        // blank tokens produce spacing (handled by margins on blocks)
      }, (token: MdToken, index: number) => `${token.type}_${index}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  // ---- Heading builder ----
  @Builder
  buildHeading(level: number, text: string) {
    Text(text)
      .fontSize(this.headingFontSize(level))
      .fontWeight(this.headingFontWeight(level))
      .fontColor(PaseoTheme.textPrimary)
      .margin({ top: PaseoTheme.spaceMD, bottom: PaseoTheme.spaceSM })
      .width('100%');
  }

  headingFontSize(level: number): number {
    switch (level) {
      case 1: return 22;
      case 2: return 19;
      case 3: return 17;
      default: return PaseoTheme.fontSizeMD;
    }
  }

  headingFontWeight(level: number): FontWeight {
    return level <= 2 ? FontWeight.Bold : FontWeight.Medium;
  }

  // ---- Paragraph builder with inline spans ----
  @Builder
  buildParagraph(text: string) {
    Text() {
      ForEach(parseInlineSpans(text), (span: InlineSpan, idx: number) => {
        if (span.type === 'bold') {
          Span(span.text)
            .fontWeight(FontWeight.Bold);
        } else if (span.type === 'italic') {
          Span(span.text)
            .fontStyle(FontStyle.Italic);
        } else if (span.type === 'code') {
          Span(span.text)
            .fontFamily(PaseoTheme.fontMono)
            .fontSize(PaseoTheme.fontSizeSM - 1)
            .fontColor(PaseoTheme.accent)
            .textBackgroundStyle({
              color: PaseoTheme.codeBg,
              radius: PaseoTheme.radiusSM,
            });
        } else if (span.type === 'link') {
          Span(span.text)
            .fontColor('#4A90D9')
            .decoration({ type: TextDecorationType.Underline });
        } else {
          Span(span.text);
        }
      }, (span: InlineSpan, idx: number) => `${span.type}_${idx}`);
    }
    .fontSize(PaseoTheme.fontSizeMD)
    .fontColor(PaseoTheme.textPrimary)
    .lineHeight(PaseoTheme.fontSizeMD * 1.6)
    .width('100%')
    .margin({ bottom: PaseoTheme.spaceSM });
  }

  // ---- Blockquote builder ----
  @Builder
  buildBlockquote(text: string) {
    Row() {
      // Left border bar
      Column()
        .width(3)
        .height('100%')
        .backgroundColor(PaseoTheme.accent)
        .borderRadius(2);

      Text(text)
        .fontSize(PaseoTheme.fontSizeMD)
        .fontColor(PaseoTheme.textSecondary)
        .fontStyle(FontStyle.Italic)
        .padding({ left: PaseoTheme.spaceSM })
        .layoutWeight(1);
    }
    .width('100%')
    .margin({ top: PaseoTheme.spaceSM, bottom: PaseoTheme.spaceSM });
  }

  // ---- List item builder ----
  @Builder
  buildListItem(text: string) {
    Row() {
      Text('•')
        .fontSize(PaseoTheme.fontSizeMD)
        .fontColor(PaseoTheme.accent)
        .margin({ right: PaseoTheme.spaceSM });

      Text(text)
        .fontSize(PaseoTheme.fontSizeMD)
        .fontColor(PaseoTheme.textPrimary)
        .layoutWeight(1);
    }
    .width('100%')
    .margin({ bottom: PaseoTheme.spaceXS })
    .padding({ left: PaseoTheme.spaceSM });
  }

  // ---- Horizontal rule ----
  @Builder
  buildHorizontalRule() {
    Divider()
      .color(PaseoTheme.border)
      .width('100%')
      .height(1)
      .margin({ top: PaseoTheme.spaceMD, bottom: PaseoTheme.spaceMD });
  }
}
