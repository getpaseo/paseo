import { runVoiceMcpBridgeCli } from "@getpaseo/server";

type VoiceBridgeOptions = {
  socket: string;
  callerAgentId: string;
};

export async function runVoiceMcpBridgeCommand(
  options: VoiceBridgeOptions
): Promise<void> {
  await runVoiceMcpBridgeCli([
    "--socket",
    options.socket,
    "--caller-agent-id",
    options.callerAgentId,
  ]);
}
