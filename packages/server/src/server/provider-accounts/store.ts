import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  normalizeProviderAccountName,
  providerAccountNameKey,
  ProviderAccountProfileSchema,
  ProviderAccountProviderSchema,
  type ProviderAccountIdentity,
  type ProviderAccountProfile,
  type ProviderAccountProvider,
} from "@getpaseo/protocol/provider-accounts";
import { z } from "zod";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";

const ProviderAccountRegistrySchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(ProviderAccountProfileSchema),
    defaults: z.partialRecord(ProviderAccountProviderSchema, z.string().nullable()).default({}),
  })
  .strict();

interface ProviderAccountRegistry {
  version: 1;
  accounts: ProviderAccountProfile[];
  defaults: Partial<Record<ProviderAccountProvider, string | null>>;
}

export interface ProviderAccountRecord extends ProviderAccountProfile {
  runtimeHome: string;
}

export interface ProviderAccountStoreSnapshot {
  accounts: ProviderAccountRecord[];
  defaults: Partial<Record<ProviderAccountProvider, string | null>>;
}

interface ProviderAccountStoreOptions {
  now?: () => Date;
  createId?: () => string;
}

export class ProviderAccountNameConflictError extends Error {
  readonly code = "provider_account_name_conflict";

  constructor(provider: ProviderAccountProvider, name: string) {
    super(`${provider} already has an account named ${name}`);
    this.name = "ProviderAccountNameConflictError";
  }
}

export class ProviderAccountNotFoundError extends Error {
  readonly code = "provider_account_not_found";

  constructor(accountId: string) {
    super(`Provider account not found: ${accountId}`);
    this.name = "ProviderAccountNotFoundError";
  }
}

