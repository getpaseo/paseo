import { z } from "zod";
import type { HubBundleFile } from "./deploy-bundle.js";
import { HubCommandError } from "./error.js";

const activationUrlSchema = z.url({ protocol: /^https?$/u });
const authorizationSchema = z
  .object({
    deviceCode: z.string().min(32),
    userCode: z.string().min(1),
    verificationUri: activationUrlSchema,
    verificationUriComplete: activationUrlSchema,
    expiresAt: z.string().datetime(),
    interval: z.number().int().min(1),
  })
  .strict();
const authorizationPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), interval: z.number().int().min(1) }).strict(),
  z.object({ status: z.literal("slow_down"), interval: z.number().int().min(1) }).strict(),
  z
    .object({
      status: z.literal("authorized"),
      interval: z.number().int().min(1),
      credential: z.string().min(32),
      organizationId: z.string().min(1),
    })
    .strict(),
  z.object({ status: z.literal("denied"), interval: z.number().int().min(1) }).strict(),
  z.object({ status: z.literal("expired"), interval: z.number().int().min(1) }).strict(),
  z.object({ status: z.literal("disclosed"), interval: z.number().int().min(1) }).strict(),
  z.object({ status: z.literal("retry_later") }).strict(),
]);
const projectSchema = z
  .object({ id: z.string().uuid(), slug: z.string().min(1), name: z.string().min(1) })
  .strict();
const projectsResponseSchema = z.object({ projects: z.array(projectSchema) }).strict();
const installResponseSchema = z
  .object({
    projectSlug: z.string().min(1),
    version: z.number().int().positive(),
    versionId: z.string().uuid(),
    active: z.literal(true),
  })
  .strict();
const validationResponseSchema = z
  .object({ projectSlug: z.string().min(1), valid: z.literal(true) })
  .strict();
const enrollmentTokenSchema = z
  .object({ token: z.string().min(32), expiresAt: z.string().datetime() })
  .strict();
const issuePathSchema = z.union([z.string(), z.array(z.union([z.string(), z.number()]))]);
const fieldIssueSchema = z.object({
  field: z.string().optional(),
  path: issuePathSchema.optional(),
  message: z.string(),
});
const problemSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  status: z.number().int().optional(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z
    .union([z.array(fieldIssueSchema), z.record(z.string(), z.array(z.string()))])
    .optional(),
  issues: z.array(fieldIssueSchema).optional(),
});

export type CliAuthorization = z.infer<typeof authorizationSchema>;
export type CliAuthorizationPoll = z.infer<typeof authorizationPollSchema>;
export type HubProject = z.infer<typeof projectSchema>;
export type HubInstallResult = z.infer<typeof installResponseSchema>;
export type HubValidationResult = z.infer<typeof validationResponseSchema>;

interface HubConfigurationInput {
  origin: string;
  apiKey: string;
  projectSlug: string;
  files: readonly HubBundleFile[];
}

export class HubHttpClient {
  async startCliAuthorization(origin: string): Promise<CliAuthorization> {
    return this.request({
      origin,
      path: "/api/v1/cli-authorizations",
      method: "POST",
      body: {},
      successStatus: 201,
      schema: authorizationSchema,
      failureMessage: "Hub CLI login could not be started",
    });
  }

  async pollCliAuthorization(
    origin: string,
    deviceCode: string,
    timeoutMilliseconds: number,
  ): Promise<CliAuthorizationPoll> {
    try {
      return await this.request({
        origin,
        path: "/api/v1/cli-authorizations/poll",
        method: "POST",
        body: { deviceCode },
        successStatus: 200,
        schema: authorizationPollSchema,
        timeoutMilliseconds,
        failureMessage: "Hub CLI login polling failed",
      });
    } catch (error) {
      if (error instanceof HubCommandError && error.code === "HUB_NETWORK_ERROR") {
        return { status: "retry_later" };
      }
      throw error;
    }
  }

  async listProjects(origin: string, apiKey: string): Promise<HubProject[]> {
    const response = await this.request({
      origin,
      path: "/api/v1/projects",
      method: "GET",
      apiKey,
      successStatus: 200,
      schema: projectsResponseSchema,
      failureMessage: "Hub project listing failed",
    });
    return response.projects;
  }

  installConfiguration(input: HubConfigurationInput): Promise<HubInstallResult> {
    return this.request({
      origin: input.origin,
      path: "/api/v1/configurations/install",
      method: "POST",
      apiKey: input.apiKey,
      body: configurationBody(input),
      successStatus: 201,
      schema: installResponseSchema,
      failureMessage: "Hub deployment failed",
    });
  }

