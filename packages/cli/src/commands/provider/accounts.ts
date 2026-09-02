import type {
  ProviderAccountProfile,
  ProviderAccountProvider,
} from "@getpaseo/protocol/provider-accounts";
import type { Command } from "commander";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";

export interface ProviderAccountListItem {
  id: string;
  provider: ProviderAccountProvider;
  name: string;
  default: "Yes" | "No";
  status: "Signed in" | "Not signed in";
  email: string;
  plan: string;
}

export const providerAccountsSchema: OutputSchema<ProviderAccountListItem> = {
  idField: "id",
  columns: [
    { header: "ACCOUNT ID", field: "id", width: 22 },
    { header: "PROVIDER", field: "provider", width: 10 },
    { header: "NAME", field: "name", width: 18 },
    { header: "DEFAULT", field: "default", width: 8 },
    { header: "STATUS", field: "status", width: 14 },
    { header: "EMAIL", field: "email", width: 28 },
    { header: "PLAN", field: "plan", width: 12 },
  ],
};

export function toProviderAccountRows(input: {
  accounts: ProviderAccountProfile[];
  defaults: Partial<Record<ProviderAccountProvider, string | null>>;
}): ProviderAccountListItem[] {
  return input.accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    name: account.name,
    default: input.defaults[account.provider] === account.id ? "Yes" : "No",
    status: account.lastAuthenticatedAt ? "Signed in" : "Not signed in",
    email: account.identity?.email ?? "-",
    plan: account.identity?.plan ?? "-",
  }));
}

export interface ProviderAccountsOptions extends CommandOptions {
  host?: string;
}

export async function runProviderAccountsCommand(
  options: ProviderAccountsOptions,
  _command: Command,
): Promise<ListResult<ProviderAccountListItem>> {
  const client = await connectToDaemon({ host: options.host });
  try {
    const payload = await client.listProviderAccounts();
    return {
      type: "list",
      data: toProviderAccountRows(payload),
      schema: providerAccountsSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
