"use strict";

import { tableBodyRowStyle } from "../styles.js";
import { jsx as _jsx } from "react/jsx-runtime";
function TableRenderer({
  node,
  styles,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("div", {
    style: styles.tableWrapper,
    children: /*#__PURE__*/_jsx("table", {
      style: styles.table,
      children: renderChildren(node)
    })
  });
}
function TableHeadRenderer({
  node,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("thead", {
    children: renderChildren(node)
  });
}

// Renders <tr> directly instead of delegating to TableRowRenderer because
// zebra-striping requires the row index, which renderChildren doesn't provide.
function TableBodyRenderer({
  node,
  style,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("tbody", {
    children: node.children?.map((rowNode, rowIndex) => /*#__PURE__*/_jsx("tr", {
      style: tableBodyRowStyle(style, rowIndex),
      children: renderChildren(rowNode)
    }, `row-${rowIndex}`))
  });
}
function TableRowRenderer({
  node,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("tr", {
    children: renderChildren(node)
  });
}
function TableHeaderCellRenderer({
  node,
  styles,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("th", {
    style: styles.tableHeaderCell[node.attributes?.align ?? 'default'],
    children: renderChildren(node)
  });
}
function TableCellRenderer({
  node,
  styles,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("td", {
    style: styles.tableCell[node.attributes?.align ?? 'default'],
    children: renderChildren(node)
  });
}
export const tableRenderers = {
  Table: TableRenderer,
  TableHead: TableHeadRenderer,
  TableBody: TableBodyRenderer,
  TableRow: TableRowRenderer,
  TableHeaderCell: TableHeaderCellRenderer,
  TableCell: TableCellRenderer
};
//# sourceMappingURL=TableRenderers.js.map