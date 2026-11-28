import type { RendererProps, RendererMap } from '../types';
import { tableBodyRowStyle } from '../styles';

function TableRenderer({ node, styles, renderChildren }: RendererProps) {
  return (
    <div style={styles.tableWrapper}>
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
  renderChildren,
}: RendererProps) {
  return (
    <th style={styles.tableHeaderCell[node.attributes?.align ?? 'default']}>
      {renderChildren(node)}
    </th>
  );
}

function TableCellRenderer({ node, styles, renderChildren }: RendererProps) {
  return (
    <td style={styles.tableCell[node.attributes?.align ?? 'default']}>
      {renderChildren(node)}
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
