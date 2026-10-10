// Importing the package root fails under vite -- src/index.js has JSX in a .js file. These lib
// internals are plain ESM, and untyped, so tests reach the renderer through them instead.
declare module "react-native-markdown-display/src/lib/AstRenderer" {
  import type { ReactNode } from "react";
  import type { ASTNode, RenderRules } from "react-native-markdown-display";

  export default class AstRenderer {
    constructor(renderRules: Partial<RenderRules>, style: unknown);
    render: (nodes: ASTNode[]) => ReactNode;
  }
}

declare module "react-native-markdown-display/src/lib/parser" {
  import type { ReactNode } from "react";
  import type { ASTNode } from "react-native-markdown-display";

  export default function parser(
    source: string,
    renderer: (nodes: ASTNode[]) => ReactNode,
    markdownIt: unknown,
  ): ReactNode;
}
