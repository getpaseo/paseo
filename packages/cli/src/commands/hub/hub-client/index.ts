import type { HubBundleFile } from "../deploy-bundle.js";
import { HubCommandError } from "../error.js";
import {
  authorizationPollSchema,
  authorizationSchema,
  configurationResourcesSchema,
  enrollmentTokenSchema,
  installResponseSchema,
  projectsResponseSchema,
  validationResponseSchema,
  type CliAuthorization,
  type CliAuthorizationPoll,
  type HubInstallResult,
  type HubConfigurationResources,
  type HubProject,
  type HubValidationResult,
} from "./internal/contracts.js";
import { requestHub } from "./internal/transport.js";

export type {
  CliAuthorization,
  CliAuthorizationPoll,
  HubInstallResult,
  HubConfigurationResources,
  HubProject,
  HubValidationResult,
} from "./internal/contracts.js";

interface HubConfigurationInput {
  origin: string;
  apiKey: string;
  projectSlug: string;
  files: readonly HubBundleFile[];
}

export class HubHttpClient {
  startCliAuthorization(origin: string): Promise<CliAuthorization> {
    return requestHub({
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
      return await requestHub({
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
    const response = await requestHub({
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

  listConfigurationResources(origin: string, apiKey: string): Promise<HubConfigurationResources> {
    return requestHub({
      origin,
      path: "/api/v1/configuration-resources",
      method: "GET",
      apiKey,
      successStatus: 200,
      schema: configurationResourcesSchema,
      failureMessage: "Hub configuration resource listing failed",
    });
  }

  installConfiguration(input: HubConfigurationInput): Promise<HubInstallResult> {
    return requestHub({
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
    return requestHub({
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
    const response = await requestHub({
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
}

function configurationBody(input: HubConfigurationInput): object {
  return { projectSlug: input.projectSlug, files: input.files };
}
