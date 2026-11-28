import type { CSSProperties } from 'react';
import type { RendererProps, RendererMap } from '../types';
import { tableBodyRowStyle } from '../styles';
import { resolveNodeDirection } from '../direction';

const ISOLATE_STYLE: CSSProperties = { unicodeBidi: 'isolate' };

function TableRenderer({
  node,
  styles,
  capabilities,
  renderChildren,
}: RendererProps) {
  const dir = capabilities.autoDir ? resolveNodeDirection(node) : undefined;
  return (
    <div dir={dir} style={styles.tableWrapper}>
      <table style={styles.table}>{renderChildren(node)}</table>
    </div>
  );
}

function TableHeadRenderer({ node, renderChildren }: RendererProps) {
  return <thead>{renderChildren(node)}</thead>;
}

// Renders <tr> directly instead of delegating to TableRowRenderer because
// zebra-striping requires the row index, which renderChildren doesn't provide.
function TableBodyRenderer({ node, style, renderChildren }: RendererProps) {
  return (
    <tbody>
      {node.children?.map((rowNode, rowIndex) => (
        <tr key={`row-${rowIndex}`} style={tableBodyRowStyle(style, rowIndex)}>
          {renderChildren(rowNode)}
        </tr>
      ))}
    </tbody>
  );
}

function TableRowRenderer({ node, renderChildren }: RendererProps) {
  return <tr>{renderChildren(node)}</tr>;
}

function TableHeaderCellRenderer({
  node,
  styles,
  capabilities,
  renderChildren,
}: RendererProps) {
  const cellDir = capabilities.autoDir ? resolveNodeDirection(node) : undefined;
  const content = renderChildren(node);
  return (
    <th style={styles.tableHeaderCell[node.attributes?.align ?? 'default']}>
      {cellDir ? (
        <span dir={cellDir} style={ISOLATE_STYLE}>
          {content}
        </span>
      ) : (
        content
      )}
    </th>
  );
}

function TableCellRenderer({
  node,
  styles,
  capabilities,
  renderChildren,
}: RendererProps) {
  const cellDir = capabilities.autoDir ? resolveNodeDirection(node) : undefined;
  const content = renderChildren(node);
  return (
    <td style={styles.tableCell[node.attributes?.align ?? 'default']}>
      {cellDir ? (
        <span dir={cellDir} style={ISOLATE_STYLE}>
          {content}
        </span>
      ) : (
        content
      )}
    </td>
  );
}

export const tableRenderers: RendererMap = {
  Table: TableRenderer,
  TableHead: TableHeadRenderer,
  TableBody: TableBodyRenderer,
  TableRow: TableRowRenderer,
  TableHeaderCell: TableHeaderCellRenderer,
  TableCell: TableCellRenderer,
};
