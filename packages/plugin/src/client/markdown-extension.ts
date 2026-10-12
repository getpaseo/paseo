import type MarkdownIt from "markdown-it";
import type { RenderRules } from "react-native-markdown-display";

// markdown-it and react-native-markdown-display are optional peer dependencies
// (see packages/plugin/package.json). Keep these two types in their own module,
// separate from contracts.ts, so a plugin that never calls addMarkdownExtension
// does not need either package resolvable just to import PluginClientContext.

export interface PluginMarkdownBlockDelimiter {
  open: string;
  close: string;
}

export interface PluginMarkdownExtension {
  id: string;
  /** Runs once per parser build with Paseo's live markdown-it instance. */
  parser?: (markdown: MarkdownIt) => void;
  /** Merged after Paseo's built-in assistant rules, so a plugin rule wins on collision. */
  rules?: RenderRules;
  /** Line-leading pairs the streaming splitter must not split inside, open or unclosed. */
  blockDelimiters?: PluginMarkdownBlockDelimiter[];
}
