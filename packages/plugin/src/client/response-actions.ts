import type { PluginSpeech } from "./speech.js";

export interface PluginResponseActionContext {
  agentId: string;
  responseId: string;
  /** The complete selected response, using the same source as Paseo's Copy action. */
  getContent(): string;
  speech: PluginSpeech;
}

export interface PluginResponseActionItem {
  id: string;
  title: string;
  icon?: string;
  disabled?: boolean;
  onSelect(context: PluginResponseActionContext): void | Promise<void>;
}

export interface PluginResponseActionContribution {
  id: string;
  title: string;
  icon: string;
  /** Optional pure projection of progress for this response's trigger. */
  activity?(context: PluginResponseActionContext): {
    status: "loading" | "active";
    label: string;
  } | null;
  /** Pure menu projection. Paseo renders the dropdown and reports callback errors. */
  items(context: PluginResponseActionContext): readonly PluginResponseActionItem[];
}
