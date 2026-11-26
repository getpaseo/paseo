import type { ReactNode } from 'react';
import type { ASTNode, NodeType, RendererCallbacks, RenderCapabilities } from '../types';
import type { MarkdownStyleInternal } from '../../types/MarkdownStyleInternal';
import type { Styles } from '../styles';
export interface RenderNodeProps {
    node: ASTNode;
    style: MarkdownStyleInternal;
    styles: Styles;
    callbacks: RendererCallbacks;
    capabilities: RenderCapabilities;
    parentType?: NodeType;
    index?: number;
}
export declare function RenderNode({ node, style, styles, callbacks, capabilities, parentType, index, }: RenderNodeProps): ReactNode;
//# sourceMappingURL=index.d.ts.map