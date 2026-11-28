import * as React from 'react';
import type { ViewStyle } from 'react-native';

export type SlotContent = {
  children: React.ReactNode;
  style?: ViewStyle;
};

export type SlotApi = {
  rootId: number;
  allocate(): number;
  set(slotId: number, content: SlotContent): void;
  remove(slotId: number): void;
};

export const SlotContext = React.createContext<SlotApi | null>(null);
