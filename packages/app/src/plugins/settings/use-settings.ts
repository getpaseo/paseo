import type { SettingsState } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { type SettingsDefinition } from "@getpaseo/plugin";
import { settingsRpc } from "@getpaseo/plugin";
import { useReplicaQuery } from "@/data/query";
import { z, type ZodType } from "zod";

export const pluginSettingsKey = (id: string) => ["plugin-settings", id] as const;
function message(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join("\n");
  return error instanceof Error ? error.message : String(error);
}

export function useSettings<Schema extends ZodType>(
  definition: SettingsDefinition<Schema>,
): SettingsState<Schema> {
  const rpc = useMemo(() => settingsRpc(definition.id), [definition.id]);
  const read = useRpc(rpc.read);
  const write = useRpc(rpc.write);
  const reset = useRpc(rpc.reset);
  const client = useQueryClient();
  const key = pluginSettingsKey(definition.id);
  const query = useReplicaQuery({
    queryKey: key,
    pushEvent: "plugin_settings_changed",
    queryFn: () => read({}),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async (
      input: { revision: string; values: z.output<Schema> } | { revision: string },
    ) => {
      const result =
        "values" in input
          ? await write({
              revision: input.revision,
              values: z.json().parse(await definition.schema.parseAsync(input.values)),
            })
          : await reset(input);
      if (result.status !== "saved") throw new Error(result.error);
      client.setQueryData(key, { ...result, status: "ready" });
    },
  });
  async function save(values: z.output<Schema>, revision: string) {
    try {
      await mutation.mutateAsync({ values, revision });
      return true;
    } catch {
      return false;
    }
  }
  async function resetValues() {
    if (!query.data) return false;
    try {
      await mutation.mutateAsync({ revision: query.data.revision });
      return true;
    } catch {
      return false;
    }
  }
  const actions = {
    saving: mutation.isPending,
    saveError: mutation.error ? message(mutation.error) : null,
    save,
    reset: resetValues,
    reload: async () => {
      mutation.reset();
      await query.refetch();
    },
  };
  if (query.isPending) return { ...actions, status: "loading" };
  if (query.isError) return { ...actions, status: "error", error: message(query.error) };
  if (query.data.status === "invalid") return { ...actions, ...query.data };
  const parsed = definition.schema.safeParse(query.data.values);
  if (!parsed.success)
    return {
      ...actions,
      status: "invalid",
      revision: query.data.revision,
      error: parsed.error.message,
    };
  return { ...actions, ...query.data, values: parsed.data };
}
