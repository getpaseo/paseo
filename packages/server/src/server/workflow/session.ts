import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { WorkflowService } from "./service.js";

interface WorkflowSessionHost {
  emit(message: SessionOutboundMessage): void;
}

export class WorkflowSession {
  constructor(
    private readonly host: WorkflowSessionHost,
    private readonly service: WorkflowService,
  ) {}

  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    switch (message.type) {
      case "workflow.spec.list.request":
        return this.listSpecs(message.requestId);
      case "workflow.spec.get.request":
        return this.getSpec(message.requestId, message.id);
      case "workflow.spec.save.request":
        return this.saveSpec(message.requestId, message.spec);
      case "workflow.spec.validate.request":
        return this.validateSpec(message.requestId, message.spec);
      case "workflow.run.start.request":
        return this.startRun(message.requestId, message);
      case "workflow.run.list.request":
        return this.listRuns(message.requestId);
      case "workflow.run.inspect.request":
        return this.inspectRun(message.requestId, message.runId);
      case "workflow.run.logs.request":
        return this.logs(message.requestId, message.runId, message.afterSeq);
      case "workflow.run.stop.request":
        return this.stopRun(message.requestId, message.runId);
      case "workflow.run.resume.request":
        return this.resumeRun(message.requestId, message.runId);
      default:
        return undefined;
    }
  }

  private async listSpecs(requestId: string): Promise<void> {
    try {
      this.host.emit({
        type: "workflow.spec.list.response",
        payload: { requestId, specs: await this.service.listSpecs(), error: null },
      });
    } catch (error) {
      this.host.emit({
        type: "workflow.spec.list.response",
        payload: { requestId, specs: [], error: errorMessage(error) },
      });
    }
  }

  private async getSpec(requestId: string, id: string): Promise<void> {
    try {
      const spec = await this.service.getSpec(id);
      const summary = (await this.service.listSpecs()).find((candidate) => candidate.id === id);
      if (!summary) throw new Error(`workflow spec not found: ${id}`);
      this.host.emit({
        type: "workflow.spec.get.response",
        payload: { requestId, spec, summary, error: null },
      });
    } catch (error) {
      this.host.emit({
        type: "workflow.spec.get.response",
        payload: { requestId, spec: null, summary: null, error: errorMessage(error) },
      });
    }
  }

  private async saveSpec(requestId: string, spec: Record<string, unknown>): Promise<void> {
    const validation = this.service.validateSpec(spec);
    try {
      const saved = await this.service.saveSpec(spec);
      this.host.emit({
        type: "workflow.spec.save.response",
        payload: {
          requestId,
          spec: saved.spec,
          summary: saved.summary,
          validation: saved.validation,
          error: null,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "workflow.spec.save.response",
        payload: {
          requestId,
          spec: null,
          summary: null,
          validation,
          error: errorMessage(error),
        },
      });
    }
  }

  private async validateSpec(requestId: string, spec: Record<string, unknown>): Promise<void> {
    try {
      this.host.emit({
        type: "workflow.spec.validate.response",
        payload: {
          requestId,
          validation: this.service.validateSpec(spec),
          error: null,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "workflow.spec.validate.response",
        payload: {
          requestId,
          validation: { valid: false, issues: [], summary: null, parameters: [] },
          error: errorMessage(error),
        },
      });
    }
  }

  private async startRun(
    requestId: string,
    message: Extract<SessionInboundMessage, { type: "workflow.run.start.request" }>,
  ): Promise<void> {
    try {
      const run = await this.service.startRun({
        workflowId: message.workflowId,
        parameters: message.parameters,
        context: message.context,
      });
      this.host.emit({
        type: "workflow.run.start.response",
        payload: { requestId, run, error: null },
      });
    } catch (error) {
      this.host.emit({
        type: "workflow.run.start.response",
        payload: { requestId, run: null, error: errorMessage(error) },
      });
    }
  }

  private async listRuns(requestId: string): Promise<void> {
    try {
      this.host.emit({
        type: "workflow.run.list.response",
        payload: { requestId, runs: await this.service.listRuns(), error: null },
      });
    } catch (error) {
      this.host.emit({
        type: "workflow.run.list.response",
        payload: { requestId, runs: [], error: errorMessage(error) },
      });
    }
  }

  private async inspectRun(requestId: string, runId: string): Promise<void> {
    try {
      this.host.emit({
        type: "workflow.run.inspect.response",
        payload: { requestId, details: await this.service.inspectRun(runId), error: null },
      });
    } catch (error) {
      this.host.emit({
        type: "workflow.run.inspect.response",
        payload: { requestId, details: null, error: errorMessage(error) },
      });
    }
  }

  private async logs(requestId: string, runId: string, afterSeq?: number): Promise<void> {
    try {
      const result = await this.service.logs(runId, afterSeq);
      this.host.emit({
        type: "workflow.run.logs.response",
        payload: { requestId, ...result, error: null },
      });
    } catch (error) {
      this.host.emit({
        type: "workflow.run.logs.response",
        payload: {
          requestId,
          run: null,
          entries: [],
          nextCursor: afterSeq ?? 0,
          error: errorMessage(error),
        },
      });
    }
  }

  private async stopRun(requestId: string, runId: string): Promise<void> {
    await this.runMutation("workflow.run.stop.response", requestId, () =>
      this.service.stopRun(runId),
    );
  }

  private async resumeRun(requestId: string, runId: string): Promise<void> {
    await this.runMutation("workflow.run.resume.response", requestId, () =>
      this.service.resumeRun(runId),
    );
  }

  private async runMutation(
    type: "workflow.run.stop.response" | "workflow.run.resume.response",
    requestId: string,
    operation: () => ReturnType<WorkflowService["stopRun"]>,
  ): Promise<void> {
    try {
      this.host.emit({
        type,
        payload: { requestId, run: await operation(), error: null },
      });
    } catch (error) {
      this.host.emit({
        type,
        payload: { requestId, run: null, error: errorMessage(error) },
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
