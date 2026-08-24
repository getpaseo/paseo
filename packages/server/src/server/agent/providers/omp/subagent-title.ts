export function formatOmpSubagentTitle(title: string, resolvedModel?: string | null): string {
  const name = title.trim() || "OMP subagent";
  const model = resolvedModel?.trim();
  if (!model) return name;

  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    return `${name} · ${model}`;
  }

  const provider = model.slice(0, separator);
  const modelName = model.slice(separator + 1);
  return `${name} · ${modelName} (${provider})`;
}
