import type { ReactElement, ReactNode } from "react";

export interface ImportSessionListProps<Item> {
  data: ReadonlyArray<Item>;
  keyExtractor: (item: Item) => string;
  renderItem: (item: Item) => ReactNode;
  header: ReactElement | null;
  footer: ReactElement | null;
}

export type ImportSessionListComponent = <Item>(
  props: ImportSessionListProps<Item>,
) => ReactElement;
