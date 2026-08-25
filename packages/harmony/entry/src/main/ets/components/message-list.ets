/**
 * Message list — virtualized scrollable timeline.
 *
 * Renders the combined tail + head StreamItem[] using ArkUI's List +
 * LazyForEach for efficient virtualization. Handles:
 * - Auto-scroll to bottom on new messages (bottom-anchor behavior)
 * - Pull-to-load older pages
 * - Loading and empty states
 */

import type { StreamItem } from '../models/stream-types';
import { TimelineStore } from '../models/timeline-store';
import { PaseoTheme } from '../common/theme';
import { MessageItem } from './message-item';
import { Icons } from '../common/icons';

@Component
export struct MessageList {
  @ObjectLink store: TimelineStore;
  onLoadOlder: () => void = () => {};
  private scroller: Scroller = new Scroller();
  @State private isAtBottom: boolean = true;
  @State private lastTotalCount: number = 0;

  /**
   * All items to render. Create a snapshot to avoid re-rendering the
   * entire list on every tail/head mutation — ArkUI ForEach uses the
   * key function to diff.
   */
  aboutToAppear(): void {
    this.lastTotalCount = this.store?.totalCount ?? 0;
  }

  onScrollIndex(firstIndex: number, _lastIndex: number): void {
    // Detect if user scrolled away from bottom
    const total = (this.store?.allItems ?? []).length;
    this.isAtBottom = firstIndex + 10 >= total; // within ~10 items of bottom

    // Load older pages when scrolling near the top
    if (firstIndex <= 2 && this.store.hasOlder && !this.store.isLoading) {
      this.onLoadOlder();
    }
  }

  /**
   * Auto-scroll to bottom when new items arrive while the user
   * is already at the bottom (bottom-anchor behavior).
   */
  onItemsChanged(): void {
    const newCount = this.store.totalCount;
    if (this.isAtBottom && newCount > this.lastTotalCount) {
      // Scroll to end on next frame
      setTimeout(() => {
        this.scroller.scrollEdge(Edge.Bottom);
      }, 50);
    }
    this.lastTotalCount = newCount;
  }

  build() {
    Column() {
      if (this.store.isLoading && this.store.totalCount === 0) {
        // Initial loading state
        Column() {
          LoadingProgress()
            .width(32)
            .height(32)
            .color(PaseoTheme.accent);

          Text('Loading timeline…')
            .fontSize(PaseoTheme.fontSizeSM)
            .fontColor(PaseoTheme.textTertiary)
            .margin({ top: PaseoTheme.spaceMD });
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center);
      } else if ((this.store?.allItems ?? []).length === 0) {
        // Empty state
        Column() {
          Text('No messages yet')
            .fontSize(PaseoTheme.fontSizeMD)
            .fontColor(PaseoTheme.textTertiary)
            .margin({ bottom: PaseoTheme.spaceSM });

          Text('Send a prompt to get started')
            .fontSize(PaseoTheme.fontSizeSM)
            .fontColor(PaseoTheme.textTertiary);
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center);
      } else {
        // Message list
        List({ scroller: this.scroller }) {
          // Top loading indicator (for pagination)
          if (this.store.isLoading && this.store.hasOlder) {
            ListItem() {
              Row() {
                LoadingProgress()
                  .width(20)
                  .height(20)
                  .color(PaseoTheme.textSecondary);
              }
              .width('100%')
              .height(44)
              .justifyContent(FlexAlign.Center);
            };
          }

          LazyForEach(
            new MessageDataSource((this.store?.allItems ?? [])),
            (item: StreamItem) => {
              ListItem() {
                MessageItem({ item: item });
              };
            },
            (item: StreamItem) => item.id,
          );
        }
        .listDirection(Axis.Vertical)
        .scrollBar(BarState.Auto)
        .edgeEffect(EdgeEffect.Spring)
        .onScrollIndex((firstIdx: number, lastIdx: number) => {
          this.onScrollIndex(firstIdx, lastIdx);
        })
        .onDidScroll(() => {
          // Could track scroll position here
        })
        .layoutWeight(1)
        .width('100%');
      }

      // Inline error banner
      if (this.store.lastError) {
        Row() {
          Text(`${Icons.ERROR} ${this.store.lastError}`)
            .fontSize(PaseoTheme.fontSizeXS)
            .fontColor(PaseoTheme.danger);
        }
        .width('100%')
        .padding(PaseoTheme.spaceSM)
        .backgroundColor(PaseoTheme.danger + '1A')
        .justifyContent(FlexAlign.Center);
      }
    }
    .width('100%')
    .height('100%');
  }
}

// ---------------------------------------------------------------------------
// LazyForEach data source
// ---------------------------------------------------------------------------

class MessageDataSource implements IDataSource {
  private items: StreamItem[];
  private listeners: DataChangeListener[] = [];

  constructor(items: StreamItem[]) {
    this.items = items;
  }

  totalCount(): number {
    return this.items.length;
  }

  getData(index: number): StreamItem {
    return this.items[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener);
    }
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx >= 0) {
      this.listeners.splice(idx, 1);
    }
  }
}
