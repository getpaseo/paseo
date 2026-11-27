import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from 'react';
import type { EnrichedMarkdownTextProps } from '../types/MarkdownTextProps.web';
import { normalizeMarkdownStyle } from '../normalizeMarkdownStyle.web';
import {
  zeroTrailingMargins,
  parseErrorFallbackStyle,
  buildStyles,
} from './styles';
import { parseMarkdown, parseMarkdownSync } from './parseMarkdown';
import { recognizeTextLinks } from './recognizeTextLinks';
import { RenderNode } from './renderers';
import type { ASTNode, RendererCallbacks, RenderCapabilities } from './types';
import { indexTaskItems, markInlineImages } from './utils';
import { loadKaTeX } from './katex';
import type { KaTeXInstance } from './katex';
import { ENRM_TEXT_CLASS, ENRM_SELECTION_BG_VAR } from './globalStyles';
import { filterNativeOnlyProps } from './nativeProps';

export const EnrichedMarkdownText = ({
  markdown,
  markdownStyle = {},
  md4cFlags = {},
  linkRecognition,
  renderers,
  onLinkPress,
  onLinkLongPress,
  onImagePress,
  onTaskListItemPress,
  onCodeBlockPress,
  enableTaskListItemToggle = true,
  allowTrailingMargin = false,
  containerStyle,
  selectable = true,
  dir,
  selectionColor,
  testID,
  ...rest
}: EnrichedMarkdownTextProps) => {
  const normalizedStyle = useMemo(
    () => normalizeMarkdownStyle(markdownStyle),
    [markdownStyle]
  );

  const [parsed, setParsed] = useState<{
    ast: ASTNode;
    markdown: string;
  } | null>(null);
  const [katex, setKatex] = useState<KaTeXInstance | null>(null);
  const [parseError, setParseError] = useState<boolean>(false);

  const {
    underline = false,
    latexMath = true,
    superscript = false,
    subscript = false,
    highlight = false,
    hardSoftBreaks = false,
    preserveBlankLines = false,
    admonitions = true,
  } = md4cFlags;

  // A regex literal in JSX is a new object every render; re-parse only when its text changes.
  const linkRecognitionRef = useRef(linkRecognition);
  linkRecognitionRef.current = linkRecognition;
  const textLinkKey = linkRecognition?.text?.toString() ?? null;
  const inlineCodeLinkKey = linkRecognition?.inlineCode?.toString() ?? null;

  // Once WASM is ready, new/virtualized rows must have their text on the first
  // commit. An effect-only parse briefly measures an empty row and moves readers.
  const immediate = useMemo(() => {
    try {
      const result = parseMarkdownSync(markdown, {
        underline,
        latexMath,
        superscript,
        subscript,
        highlight,
        hardSoftBreaks,
        preserveBlankLines,
        admonitions,
      });
      if (!result) return null;
      indexTaskItems(result);
      markInlineImages(result);
      return {
        markdown,
        ast: recognizeTextLinks(
          result,
          linkRecognitionRef.current?.text,
          linkRecognitionRef.current?.inlineCode
        ),
      };
    } catch {
      return { markdown, ast: null };
    }
    // Regex keys track ref changes; parsed wakes this memo after WASM initialization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    markdown,
    underline,
    latexMath,
    superscript,
    subscript,
    highlight,
    hardSoftBreaks,
    preserveBlankLines,
    admonitions,
    textLinkKey,
    inlineCodeLinkKey,
    parsed,
  ]);

  useEffect(() => {
    if (immediate && (!latexMath || katex)) return;
    let cancelled = false;

    const katexPromise = latexMath ? loadKaTeX() : Promise.resolve(null);

    Promise.all([
      parseMarkdown(markdown, {
        underline,
        latexMath,
        superscript,
        subscript,
        highlight,
        hardSoftBreaks,
        preserveBlankLines,
        admonitions,
      }),
      katexPromise,
    ])
      .then(([result, katexInstance]) => {
        if (!cancelled) {
          indexTaskItems(result);
          markInlineImages(result);

          setParseError(false);
          setKatex(katexInstance);
          setParsed({
            markdown,
            ast: recognizeTextLinks(
              result,
              linkRecognitionRef.current?.text,
              linkRecognitionRef.current?.inlineCode
            ),
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          if (__DEV__) {
            console.error('[EnrichedMarkdownText] Parse failed:', error);
          }

          setParseError(true);
          setParsed(null);
          setKatex(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    markdown,
    underline,
    latexMath,
    superscript,
    subscript,
    highlight,
    hardSoftBreaks,
    preserveBlankLines,
    admonitions,
    textLinkKey,
    inlineCodeLinkKey,
    immediate,
    katex,
  ]);

  const callbacks = useMemo<RendererCallbacks>(
    () => ({
      onLinkPress,
      onLinkLongPress,
      onImagePress,
      onTaskListItemPress,
      onCodeBlockPress,
    }),
    [
      onLinkPress,
      onLinkLongPress,
      onImagePress,
      onTaskListItemPress,
      onCodeBlockPress,
    ]
  );

  const capabilities = useMemo<RenderCapabilities>(
    () => ({ katex, enableTaskListItemToggle, renderers }),
    [katex, enableTaskListItemToggle, renderers]
  );

  const lastChildStyle = useMemo(
    () =>
      allowTrailingMargin
        ? normalizedStyle
        : zeroTrailingMargins(normalizedStyle),
    [normalizedStyle, allowTrailingMargin]
  );

  const styles = useMemo(() => buildStyles(normalizedStyle), [normalizedStyle]);

  const lastChildStyles = useMemo(
    () => buildStyles(lastChildStyle),
    [lastChildStyle]
  );

  const wrapperStyle = useMemo<CSSProperties>(
    () => ({
      display: 'flex',
      flexDirection: 'column',
      ...(containerStyle as CSSProperties),
      ...(selectable ? undefined : { userSelect: 'none' }),
      ...(selectionColor
        ? ({ [ENRM_SELECTION_BG_VAR]: selectionColor } as CSSProperties)
        : null),
    }),
    [containerStyle, selectable, selectionColor]
  );

  const domProps = filterNativeOnlyProps(rest);

  const visibleParsed = immediate ?? parsed;
  if (immediate ? immediate.ast === null : parseError) {
    return (
      <div
        className={ENRM_TEXT_CLASS}
        style={wrapperStyle}
        dir={dir}
        data-testid={testID}
        {...domProps}
      >
        <pre style={parseErrorFallbackStyle}>{markdown}</pre>
      </div>
    );
  }

  const children = visibleParsed?.ast?.children ?? [];
  const lastIdx = children.length - 1;

  return (
    <div
      aria-busy={visibleParsed?.markdown !== markdown}
      className={ENRM_TEXT_CLASS}
      style={wrapperStyle}
      dir={dir}
      data-testid={testID}
      {...domProps}
    >
      {children.map((child, index) => (
        <RenderNode
          key={`${child.type}-${index}`}
          node={child}
          style={index === lastIdx ? lastChildStyle : normalizedStyle}
          styles={index === lastIdx ? lastChildStyles : styles}
          callbacks={callbacks}
          capabilities={capabilities}
        />
      ))}
    </div>
  );
};

export default EnrichedMarkdownText;
