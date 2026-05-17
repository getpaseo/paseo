import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { highlightCode, type HighlightToken } from "@getpaseo/highlight";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";

interface HighlightedCodeBlockProps {
  code: string;
  language: string | null | undefined;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}

// Fence info strings ("```ts", "```typescript", "```ts {1,3}") map to the
// extension-based parser table in @getpaseo/highlight. Aliases here only
// cover names that don't already match an extension key in parsers.ts.
const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  golang: "go",
  "c++": "cpp",
  objc: "m",
  "objective-c": "m",
  markdown: "md",
  elixir: "ex",
};

function fenceLanguageToExtension(info: string | null | undefined): string | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  const normalized = first.replace(/^\./, "");
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

// Cross-instance cache for tokenized code blocks. Tokenization is
// theme-independent (colors are applied at render time), so the key is just
// (language, code). Bounded by entry count — 200 is generous for a chat
// transcript, code blocks rarely repeat beyond a handful of distinct shapes.
class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}

const tokenizationCache = new LRUCache<string, KeyedLine[]>(200);

export const HighlightedCodeBlock = React.memo(function HighlightedCodeBlock({
  code,
  language,
  inheritedStyles,
  textStyle,
}: HighlightedCodeBlockProps) {
  // Box styles (bg / padding / border / radius / margin) go on the wrapper View
  // so the absolute copy button positions relative to the visible code area,
  // not to a parent that includes the Text's own marginVertical.
  const { containerStyle, innerTextStyle } = useMemo(
    () => splitFenceStyle(inheritedStyles, textStyle),
    [inheritedStyles, textStyle],
  );

  const keyedLines = useMemo<KeyedLine[] | null>(() => {
    const ext = fenceLanguageToExtension(language);
    if (!ext) return null;
    const cacheKey = `${ext}:${code}`;
    const cached = tokenizationCache.get(cacheKey);
    if (cached) return cached;
    let tokenizedLines: HighlightToken[][];
    try {
      tokenizedLines = highlightCode(code, `x.${ext}`);
    } catch {
      return null;
    }
    const result = tokenizedLines.map(toKeyedLine);
    tokenizationCache.set(cacheKey, result);
    return result;
  }, [code, language]);

  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const controlsVisible = isHovered || isNative || isCompact;
  const getCode = useCallback(() => code, [code]);

  return (
    <View
      style={containerStyle}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {keyedLines ? (
        <Text style={innerTextStyle}>
          {keyedLines.map((line, lineIndex) => (
            <React.Fragment key={line.key}>
              {lineIndex > 0 ? "\n" : null}
              {line.tokens.map(({ key, token }) => (
                <TokenSpan key={key} token={token} />
              ))}
            </React.Fragment>
          ))}
        </Text>
      ) : (
        <Text style={innerTextStyle}>{code}</Text>
      )}
      <CopyButton getCode={getCode} visible={controlsVisible} />
    </View>
  );
});

interface KeyedToken {
  key: string;
  token: HighlightToken;
}

interface KeyedLine {
  key: string;
  tokens: KeyedToken[];
}

function toKeyedLine(tokens: HighlightToken[], lineIndex: number): KeyedLine {
  return {
    key: `line-${lineIndex}`,
    tokens: tokens.map((token, tokenIndex) => ({
      key: `${lineIndex}-${tokenIndex}`,
      token,
    })),
  };
}

interface TokenSpanProps {
  token: HighlightToken;
}

const TokenSpan = React.memo(function TokenSpan({ token }: TokenSpanProps) {
  if (!token.style) return token.text;
  return <Text style={syntaxTokenStyleFor(token.style)}>{token.text}</Text>;
});

interface SplitStyles {
  containerStyle: StyleProp<ViewStyle>;
  innerTextStyle: StyleProp<TextStyle>;
}

const CONTAINER_BASE: ViewStyle = { position: "relative" };
const WEB_SELECTABLE: TextStyle = isWeb ? ({ userSelect: "text" } as TextStyle) : {};

function splitFenceStyle(inheritedStyles: TextStyle, textStyle: TextStyle): SplitStyles {
  const { fontFamily, fontSize, color, ...box } = textStyle;
  const textOnly: TextStyle = { ...WEB_SELECTABLE };
  if (fontFamily !== undefined) textOnly.fontFamily = fontFamily;
  if (fontSize !== undefined) textOnly.fontSize = fontSize;
  if (color !== undefined) textOnly.color = color;
  return {
    containerStyle: [box as ViewStyle, CONTAINER_BASE],
    innerTextStyle: [inheritedStyles, textOnly],
  };
}

interface CopyButtonProps {
  getCode: () => string;
  visible: boolean;
}

const COPIED_RESET_MS = 1500;

const CopyButton = React.memo(function CopyButton({ getCode, visible }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const handlePress = useCallback(async () => {
    const content = getCode();
    if (!content) return;
    await Clipboard.setStringAsync(content);
    setCopied(true);
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => {
      setCopied(false);
      resetRef.current = null;
    }, COPIED_RESET_MS);
  }, [getCode]);

  const visibilityStyle = visible
    ? copyButtonStyles.containerVisible
    : copyButtonStyles.containerHidden;
  const wrapperStyle = useMemo(
    () => [copyButtonStyles.container, visibilityStyle],
    [visibilityStyle],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={wrapperStyle}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : "Copy code"}
      hitSlop={8}
    >
      {({ hovered }) => {
        const iconColor = hovered
          ? copyButtonStyles.iconHoveredColor.color
          : copyButtonStyles.iconColor.color;
        return copied ? (
          <Check size={14} color={iconColor} />
        ) : (
          <Copy size={14} color={iconColor} />
        );
      }}
    </Pressable>
  );
});

const copyButtonStyles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    padding: theme.spacing[1],
  },
  containerVisible: {
    opacity: 1,
  },
  containerHidden: {
    opacity: 0,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));
