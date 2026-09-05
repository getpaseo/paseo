export type BenchmarkProperty = string | number | boolean | null;

export interface BenchmarkMetricResult {
  unit: string;
  values: Record<string, number>;
  samples?: number[];
}

export interface BenchmarkCaseResult {
  id: string;
  dimensions: Record<string, BenchmarkProperty>;
  metrics: Record<string, BenchmarkMetricResult>;
}

export interface BenchmarkTaskResult {
  schemaVersion: 1;
  taskId: string;
  generatedAt: string;
  metadata?: Record<string, BenchmarkProperty>;
  cases: BenchmarkCaseResult[];
}

export interface BenchmarkRunResult {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    gitCommit: string;
    gitDirty: boolean;
  };
  runtime: {
    nodeVersion: string;
    platform: string;
    arch: string;
  };
  tasks: BenchmarkTaskResult[];
}

function parseRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseProperties(value: unknown, field: string): Record<string, BenchmarkProperty> {
  const raw = parseRecord(value, field);
  const properties: Record<string, BenchmarkProperty> = {};
  for (const [key, property] of Object.entries(raw)) {
    if (
      property !== null &&
      typeof property !== "string" &&
      typeof property !== "number" &&
      typeof property !== "boolean"
    ) {
      throw new Error(`${field}.${key} must be a scalar`);
    }
    if (typeof property === "number" && !Number.isFinite(property)) {
      throw new Error(`${field}.${key} must be a finite number`);
    }
    properties[key] = property;
  }
  return properties;
}

function parseMetric(value: unknown, field: string): BenchmarkMetricResult {
  const raw = parseRecord(value, field);
  const rawValues = parseRecord(raw.values, `${field}.values`);
  const values: Record<string, number> = {};
  for (const [key, metricValue] of Object.entries(rawValues)) {
    if (typeof metricValue !== "number" || !Number.isFinite(metricValue)) {
      throw new Error(`${field}.values.${key} must be a finite number`);
    }
    values[key] = metricValue;
  }

  let samples: number[] | undefined;
  if (raw.samples !== undefined) {
    if (
      !Array.isArray(raw.samples) ||
      raw.samples.some((sample) => typeof sample !== "number" || !Number.isFinite(sample))
    ) {
      throw new Error(`${field}.samples must contain finite numbers`);
    }
    samples = raw.samples;
  }

  return {
    unit: parseString(raw.unit, `${field}.unit`),
    values,
    ...(samples ? { samples } : {}),
  };
}

function parseCase(value: unknown, index: number): BenchmarkCaseResult {
  const field = `cases[${index}]`;
  const raw = parseRecord(value, field);
  const rawMetrics = parseRecord(raw.metrics, `${field}.metrics`);
  const metrics: Record<string, BenchmarkMetricResult> = {};
  for (const [key, metric] of Object.entries(rawMetrics)) {
    metrics[key] = parseMetric(metric, `${field}.metrics.${key}`);
  }
  return {
    id: parseString(raw.id, `${field}.id`),
    dimensions: parseProperties(raw.dimensions, `${field}.dimensions`),
    metrics,
  };
}

export function parseBenchmarkTaskResult(value: unknown): BenchmarkTaskResult {
  const raw = parseRecord(value, "benchmark result");
  if (raw.schemaVersion !== 1) {
    throw new Error("benchmark result.schemaVersion must be 1");
  }
  if (!Array.isArray(raw.cases)) {
    throw new Error("benchmark result.cases must be an array");
  }

  return {
    schemaVersion: 1,
    taskId: parseString(raw.taskId, "benchmark result.taskId"),
    generatedAt: parseString(raw.generatedAt, "benchmark result.generatedAt"),
    ...(raw.metadata === undefined
      ? {}
      : { metadata: parseProperties(raw.metadata, "benchmark result.metadata") }),
    cases: raw.cases.map(parseCase),
  };
}
