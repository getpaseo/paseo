import type { WorkflowValidationResult } from "@getpaseo/protocol/workflow/types";

export interface WorkflowLaunchForm {
  values: Record<string, string>;
  errors: Record<string, string>;
}

export function openWorkflowLaunchForm(validation: WorkflowValidationResult): WorkflowLaunchForm {
  return {
    values: Object.fromEntries(
      validation.parameters.map((parameter) => [
        parameter.name,
        formatDefaultValue(parameter.defaultValue),
      ]),
    ),
    errors: {},
  };
}

export function updateWorkflowLaunchValue(
  form: WorkflowLaunchForm,
  name: string,
  value: string,
): WorkflowLaunchForm {
  const { [name]: _removed, ...errors } = form.errors;
  return { values: { ...form.values, [name]: value }, errors };
}

export function submitWorkflowLaunchForm(
  form: WorkflowLaunchForm,
  validation: WorkflowValidationResult,
): { ok: true; parameters: Record<string, unknown> } | { ok: false; form: WorkflowLaunchForm } {
  const parameters: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const declaration of validation.parameters) {
    const raw = form.values[declaration.name]?.trim() ?? "";
    if (!raw) {
      if (declaration.required && declaration.defaultFrom === undefined) {
        errors[declaration.name] = "Required";
      }
      continue;
    }
    try {
      parameters[declaration.name] = parseParameterValue(raw, declaration.type);
    } catch (error) {
      errors[declaration.name] = error instanceof Error ? error.message : String(error);
    }
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, form: { ...form, errors } };
  }
  return { ok: true, parameters };
}

function formatDefaultValue(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseParameterValue(
  raw: string,
  type: WorkflowValidationResult["parameters"][number]["type"],
) {
  if (type === "string" || type === "path" || type === "image" || type === "enum") return raw;
  if (type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error("Enter true or false");
  }
  if (type === "integer" || type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) {
      throw new Error(type === "integer" ? "Enter an integer" : "Enter a number");
    }
    return value;
  }
  const value = JSON.parse(raw) as unknown;
  if (type === "array" && !Array.isArray(value)) throw new Error("Enter a JSON array");
  if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("Enter a JSON object");
  }
  return value;
}
