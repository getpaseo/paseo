import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";

const INLINE_MARKER = "::";
const BLOCK_FENCE = ":::";

function findUnescapedDelimiter(source: string, delimiter: string): number {
  let searchStart = 0;
  while (searchStart < source.length) {
    const delimiterStart = source.indexOf(delimiter, searchStart);
    if (delimiterStart === -1) {
      return -1;
    }
    let backslashCount = 0;
    for (let index = delimiterStart - 1; index >= 0 && source[index] === "\\"; index--) {
      backslashCount++;
    }
    if (backslashCount % 2 === 0) {
      return delimiterStart;
    }
    searchStart = delimiterStart + delimiter.length;
  }
  return -1;
}

export default function contribute(client: PluginClientContext) {
  return client.addMarkdownExtension({
    id: "badge",
    parser: (markdown) => {
      // `::text::` becomes one leaf token whose text is never parsed again, so a backslash
      // inside it reaches the render rule intact.
      markdown.inline.ruler.before("escape", "badge_inline", (state, silent) => {
        if (!state.src.startsWith(INLINE_MARKER, state.pos)) return false;
        const contentStart = state.pos + INLINE_MARKER.length;
        const contentEnd = state.src.indexOf(INLINE_MARKER, contentStart);
        if (contentEnd <= contentStart) return false;
        if (!silent) {
          state.push("badge_inline", "span", 0).content = state.src.slice(contentStart, contentEnd);
        }
        state.pos = contentEnd + INLINE_MARKER.length;
        return true;
      });
      // `:::` … `:::`, or everything that is left while the closing fence has not streamed in.
      // Close when an unescaped `:::` appears anywhere on the line, matching the splitter.
      markdown.block.ruler.before("fence", "badge_block", (state, startLine, endLine, silent) => {
        if (state.getLines(startLine, startLine + 1, 0, false).trim() !== BLOCK_FENCE) return false;
        if (silent) return true;
        let closeLine = startLine + 1;
        while (
          closeLine < endLine &&
          findUnescapedDelimiter(
            state.getLines(closeLine, closeLine + 1, 0, false),
            BLOCK_FENCE,
          ) === -1
        ) {
          closeLine++;
        }
        const token = state.push("badge_block", "div", 0);
        token.block = true;
        token.content = state.getLines(startLine + 1, closeLine, 0, false);
        token.markup = closeLine < endLine ? BLOCK_FENCE : "";
        state.line = Math.min(closeLine + 1, endLine);
        token.map = [startLine, state.line];
        return true;
      });
    },
    rules: {
      badge_inline: (node) => (
        <Text key={node.key} accessibilityLabel={node.content}>
          [{node.content}]
        </Text>
      ),
      // `markup` is the closing fence, or "" while the block is still streaming.
      badge_block: (node, _children, _parent, _styles, inheritedStyles) => (
        <View key={node.key} accessible accessibilityLabel={node.content}>
          <Text style={inheritedStyles}>{node.content}</Text>
        </View>
      ),
    },
    blockDelimiters: [{ open: BLOCK_FENCE, close: BLOCK_FENCE }],
  });
}
