export type VoiceSpeakHandler = (params: {
  text: string;
  callerAgentId: string;
  signal?: AbortSignal;
}) => Promise<void>;

export type VoiceCallerContext = {
  childAgentDefaultLabels?: Record<string, string>;
  lockedCwd?: string;
  allowCustomCwd?: boolean;
  enableVoiceTools?: boolean;
};
