/**
 * Message item — renders a single StreamItem in the message list.
 *
 * Dispatches to the appropriate sub-component based on item.kind:
 *   - user_message → right-aligned bubble
 *   - assistant_message → MarkdownBlock
 *   - thought → collapsible reasoning block
 *   - tool_call → ToolCallCard
 *   - activity_log → centered system message
 */

import type {
  StreamItem,
  UserMessageItem,
  AssistantMessageItem,
  ThoughtItem,
  ToolCallItem,
  ActivityLogItem,
} from '../models/stream-types';
import { PaseoTheme } from '../common/theme';
import { MarkdownBlock } from './markdown-block';
import { ToolCallCard } from './tool-call-card';
import { Icons } from '../common/icons';

@Component
export struct MessageItem {
  @Prop item: StreamItem = {
    kind: 'assistant_message',
    id: '',
    text: '',
    timestamp: 0,
  };

  /** Type-narrowed accessor for user message properties. */
  private asUserMessage(): UserMessageItem {
    return this.item as UserMessageItem;
  }
  /** Type-narrowed accessor for assistant message properties. */
  private asAssistantMessage(): AssistantMessageItem {
    return this.item as AssistantMessageItem;
  }
  /** Type-narrowed accessor for thought properties. */
  private asThought(): ThoughtItem {
    return this.item as ThoughtItem;
  }
  /** Type-narrowed accessor for tool call properties. */
  private asToolCall(): ToolCallItem {
    return this.item as ToolCallItem;
  }
  /** Type-narrowed accessor for activity log properties. */
  private asActivityLog(): ActivityLogItem {
    return this.item as ActivityLogItem;
  }

  build() {
    Column() {
      if (this.item.kind === 'user_message') {
        this.buildUserMessage();
      } else if (this.item.kind === 'assistant_message') {
        this.buildAssistantMessage();
      } else if (this.item.kind === 'thought') {
        this.buildThought();
      } else if (this.item.kind === 'tool_call') {
        this.buildToolCall();
      } else if (this.item.kind === 'activity_log') {
        this.buildActivityLog();
      }
    }
    .width('100%');
  }

  @Builder
  buildUserMessage() {
    Row() {
      Blank();
      Column() {
        Text(this.asUserMessage().text)
          .fontSize(PaseoTheme.fontSizeMD)
          .fontColor(PaseoTheme.textInverse)
          .lineHeight(PaseoTheme.fontSizeMD * 1.5);
      }
      .padding({
        left: PaseoTheme.spaceMD,
        right: PaseoTheme.spaceMD,
        top: PaseoTheme.spaceSM,
        bottom: PaseoTheme.spaceSM,
      })
      .backgroundColor(PaseoTheme.accent)
      .borderRadius({
        topLeft: PaseoTheme.radiusLG,
        topRight: PaseoTheme.radiusSM,
        bottomLeft: PaseoTheme.radiusLG,
        bottomRight: PaseoTheme.radiusLG,
      })
      .constraintSize({ maxWidth: '75%' });
    }
    .width('100%')
    .justifyContent(FlexAlign.End)
    .padding({
      left: PaseoTheme.spaceLG,
      right: PaseoTheme.spaceMD,
      top: PaseoTheme.spaceSM,
      bottom: PaseoTheme.spaceSM,
    });
  }

  @Builder
  buildAssistantMessage() {
    Column() {
      MarkdownBlock({ text: this.asAssistantMessage().text });
    }
    .width('100%')
    .padding({
      left: PaseoTheme.spaceMD,
      right: PaseoTheme.spaceMD,
      top: PaseoTheme.spaceSM,
      bottom: PaseoTheme.spaceSM,
    });
  }

  @Builder
  buildThought() {
    Column() {
      Row() {
        Text(Icons.SEARCH)
          .fontSize(PaseoTheme.fontSizeXS)
          .fontColor(PaseoTheme.textTertiary)
          .margin({ right: PaseoTheme.spaceSM });

        Text('Thinking…')
          .fontSize(PaseoTheme.fontSizeSM)
          .fontColor(PaseoTheme.textSecondary)
          .fontStyle(FontStyle.Italic);

        Blank();
      }
      .width('100%')
      .padding({
        left: PaseoTheme.spaceMD,
        right: PaseoTheme.spaceMD,
        top: PaseoTheme.spaceXS,
        bottom: PaseoTheme.spaceXS,
      });

      if (this.asThought().text) {
        Text(this.asThought().text)
          .fontSize(PaseoTheme.fontSizeSM)
          .fontColor(PaseoTheme.textTertiary)
          .fontStyle(FontStyle.Italic)
          .padding({
            left: PaseoTheme.spaceMD,
            right: PaseoTheme.spaceMD,
            bottom: PaseoTheme.spaceSM,
          })
          .width('100%');
      }
    }
    .width('100%')
    .margin({ top: PaseoTheme.spaceSM, bottom: PaseoTheme.spaceSM });
  }

  @Builder
  buildToolCall() {
    Column() {
      ToolCallCard({
        name: this.asToolCall().name,
        status: this.asToolCall().status,
        detail: this.asToolCall().detail,
      });
    }
    .width('100%')
    .padding({
      left: PaseoTheme.spaceMD,
      right: PaseoTheme.spaceMD,
    })
    .margin({ top: PaseoTheme.spaceXS, bottom: PaseoTheme.spaceXS });
  }

  @Builder
  buildActivityLog() {
    Row() {
      Blank();
      Text(this.asActivityLog().message)
        .fontSize(PaseoTheme.fontSizeXS)
        .fontColor(PaseoTheme.textTertiary)
        .fontStyle(FontStyle.Italic);
      Blank();
    }
    .width('100%')
    .padding({
      top: PaseoTheme.spaceSM,
      bottom: PaseoTheme.spaceSM,
    });
  }
}