  validateConfiguration(input: HubConfigurationInput): Promise<HubValidationResult> {
    return this.request({
      origin: input.origin,
      path: "/api/v1/configurations/validate",
      method: "POST",
      apiKey: input.apiKey,
      body: configurationBody(input),
      successStatus: 200,
      schema: validationResponseSchema,
      failureMessage: "Hub configuration validation failed",
    });
  }

  async issueEnrollmentToken(origin: string, apiKey: string): Promise<string> {
    const response = await this.request({
      origin,
      path: "/api/v1/daemons/enrollment-tokens",
      method: "POST",
      apiKey,
      successStatus: 201,
      schema: enrollmentTokenSchema,
      failureMessage: "Hub daemon enrollment authorization failed",
    });
    return response.token;
  }

  private async request<T>(input: RequestInput<T>): Promise<T> {
    const signal = AbortSignal.timeout(input.timeoutMilliseconds ?? 15_000);
    let response: Response;
    try {
      response = await fetch(`${input.origin}${input.path}`, {
        method: input.method,
        headers: {
          ...(input.apiKey === undefined ? {} : { authorization: `Bearer ${input.apiKey}` }),
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal,
      });
    } catch {
      throw new HubCommandError(
        "HUB_NETWORK_ERROR",
        `Could not reach Paseo Hub at ${input.origin}. Check the Hub URL and network connection.`,
      );
    }
    if (response.status !== input.successStatus) {
      throw await requestFailure(response, input.failureMessage, input.apiKey);
    }
    try {
      return input.schema.parse(await response.json());
    } catch {
      throw new HubCommandError("HUB_INVALID_RESPONSE", "Hub returned a malformed response.");
    }
  }
}

interface RequestInput<T> {
  origin: string;
  path: string;
  method: "GET" | "POST";
  apiKey?: string;
  body?: unknown;
  successStatus: number;
  schema: z.ZodType<T>;
  timeoutMilliseconds?: number;
  failureMessage: string;
}

function configurationBody(input: HubConfigurationInput): object {
  return {
    projectSlug: input.projectSlug,
    files: input.files,
  };
}

async function requestFailure(
  response: Response,
  failureMessage: string,
  apiKey: string | undefined,
): Promise<HubCommandError> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/problem+json")) {
    return new HubCommandError(
      "HUB_REQUEST_FAILED",
      `${failureMessage} with HTTP ${response.status}.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new HubCommandError(
      "HUB_INVALID_RESPONSE",
      `Hub returned malformed problem details for HTTP ${response.status}.`,
    );
  }
  const parsed = problemSchema.safeParse(body);
  if (
    !parsed.success ||
    (parsed.data.status !== undefined && parsed.data.status !== response.status)
  ) {
    return new HubCommandError(
      "HUB_INVALID_RESPONSE",
      `Hub returned nonconforming problem details for HTTP ${response.status}.`,
    );
  }
  const title = parsed.data.title ?? `${failureMessage} with HTTP ${response.status}`;
  const message = parsed.data.detail === undefined ? title : `${title}: ${parsed.data.detail}`;
  const details = formatFieldIssues(parsed.data.errors, parsed.data.issues);
  const code = response.status === 422 ? "HUB_VALIDATION_FAILED" : "HUB_REQUEST_FAILED";
  return new HubCommandError(
    code,
    redactSecret(message, apiKey),
    details === undefined ? undefined : redactSecret(details, apiKey),
  );
}

function formatFieldIssues(
  errors: z.infer<typeof problemSchema>["errors"],
  issues: z.infer<typeof problemSchema>["issues"],
): string | undefined {
  const fieldIssues = Array.isArray(errors) ? errors : issues;
  if (fieldIssues !== undefined) {
    const lines = fieldIssues.map((issue) => {
      const field = issue.field ?? formatIssuePath(issue.path);
      return field === undefined ? issue.message : `${field}: ${issue.message}`;
    });
    return lines.length === 0 ? undefined : lines.join("\n");
  }
  if (errors === undefined) return undefined;
  const lines = Object.entries(errors).flatMap(([field, messages]) =>
    messages.map((message: string) => `${field}: ${message}`),
  );
  return lines.length === 0 ? undefined : lines.join("\n");
}

function formatIssuePath(path: z.infer<typeof issuePathSchema> | undefined): string | undefined {
  if (path === undefined || typeof path === "string") return path;
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") formatted += `[${segment}]`;
    else formatted += formatted.length === 0 ? segment : `.${segment}`;
  }
  return formatted || undefined;
}

function redactSecret(value: string, secret: string | undefined): string {
  return secret === undefined ? value : value.split(secret).join("[redacted]");
}
