/**
 * Agent page — main interaction view.
 *
 * Shows the timeline of messages for a single agent, with a composer bar
 * pinned to the bottom for sending new prompts. Integrates:
 *   - AgentHeader (title, status, provider)
 *   - MessageList (virtualized timeline with LazyForEach)
 *   - TimelineStore (reactive message state)
 *   - Composer bar (input + send)
 *
 * Route params: none (Phase 1 uses the first available agent).
 */

import { router } from '@kit.ArkUI';
import { EntryAbility } from '../entryability/EntryAbility';
import { PaseoTheme } from '../common/theme';
import { Icons } from '../common/icons';
import { AgentModel } from '../models/agent-model';
import { TimelineStore } from '../models/timeline-store';
import { AgentHeader } from '../components/agent-header';
import { MessageList } from '../components/message-list';

@Entry
@Component
struct AgentPage {
  @State agent: AgentModel = new AgentModel();
  @State store: TimelineStore = new TimelineStore();
  @State composerText: string = '';

  private paseo = EntryAbility.paseoClient;

  aboutToAppear(): void {
    // Defer the connection guard so it runs after the page transition
    // completes. Calling router.replaceUrl() during an active pushUrl
    // animation corrupts the ArkUI page stack and causes a crash.
    setTimeout(() => {
      // Check connection state (not _client, which is null in Phase 1 stub).
      if (this.paseo.connection.status !== 'connected') {
        router.replaceUrl({ url: 'pages/connect-page' });
      }
    }, 100);

    // Load the first available agent (Phase 1: single-agent)
    this.loadFirstAgent();
  }

  async loadFirstAgent(): Promise<void> {
    try {
      this.agent.status = 'initializing';

      // Create a default agent via DaemonClient if none exists
      // In Phase 2, list agents and let the user pick
      const client = this.paseo.client!;

      // Placeholder — wire to daemon RPCs in integration phase
      this.agent.id = 'agent-session';
      this.agent.title = 'Agent';
      this.agent.status = 'idle';
      this.agent.provider = 'claude';
      this.agent.model = '';

      // TODO: Subscribe to agent_stream events
      // TODO: Fetch initial timeline via fetch_agent_timeline RPC
    } catch (err) {
      this.agent.status = 'error';
    }
  }

  handleSend(): void {
    const text = this.composerText.trim();
    if (!text) {
      return;
    }

    // Add optimistic user message to the store
    this.store.applyLiveEvent({
      provider: 'user',
      item: { type: 'user_message', text },
    });
    this.composerText = '';

    // TODO: Send via DaemonClient.sendMessage(agentId, text)
    // The daemon will stream back the response via agent_stream events
  }

  handleLoadOlder(): void {
    // TODO: Fetch older timeline pages via fetch_agent_timeline RPC
  }

  handleOpenTerminal(): void {
    router.pushUrl({ url: 'pages/terminal-page' });
  }

  build() {
    Column() {
      // ---- Agent header ----
      AgentHeader({
        title: this.agent.title || 'Agent',
        status: this.agent.status,
        provider: this.agent.provider,
        model: this.agent.model,
        onBack: () => { router.back(); },
        onTerminal: () => { this.handleOpenTerminal(); },
        onMenu: () => {},
      });

      // ---- Separator ----
      Divider()
        .color(PaseoTheme.border)
        .width('100%')
        .height(1);

      // ---- Message list with timeline store ----
      MessageList({
        store: this.store,
        onLoadOlder: () => { this.handleLoadOlder(); },
      });

      // ---- Composer bar ----
      Row() {
        TextArea({ text: this.composerText, placeholder: 'Send a message…' })
          .onChange((value: string) => { this.composerText = value; })
          .maxLines(5)
          .fontSize(PaseoTheme.fontSizeMD)
          .fontColor(PaseoTheme.textPrimary)
          .placeholderColor(PaseoTheme.textTertiary)
          .backgroundColor(PaseoTheme.codeBg)
          .borderRadius(PaseoTheme.radiusMD)
          .padding({
            left: PaseoTheme.spaceMD,
            right: PaseoTheme.spaceMD,
            top: PaseoTheme.spaceSM,
            bottom: PaseoTheme.spaceSM,
          })
          .layoutWeight(1);

        Button(this.agent.isActive ? Icons.STOP : Icons.SEND)
          .width(44)
          .height(44)
          .fontSize(PaseoTheme.fontSizeLG)
          .fontColor(Color.White)
          .backgroundColor(this.composerText.trim() ? PaseoTheme.accent : PaseoTheme.borderStrong)
          .borderRadius(PaseoTheme.radiusMD)
          .margin({ left: PaseoTheme.spaceSM })
          .onClick(() => { this.handleSend(); });
      }
      .width('100%')
      .padding({
        left: PaseoTheme.spaceMD,
        right: PaseoTheme.spaceMD,
        top: PaseoTheme.spaceSM,
        bottom: PaseoTheme.spaceMD,
      })
      .backgroundColor(PaseoTheme.bgSecondary);
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PaseoTheme.bgPrimary)
    .expandSafeArea([SafeAreaType.SYSTEM])
  }
}
