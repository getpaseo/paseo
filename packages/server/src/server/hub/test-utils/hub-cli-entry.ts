import { createHubCommand } from "../../../../../cli/src/commands/hub/index.js";
import { HubHttpClient } from "../../../../../cli/src/commands/hub/client.js";

const CONTRACT_API_KEY_PREFIX = "hub-contract-api-key:";

class HubContractHttpClient extends HubHttpClient {
  override async issueEnrollmentToken(_origin: string, apiKey: string): Promise<string> {
    if (!apiKey.startsWith(CONTRACT_API_KEY_PREFIX)) {
      throw new Error("Hub contract API key is invalid");
    }
    return apiKey.slice(CONTRACT_API_KEY_PREFIX.length);
  }
}

const argv = [process.argv[0] ?? "node", process.argv[1] ?? "paseo", ...process.argv.slice(3)];
await createHubCommand({ hub: new HubContractHttpClient(), env: {} }).parseAsync(argv, {
  from: "node",
});