export class ProviderAccountStore {
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private registry: ProviderAccountRegistry | null = null;
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly root: string,
    options: ProviderAccountStoreOptions = {},
  ) {
    this.filePath = path.join(root, "accounts.json");
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `pac_${randomBytes(8).toString("hex")}`);
  }

  list(): ProviderAccountStoreSnapshot {
    const registry = this.load();
    return {
      accounts: registry.accounts.map((account) => this.toRecord(account)),
      defaults: { ...registry.defaults },
    };
  }

  get(accountId: string): ProviderAccountRecord | null {
    const account = this.load().accounts.find((entry) => entry.id === accountId);
    return account ? this.toRecord(account) : null;
  }

  create(input: {
    provider: ProviderAccountProvider;
    name: string;
  }): Promise<ProviderAccountRecord> {
    return this.serializeMutation(() => {
      const registry = this.load();
      const provider = ProviderAccountProviderSchema.parse(input.provider);
      const name = this.requireName(input.name);
      this.assertNameAvailable(registry.accounts, provider, name);
      const timestamp = this.now().toISOString();
      const account = ProviderAccountProfileSchema.parse({
        id: this.createId(),
        provider,
        name,
        identity: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastAuthenticatedAt: null,
      });
      const runtimeHome = this.runtimeHome(account);
      ensurePrivateDirectory(runtimeHome);
      const next = { ...registry, accounts: [...registry.accounts, account] };
      try {
        this.write(next);
      } catch (error) {
        rmSync(runtimeHome, { recursive: true, force: true });
        throw error;
      }
      return this.toRecord(account);
    });
  }

  rename(accountId: string, nextName: string): Promise<ProviderAccountRecord> {
    return this.serializeMutation(() => {
      const registry = this.load();
      const account = this.requireAccount(registry, accountId);
      const name = this.requireName(nextName);
      this.assertNameAvailable(registry.accounts, account.provider, name, account.id);
      const updated = ProviderAccountProfileSchema.parse({
        ...account,
        name,
        updatedAt: this.now().toISOString(),
      });
      this.write(this.replaceAccount(registry, updated));
      return this.toRecord(updated);
    });
  }

  updateIdentity(
    accountId: string,
    identity: ProviderAccountIdentity,
  ): Promise<ProviderAccountRecord> {
    return this.serializeMutation(() => {
      const registry = this.load();
      const account = this.requireAccount(registry, accountId);
      const timestamp = this.now().toISOString();
      const updated = ProviderAccountProfileSchema.parse({
        ...account,
        identity,
        updatedAt: timestamp,
        lastAuthenticatedAt: timestamp,
      });
      this.write(this.replaceAccount(registry, updated));
      return this.toRecord(updated);
    });
  }

  selectDefault(
    provider: ProviderAccountProvider,
    accountId: string | null,
  ): Promise<ProviderAccountStoreSnapshot> {
    return this.serializeMutation(() => {
      const registry = this.load();
      const parsedProvider = ProviderAccountProviderSchema.parse(provider);
      if (accountId !== null) {
        const account = this.requireAccount(registry, accountId);
        if (account.provider !== parsedProvider) {
          throw new Error(`${accountId} belongs to ${account.provider}, not ${parsedProvider}`);
        }
      }
      const next = {
        ...registry,
        defaults: { ...registry.defaults, [parsedProvider]: accountId },
      };
      this.write(next);
      return this.list();
    });
  }

  remove(accountId: string): Promise<void> {
    return this.serializeMutation(() => {
      const registry = this.load();
      const account = this.requireAccount(registry, accountId);
      const defaults = { ...registry.defaults };
      if (defaults[account.provider] === account.id) {
        defaults[account.provider] = null;
      }
      this.write({
        ...registry,
        accounts: registry.accounts.filter((entry) => entry.id !== account.id),
        defaults,
      });
      rmSync(this.runtimeHome(account), { recursive: true, force: true });
    });
  }

  private serializeMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = next.catch(() => undefined);
    return next;
  }

  private load(): ProviderAccountRegistry {
    if (this.registry) return this.registry;
    ensurePrivateDirectory(this.root);
    if (!existsSync(this.filePath)) {
      this.registry = { version: 1, accounts: [], defaults: {} };
      return this.registry;
    }
    const parsed = ProviderAccountRegistrySchema.parse(
      JSON.parse(readFileSync(this.filePath, "utf8")),
    );
    for (const account of parsed.accounts) {
      ensurePrivateDirectory(this.runtimeHome(account));
    }
    this.registry = parsed;
    return this.registry;
  }

  private write(registry: ProviderAccountRegistry): void {
    const parsed = ProviderAccountRegistrySchema.parse(registry);
    writePrivateFileAtomicSync(this.filePath, `${JSON.stringify(parsed, null, 2)}\n`);
    this.registry = parsed;
  }

  private runtimeHome(account: ProviderAccountProfile): string {
    return path.join(this.root, account.provider, account.id);
  }

  private toRecord(account: ProviderAccountProfile): ProviderAccountRecord {
    return {
      ...account,
      identity: account.identity ? { ...account.identity } : null,
      runtimeHome: this.runtimeHome(account),
    };
  }

  private requireAccount(
    registry: ProviderAccountRegistry,
    accountId: string,
  ): ProviderAccountProfile {
    const account = registry.accounts.find((entry) => entry.id === accountId);
    if (!account) throw new ProviderAccountNotFoundError(accountId);
    return account;
  }

  private requireName(input: string): string {
    const name = normalizeProviderAccountName(input);
    return ProviderAccountProfileSchema.shape.name.parse(name);
  }

  private assertNameAvailable(
    accounts: readonly ProviderAccountProfile[],
    provider: ProviderAccountProvider,
    name: string,
    exceptAccountId?: string,
  ): void {
    const key = providerAccountNameKey(name);
    const conflict = accounts.some(
      (account) =>
        account.provider === provider &&
        account.id !== exceptAccountId &&
        providerAccountNameKey(account.name) === key,
    );
    if (conflict) throw new ProviderAccountNameConflictError(provider, name);
  }

  private replaceAccount(
    registry: ProviderAccountRegistry,
    updated: ProviderAccountProfile,
  ): ProviderAccountRegistry {
    return {
      ...registry,
      accounts: registry.accounts.map((account) => (account.id === updated.id ? updated : account)),
    };
  }
}
