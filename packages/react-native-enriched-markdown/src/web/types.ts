import type { MarkdownRenderers } from '../types/MarkdownRenderers';
import type { ComponentType, ReactNode } from 'react';
import type { MarkdownStyleInternal } from '../types/MarkdownStyleInternal';
import type { Styles } from './styles';
import type {
  LinkPressEvent,
  LinkLongPressEvent,
  ImagePressEvent,
  TaskListItemPressEvent,
  CodeBlockPressEvent,
} from '../types/events';
import type { KaTeXInstance } from './katex';

export type NodeType =
  | 'Document'
  | 'Paragraph'
  | 'Text'
  | 'Link'
  | 'Heading'
  | 'LineBreak'
  | 'SoftBreak'
  | 'Strong'
  | 'Emphasis'
  | 'Strikethrough'
  | 'Underline'
  | 'Superscript'
  | 'Subscript'
  | 'Highlight'
  | 'Code'
  | 'Image'
  | 'Blockquote'
  | 'UnorderedList'
  | 'OrderedList'
  | 'ListItem'
  | 'CodeBlock'
  | 'ThematicBreak'
  | 'Table'
  | 'TableHead'
  | 'TableBody'
  | 'TableRow'
  | 'TableHeaderCell'
  | 'TableCell'
  | 'LatexMathInline'
  | 'LatexMathDisplay'
  | 'BlankLine'
  | 'Admonition'
  | 'Video';

export interface NodeAttributes {
  start?: string;
  level?: string;
  url?: string;
  /** Stamped by recognizeTextLinks() — not present in the raw WASM output. */
  recognizedLink?: string;
  title?: string;
  language?: string;
  fenceChar?: string;
  isTask?: string;
  taskChecked?: string;
  /** Stamped by indexTaskItems() — not present in the raw WASM output. */
  taskIndex?: number;
  /** Stamped by markInlineImages() — not present in the raw WASM output. */
  isInline?: boolean;
  colCount?: string;
  headRowCount?: string;
  bodyRowCount?: string;
  /** "note"/"tip"/"important"/"warning"/"caution" for a MD_BLOCK_ADMONITION. */
  admonitionType?: string;
  align?: 'left' | 'center' | 'right' | 'default';
  /** Present on BlankLine nodes — count of blank lines in the source run. */
  count?: string;
}

export interface ASTNode {
  type: NodeType;
  /** Present on Text, Code, LatexMathInline, LatexMathDisplay nodes. */
  content?: string;
  /** Present on nodes that carry structural metadata (Heading, Link, etc.). */
  attributes?: NodeAttributes;
  /** Child nodes; absent on leaf nodes (Text, LineBreak, SoftBreak, ThematicBreak). */
  children?: ASTNode[];
}

export interface RendererCallbacks {
  onLinkPress?: (event: LinkPressEvent) => void;
  onLinkLongPress?: (event: LinkLongPressEvent) => void;
  onImagePress?: (event: ImagePressEvent) => void;
  onTaskListItemPress?: (event: TaskListItemPressEvent) => void;
  onCodeBlockPress?: (event: CodeBlockPressEvent) => void;
}

export interface RenderCapabilities {
  renderers?: MarkdownRenderers;
  katex: KaTeXInstance | null;
  /** When false, task list checkboxes render read-only and ignore clicks. */
  enableTaskListItemToggle: boolean;
}

export interface RendererProps {
  node: ASTNode;
  style: MarkdownStyleInternal;
  styles: Styles;
  parentType?: NodeType;
  /** Position among the parent node's children. */
  index?: number;
  callbacks: RendererCallbacks;
  capabilities: RenderCapabilities;
  renderChildren: (node: ASTNode) => ReactNode;
}

export type RendererMap = Partial<
  Record<NodeType, ComponentType<RendererProps>>
>;
