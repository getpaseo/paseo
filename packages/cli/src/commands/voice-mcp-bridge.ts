import { runVoiceMcpBridgeCli } from "@getpaseo/server";

type VoiceBridgeOptions = {
  socket: string;
};

export async function runVoiceMcpBridgeCommand(
  callerAgentId: string,
  options: VoiceBridgeOptions
): Promise<void> {
  await runVoiceMcpBridgeCli([
    "--socket",
    options.socket,
    "--caller-agent-id",
    callerAgentId,
  ]);
}
