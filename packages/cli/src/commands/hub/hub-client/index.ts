import type { HubBundleFile } from "../deploy-bundle.js";
import { HubCommandError } from "../error.js";
import {
  authorizationPollSchema,
  authorizationSchema,
  configurationResourcesSchema,
  enrollmentTokenSchema,
  installResponseSchema,
  projectsResponseSchema,
  triggersResponseSchema,
  triggerInstallationResponseSchema,
  triggerValidationResponseSchema,
  validationResponseSchema,
  type CliAuthorization,
  type CliAuthorizationPoll,
  type HubInstallResult,
  type HubConfigurationResources,
  type HubProject,
  type HubTrigger,
  type HubTriggerInstallationResult,
  type HubTriggerValidationResult,
  type HubValidationResult,
} from "./internal/contracts.js";
import { requestHub } from "./internal/transport.js";

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

  async listTriggers(origin: string, apiKey: string): Promise<HubTrigger[]> {
    const response = await requestHub({
      origin,
      path: "/api/v1/triggers",
      method: "GET",
      apiKey,
      successStatus: 200,
      schema: triggersResponseSchema,
      failureMessage: "Hub trigger export failed",
    });
    return response.triggers;
  }

  validateTrigger(
    origin: string,
    apiKey: string,
    yaml: string,
  ): Promise<HubTriggerValidationResult> {
    return requestHub({
      origin,
      path: "/api/v1/triggers/validate",
      method: "POST",
      apiKey,
      body: { yaml },
      successStatus: 200,
      schema: triggerValidationResponseSchema,
      failureMessage: "Hub trigger validation failed",
    });
  }

  installTrigger(
    origin: string,
    apiKey: string,
    yaml: string,
  ): Promise<HubTriggerInstallationResult> {
    return requestHub({
      origin,
      path: "/api/v1/triggers/install",
      method: "POST",
      apiKey,
      body: { yaml },
      successStatus: 201,
      schema: triggerInstallationResponseSchema,
      failureMessage: "Hub trigger deployment failed",
    });
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
