import { useState, useEffect } from 'react';
import { extractNodeText } from '../utils';
import type { RendererProps, RendererMap, ASTNode, NodeType } from '../types';
import { listItemStyle, checkedTaskTextStyle } from '../styles';

const NESTED_LIST_TYPES: Set<NodeType> = new Set([
  'UnorderedList',
  'OrderedList',
]);

function ListRenderer({
  node,
  styles,
  parentType,
  renderChildren,
  listTag: ListTag,
}: RendererProps & { listTag: 'ul' | 'ol' }) {
  const isNested = parentType === 'ListItem';
  const hasTaskChild =
    !isNested &&
    node.children?.some((child) => child.attributes?.isTask === 'true');

  const resolvedStyle = isNested
    ? styles.listNested
    : hasTaskChild
      ? styles.listTask
      : styles.list;
  return (
    <ListTag
      start={ListTag === 'ol' ? Number(node.attributes?.start ?? 1) : undefined}
      style={resolvedStyle}
    >
      {renderChildren(node)}
    </ListTag>
  );
}

function UnorderedListRenderer(props: RendererProps) {
  return <ListRenderer {...props} listTag="ul" />;
}

function OrderedListRenderer(props: RendererProps) {
  return <ListRenderer {...props} listTag="ol" />;
}

function isNestedList(child: ASTNode): boolean {
  return NESTED_LIST_TYPES.has(child.type);
}

function ListItemRenderer({
  node,
  style,
  styles,
  index,
  callbacks,
  capabilities,
  renderChildren,
}: RendererProps) {
  const isTask = node.attributes?.isTask === 'true';
  const initialChecked = node.attributes?.taskChecked === 'true';
  const taskText = isTask ? extractNodeText(node) : '';
  const [isChecked, setIsChecked] = useState(initialChecked);

  useEffect(() => {
    setIsChecked(initialChecked);
  }, [initialChecked]);

  const handleChange = () => {
    if (!capabilities.enableTaskListItemToggle) return;

    const taskIndex = node.attributes?.taskIndex;
    if (taskIndex === undefined) return;

    const newChecked = !isChecked;
    setIsChecked(newChecked);

    callbacks.onTaskListItemPress?.({
      index: taskIndex,
      checked: newChecked,
      text: taskText,
    });
  };

  const hasNestedList = node.children?.some(isNestedList);
  const checkedStyle =
    isTask && isChecked ? checkedTaskTextStyle(style) : undefined;

  const inlineNode: ASTNode = hasNestedList
    ? {
        ...node,
        children: node.children?.filter((child) => !isNestedList(child)),
      }
    : node;
  const nestedNode: ASTNode | null = hasNestedList
    ? { ...node, children: node.children?.filter(isNestedList) }
    : null;

  return (
    <li style={listItemStyle(style, isTask, (index ?? 0) === 0)}>
      <span style={checkedStyle}>
        {isTask && (
          <input
            type="checkbox"
            checked={isChecked}
            onChange={handleChange}
            readOnly={!capabilities.enableTaskListItemToggle}
            aria-disabled={
              capabilities.enableTaskListItemToggle ? undefined : true
            }
            style={
              capabilities.enableTaskListItemToggle
                ? styles.taskCheckbox
                : styles.taskCheckboxDisabled
            }
            aria-label={`Task: ${taskText}`}
          />
        )}
        {renderChildren(inlineNode)}
      </span>
      {nestedNode && renderChildren(nestedNode)}
    </li>
  );
}

export const listRenderers: RendererMap = {
  UnorderedList: UnorderedListRenderer,
  OrderedList: OrderedListRenderer,
  ListItem: ListItemRenderer,
};
