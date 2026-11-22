import type { CSSProperties, KeyboardEvent } from 'react';
import { extractNodeText, filenameFromUrl } from '../utils';
import type { RendererProps, RendererMap } from '../types';
import { toHeadingLevel } from '../styles';
import { KaTeXRenderer } from './KaTeXRenderer';
import {
  ADMONITION_ICON_PATHS,
  ADMONITION_ICON_VIEWBOX,
  ADMONITION_TITLES,
} from './admonitionIcons';
import type { AdmonitionType } from '../../admonitionDefaults';
import { ENRM_ADMONITION_CLASS } from '../globalStyles';

function ParagraphRenderer({
  node,
  styles,
  parentType,
  renderChildren,
}: RendererProps) {
  const isImageOnly =
    node.children?.length === 1 && node.children[0]?.type === 'Image';
  if (isImageOnly) return <>{renderChildren(node)}</>;

  if (parentType === 'Blockquote' || parentType === 'Admonition') {
    return <p style={styles.paragraphInBlockquote}>{renderChildren(node)}</p>;
  }

  if (parentType === 'ListItem') {
    return <span>{renderChildren(node)}</span>;
  }

  return <p style={styles.paragraph}>{renderChildren(node)}</p>;
}

function HeadingRenderer({ node, styles, renderChildren }: RendererProps) {
  const Tag = toHeadingLevel(node.attributes?.level ?? '1');
  return <Tag style={styles[Tag]}>{renderChildren(node)}</Tag>;
}

function BlockquoteRenderer({ node, styles, renderChildren }: RendererProps) {
  return (
    <blockquote style={styles.blockquote}>{renderChildren(node)}</blockquote>
  );
}

function AdmonitionRenderer({
  node,
  style,
  styles,
  renderChildren,
}: RendererProps) {
  const type = (node.attributes?.admonitionType ?? 'note') as AdmonitionType;
  const blockquote = style.blockquote;
  const colors = blockquote.admonitions[type] ?? blockquote.admonitions.note;
  const tint = colors.color;
  const iconSize = Math.ceil(blockquote.fontSize);
  // Reuse the blockquote box geometry; override the accent bar + fill per type.
  const boxStyle: CSSProperties = {
    ...styles.blockquote,
    borderInlineStart: `${blockquote.borderWidth}px solid ${tint}`,
    backgroundColor: colors.backgroundColor,
  };
  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: Math.round(iconSize * 0.4),
    marginBottom: Math.round(blockquote.fontSize * 0.4),
    color: tint,
    fontWeight: 'bold',
    fontSize: blockquote.fontSize,
    lineHeight: 1.2,
  };
  return (
    <div className={ENRM_ADMONITION_CLASS} style={boxStyle}>
      <div style={headerStyle}>
        <svg
          width={iconSize}
          height={iconSize}
          viewBox={`0 0 ${ADMONITION_ICON_VIEWBOX} ${ADMONITION_ICON_VIEWBOX}`}
          fill={tint}
          aria-hidden="true"
        >
          <path d={ADMONITION_ICON_PATHS[type]} />
        </svg>
        <span>{ADMONITION_TITLES[type]}</span>
      </div>
      {renderChildren(node)}
    </div>
  );
}

function CodeBlockRenderer({
  node,
  styles,
  renderChildren,
  callbacks,
}: RendererProps) {
  const language = node.attributes?.language;
  const label = language ? `Code block: ${language}` : 'Code block';

  if (callbacks.onCodeBlockPress == null) {
    return (
      <pre style={styles.codeBlock} aria-label={label}>
        <code style={styles.codeBlockFont}>{renderChildren(node)}</code>
      </pre>
    );
  }

  const press = () =>
    callbacks.onCodeBlockPress?.({
      code: extractNodeText(node).replace(/\n+$/, ''),
      language: language ?? '',
    });

  // Don't fire while code text is selected - selection stays separate from the tap.
  const handleClick = () => {
    const selection =
      typeof window !== 'undefined' ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) return;
    press();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLPreElement>) => {
    if (event.repeat) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      press();
    }
  };

  return (
    <pre
      style={{ ...styles.codeBlock, cursor: 'pointer' }}
      aria-label={label}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <code style={styles.codeBlockFont}>{renderChildren(node)}</code>
    </pre>
  );
}

function ThematicBreakRenderer({ styles }: RendererProps) {
  return <hr style={styles.thematicBreak} />;
}

// Each blank line in the source becomes one empty line. Rendered as a spacer
// sized to the paragraph line height (rather than a run of <br>, whose height
// would follow the container line height) so the vertical rhythm matches the
// surrounding paragraphs. Any extra block spacing is left to the caller.
function BlankLineRenderer({ node, style }: RendererProps) {
  const count = Number.parseInt(node.attributes?.count ?? '0', 10);
  const lines = Number.isFinite(count) ? Math.max(0, count) : 0;
  if (lines === 0) return null;
  return (
    <div
      aria-hidden="true"
      style={{ height: lines * style.paragraph.lineHeight }}
    />
  );
}

function ImageRenderer({ node, styles, parentType, callbacks }: RendererProps) {
  const url = node.attributes?.url;
  if (!url) return null;

  const title = node.attributes?.title;
  const markdownAlt = extractNodeText(node).trim();
  const alt = markdownAlt || title || filenameFromUrl(url) || 'Image';
  const imgStyle = node.attributes?.isInline
    ? styles.inlineImage
    : styles.image;

  const interactive =
    callbacks.onImagePress != null &&
    parentType !== 'Link' &&
    parentType !== 'TableCell' &&
    parentType !== 'TableHeaderCell';
  if (!interactive) {
    return <img src={url} alt={alt} title={title} style={imgStyle} />;
  }

  const press = () => callbacks.onImagePress?.({ url, altText: markdownAlt });
  const handleKeyDown = (event: KeyboardEvent<HTMLImageElement>) => {
    if (event.repeat) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      press();
    }
  };

  return (
    <img
      src={url}
      alt={alt}
      title={title}
      style={imgStyle}
      role="button"
      tabIndex={0}
      aria-label={alt}
      onClick={press}
      onKeyDown={handleKeyDown}
    />
  );
}

function LatexMathDisplayRenderer({
  node,
  styles,
  capabilities,
}: RendererProps) {
  const content = extractNodeText(node);

  return (
    <KaTeXRenderer
      content={content}
      katex={capabilities.katex}
      displayMode
      style={styles.mathDisplay}
    />
  );
}

function VideoRenderer({ node, styles }: RendererProps) {
  const url = node.attributes?.url;
  if (!url) return null;

  const title = node.attributes?.title;
  const alt = extractNodeText(node).trim();
  const label = alt || title || 'Video';

  return (
    <video
      controls
      playsInline
      preload="metadata"
      style={styles.video}
      title={title}
      aria-label={label}
    >
      <source src={url} />
    </video>
  );
}

export const blockRenderers: RendererMap = {
  Paragraph: ParagraphRenderer,
  Heading: HeadingRenderer,
  Blockquote: BlockquoteRenderer,
  Admonition: AdmonitionRenderer,
  CodeBlock: CodeBlockRenderer,
  ThematicBreak: ThematicBreakRenderer,
  BlankLine: BlankLineRenderer,
  Image: ImageRenderer,
  LatexMathDisplay: LatexMathDisplayRenderer,
  Video: VideoRenderer,
};
