export type PaseoWeChatConfig = {
  enabled: boolean;
  autoStart: boolean;
  provider: string;
  cwd: string;
  modeId?: string;
  model?: string | null;
  systemPrompt?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
  networkAccess?: boolean;
  webSearch?: boolean;
  qrApiBaseUrl?: string;
  apiBaseUrl?: string;
  pollTimeoutMs?: number;
};

export type WeChatAccountRecord = {
  id: string;
  rawAccountId: string;
  userId?: string;
  token: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  getUpdatesBuf?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastError?: string | null;
};

export type WeChatPeerSessionRecord = {
  accountId: string;
  peerId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  contextToken?: string;
};

export type WeChatState = {
  accounts: WeChatAccountRecord[];
  peerSessions: WeChatPeerSessionRecord[];
};

export type WeChatMessageItem = {
  type?: number;
  text_item?: {
    text?: string;
  };
};

export type WeChatMessage = {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  item_list?: WeChatMessageItem[];
  context_token?: string;
};

export type WeChatGetUpdatesResponse = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeChatMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};
