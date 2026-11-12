import type { HubBundleFile } from "../deploy-bundle.js";
import { HubCommandError } from "../error.js";
import type {
  CliAuthorization,
  CliAuthorizationPoll,
  HubInstallResult,
  HubConfigurationResources,
  HubProject,
  HubTrigger,
  HubTriggerInstallationResult,
  HubTriggerValidationResult,
  HubValidationResult,
} from "./internal/contracts.js";

export type {
  CliAuthorization,
  CliAuthorizationPoll,
  HubInstallResult,
  HubConfigurationResources,
  HubProject,
  HubTrigger,
  HubTriggerInstallationResult,
  HubTriggerValidationResult,
  HubValidationResult,
} from "./internal/contracts.js";

// The response and problem schemas load on the first request: every CLI command builds the hub
// command tree, which constructs a HubHttpClient, and only `paseo hub` sends requests.
async function loadHubRequest() {
  const contracts = await import("./internal/contracts.js");
  const { requestHub } = await import("./internal/transport.js");
  return { contracts, requestHub };
}

interface HubConfigurationInput {
  origin: string;
  apiKey: string;
  projectSlug: string;
  files: readonly HubBundleFile[];
}

export class HubHttpClient {
  async startCliAuthorization(origin: string): Promise<CliAuthorization> {
    const { requestHub, contracts } = await loadHubRequest();
    return requestHub({
      origin,
      path: "/api/v1/cli-authorizations",
      method: "POST",
      body: {},
      successStatus: 201,
      schema: contracts.authorizationSchema,
      failureMessage: "Hub CLI login could not be started",
    });
  }

  async pollCliAuthorization(
    origin: string,
    deviceCode: string,
    timeoutMilliseconds: number,
  ): Promise<CliAuthorizationPoll> {
    try {
      const { requestHub, contracts } = await loadHubRequest();
      return await requestHub({
        origin,
        path: "/api/v1/cli-authorizations/poll",
        method: "POST",
        body: { deviceCode },
        successStatus: 200,
        schema: contracts.authorizationPollSchema,
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
    const { requestHub, contracts } = await loadHubRequest();
    const response = await requestHub({
      origin,
      path: "/api/v1/projects",
      method: "GET",
      apiKey,
      successStatus: 200,
      schema: contracts.projectsResponseSchema,
      failureMessage: "Hub project listing failed",
    });
    return response.projects;
  }

  async listTriggers(origin: string, apiKey: string): Promise<HubTrigger[]> {
    const { requestHub, contracts } = await loadHubRequest();
    const response = await requestHub({
      origin,
      path: "/api/v1/triggers",
      method: "GET",
      apiKey,
      successStatus: 200,
      schema: contracts.triggersResponseSchema,
      failureMessage: "Hub trigger export failed",
    });
    return response.triggers;
  }

  async validateTrigger(
    origin: string,
    apiKey: string,
    yaml: string,
  ): Promise<HubTriggerValidationResult> {
    const { requestHub, contracts } = await loadHubRequest();
    return requestHub({
      origin,
      path: "/api/v1/triggers/validate",
      method: "POST",
      apiKey,
      body: { yaml },
      successStatus: 200,
      schema: contracts.triggerValidationResponseSchema,
      failureMessage: "Hub trigger validation failed",
    });
  }

  async installTrigger(
    origin: string,
    apiKey: string,
    yaml: string,
  ): Promise<HubTriggerInstallationResult> {
    const { requestHub, contracts } = await loadHubRequest();
    return requestHub({
      origin,
      path: "/api/v1/triggers/install",
      method: "POST",
      apiKey,
      body: { yaml },
      successStatus: 201,
      schema: contracts.triggerInstallationResponseSchema,
      failureMessage: "Hub trigger deployment failed",
    });
  }

  async listConfigurationResources(
    origin: string,
    apiKey: string,
  ): Promise<HubConfigurationResources> {
    const { requestHub, contracts } = await loadHubRequest();
    return requestHub({
      origin,
      path: "/api/v1/configuration-resources",
      method: "GET",
      apiKey,
      successStatus: 200,
      schema: contracts.configurationResourcesSchema,
      failureMessage: "Hub configuration resource listing failed",
    });
  }

  async installConfiguration(input: HubConfigurationInput): Promise<HubInstallResult> {
    const { requestHub, contracts } = await loadHubRequest();
    return requestHub({
      origin: input.origin,
      path: "/api/v1/configurations/install",
      method: "POST",
      apiKey: input.apiKey,
      body: configurationBody(input),
      successStatus: 201,
      schema: contracts.installResponseSchema,
      failureMessage: "Hub deployment failed",
    });
  }

  async validateConfiguration(input: HubConfigurationInput): Promise<HubValidationResult> {
    const { requestHub, contracts } = await loadHubRequest();
    return requestHub({
      origin: input.origin,
      path: "/api/v1/configurations/validate",
      method: "POST",
      apiKey: input.apiKey,
      body: configurationBody(input),
      successStatus: 200,
      schema: contracts.validationResponseSchema,
      failureMessage: "Hub configuration validation failed",
    });
  }

  async issueEnrollmentToken(origin: string, apiKey: string): Promise<string> {
    const { requestHub, contracts } = await loadHubRequest();
    const response = await requestHub({
      origin,
      path: "/api/v1/daemons/enrollment-tokens",
      method: "POST",
      apiKey,
      successStatus: 201,
      schema: contracts.enrollmentTokenSchema,
      failureMessage: "Hub daemon enrollment authorization failed",
    });
    return response.token;
  }
}

function configurationBody(input: HubConfigurationInput): object {
  return { projectSlug: input.projectSlug, files: input.files };
}
