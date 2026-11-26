import type { ComponentType, ComponentProps, ReactNode } from 'react';
import type { LinkPressEvent } from './events';

export interface CodeBlockRendererProps {
  /** Code content, including its original trailing whitespace. */
  code: string;
  /** Fence language, or an empty string for an unlabelled block. */
  language: string;
}

export interface LinkRendererProps {
  link: LinkPressEvent;
  anchorProps: ComponentProps<'a'>;
  children: ReactNode;
}

/** A plain quote. Admonitions keep the library's own renderer. */
export interface BlockquoteRendererProps {
  blockquoteProps: ComponentProps<'blockquote'>;
  children: ReactNode;
}

/** Custom web components. Overrides own their styling and interactions. */
export interface MarkdownRenderers {
  blockquote?: ComponentType<BlockquoteRendererProps>;
  codeBlock?: ComponentType<CodeBlockRendererProps>;
  link?: ComponentType<LinkRendererProps>;
}
