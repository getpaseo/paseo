import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import {
  TaskAttachmentSchema,
  TaskCardSchema,
  type TaskAttachment,
  type TaskCard,
} from "@getpaseo/protocol/tasks/types";
import type { TaskUploadedFileAttachment } from "@getpaseo/protocol/tasks/rpc-schemas";
import { writeJsonFileAtomic } from "../atomic-file.js";

interface StoredTaskAttachment extends TaskAttachment {
  absolutePath: string;
}

interface StoredTaskCard extends Omit<TaskCard, "attachments"> {
  attachments: StoredTaskAttachment[];
}

const StoredTaskAttachmentSchema = TaskAttachmentSchema.extend({
  absolutePath: z.string(),
});

const StoredTaskCardSchema = TaskCardSchema.omit({ attachments: true }).extend({
  attachments: z.array(StoredTaskAttachmentSchema),
});

const StoredTaskStorePayloadSchema = z.object({
  tasks: z.array(StoredTaskCardSchema),
});

export class TaskStore {
  private readonly filePath: string;
  private readonly assetsDir: string;
  private readonly uploadsDir: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(paseoHome: string) {
    this.filePath = join(paseoHome, "tasks", "tasks.json");
    this.assetsDir = join(paseoHome, "tasks", "assets");
    this.uploadsDir = join(paseoHome, "uploads");
  }

  async list(projectId: string): Promise<TaskCard[]> {
    const payload = await this.read();
    return payload.tasks
      .filter((task) => task.projectId === projectId)
      .sort(
        (left, right) => left.order - right.order || left.createdAt.localeCompare(right.createdAt),
      )
      .map(stripAttachmentPaths);
  }

  async listAll(projectIds: ReadonlySet<string>): Promise<TaskCard[]> {
    const payload = await this.read();
    return payload.tasks
      .filter((task) => projectIds.has(task.projectId))
      .sort(
        (left, right) =>
          left.projectId.localeCompare(right.projectId) ||
          left.order - right.order ||
          left.createdAt.localeCompare(right.createdAt),
      )
      .map(stripAttachmentPaths);
  }

  async get(input: { projectId: string; taskId: string }): Promise<TaskCard | null> {
    const payload = await this.read();
    const task = payload.tasks.find((entry) => entry.id === input.taskId);
    if (!task || task.projectId !== input.projectId) {
      return null;
    }
    return stripAttachmentPaths(task);
  }

  async getById(taskId: string): Promise<TaskCard | null> {
    const payload = await this.read();
    const task = payload.tasks.find((entry) => entry.id === taskId);
    return task ? stripAttachmentPaths(task) : null;
  }

  async getAttachment(input: {
    projectId: string;
    taskId: string;
    attachmentId: string;
  }): Promise<StoredTaskAttachment | null> {
    const payload = await this.read();
    const task = payload.tasks.find((entry) => entry.id === input.taskId);
    if (!task || task.projectId !== input.projectId) {
      return null;
    }
    return task.attachments.find((attachment) => attachment.id === input.attachmentId) ?? null;
  }

  async create(input: {
    projectId: string;
    title: string;
    description: string;
    uploads: readonly TaskUploadedFileAttachment[];
  }): Promise<TaskCard> {
    return this.mutate(async (payload) => {
      const now = new Date().toISOString();
      const taskId = randomUUID();
      const attachments: StoredTaskAttachment[] = [];
      try {
        for (const upload of input.uploads) {
          attachments.push(
            await this.importUpload({
              projectId: input.projectId,
              taskId,
              upload,
              createdAt: now,
            }),
          );
        }
      } catch (error) {
        await this.removeTaskAssets(input.projectId, taskId, attachments);
        throw error;
      }
      const task: StoredTaskCard = {
        id: taskId,
        projectId: input.projectId,
        title: input.title.trim(),
        description: input.description,
        status: "active",
        attachments,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        order: nextOrder(payload.tasks, input.projectId),
      };
      return {
        payload: { tasks: [...payload.tasks, task] },
        result: stripAttachmentPaths(task),
      };
    });
  }

  async update(input: {
    projectId: string;
    taskId: string;
    title?: string;
    description?: string;
    status?: "active" | "completed";
  }): Promise<TaskCard | null> {
    return this.mutate(async (payload) => {
      const index = payload.tasks.findIndex((task) => task.id === input.taskId);
      if (index < 0) {
        return { payload, result: null };
      }
      const current = payload.tasks[index];
      if (current.projectId !== input.projectId) {
        return { payload, result: null };
      }
      const now = new Date().toISOString();
      const nextStatus = input.status ?? current.status;
      const completedAt = resolveCompletedAt(current, nextStatus, now);
      const next: StoredTaskCard = {
        ...current,
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        status: nextStatus,
        completedAt,
        updatedAt: now,
      };
      const tasks = [...payload.tasks];
      tasks[index] = next;
      return { payload: { tasks }, result: stripAttachmentPaths(next) };
    });
  }

  async delete(input: { projectId: string; taskId: string }): Promise<boolean> {
    return this.mutate(async (payload) => {
      const task = payload.tasks.find((entry) => entry.id === input.taskId);
      if (!task || task.projectId !== input.projectId) {
        return { payload, result: false };
      }
      const tasks = payload.tasks.filter((entry) => entry.id !== input.taskId);
      await this.removeTaskAssets(task.projectId, task.id, task.attachments);
      return { payload: { tasks }, result: true };
    });
  }

  private async read(): Promise<{ tasks: StoredTaskCard[] }> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      return StoredTaskStorePayloadSchema.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { tasks: [] };
      }
      throw error;
    }
  }

  private async persist(payload: { tasks: StoredTaskCard[] }): Promise<void> {
    await writeJsonFileAtomic(this.filePath, payload);
  }

  private mutate<T>(
    fn: (payload: { tasks: StoredTaskCard[] }) => Promise<{
      payload: { tasks: StoredTaskCard[] };
      result: T;
    }>,
  ): Promise<T> {
    const next = this.queue.then(async () => {
      const current = await this.read();
      const outcome = await fn(current);
      await this.persist(outcome.payload);
      return outcome.result;
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async importUpload(input: {
    projectId: string;
    taskId: string;
    upload: TaskUploadedFileAttachment;
    createdAt: string;
  }): Promise<StoredTaskAttachment> {
    const id = randomUUID();
    const fileName = sanitizeFileName(input.upload.fileName);
    const targetDir = join(this.assetsDir, sanitizePathSegment(input.projectId), input.taskId);
    const targetPath = join(targetDir, `${id}${extname(fileName) || ""}`);
    const source = await this.resolveUploadPath(input.upload);
    await mkdir(targetDir, { recursive: true });
    try {
      await rename(source.path, targetPath);
    } catch {
      await copyFile(source.path, targetPath);
      await rm(source.path, { force: true }).catch(() => undefined);
    }
    await rm(source.uploadDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      id,
      fileName,
      mimeType: input.upload.mimeType,
      size: input.upload.size,
      createdAt: input.createdAt,
      absolutePath: targetPath,
    };
  }

  private async resolveUploadPath(upload: TaskUploadedFileAttachment): Promise<{
    path: string;
    uploadDir: string;
  }> {
    let uploadsRoot: string;
    try {
      uploadsRoot = await realpath(this.uploadsDir);
    } catch {
      throw new Error("Task attachment upload path is outside the upload staging directory");
    }
    const uploadPath = await realpath(upload.path);
    if (!isPathInside(uploadPath, uploadsRoot)) {
      throw new Error("Task attachment upload path is outside the upload staging directory");
    }
    const uploadDir = dirname(uploadPath);
    const relativeUploadDir = relative(uploadsRoot, uploadDir);
    if (
      !relativeUploadDir ||
      relativeUploadDir.includes("/") ||
      relativeUploadDir.includes("\\") ||
      relativeUploadDir.startsWith("..") ||
      isAbsolute(relativeUploadDir) ||
      basename(uploadDir) !== upload.id
    ) {
      throw new Error("Task attachment upload path does not match its upload record");
    }
    const info = await stat(uploadPath);
    if (!info.isFile()) {
      throw new Error("Task attachment upload path is not a file");
    }
    if (info.size !== upload.size) {
      throw new Error("Task attachment upload size does not match the uploaded file");
    }
    return { path: uploadPath, uploadDir };
  }

  private async removeTaskAssets(
    projectId: string,
    taskId: string,
    attachments: readonly StoredTaskAttachment[],
  ): Promise<void> {
    await Promise.all(
      attachments.map((attachment) => rm(attachment.absolutePath, { force: true })),
    );
    await rm(join(this.assetsDir, sanitizePathSegment(projectId), taskId), {
      recursive: true,
      force: true,
    });
  }
}

function stripAttachmentPaths(task: StoredTaskCard): TaskCard {
  return {
    ...task,
    attachments: task.attachments.map(
      ({ absolutePath: _absolutePath, ...attachment }) => attachment,
    ),
  };
}

function nextOrder(tasks: readonly StoredTaskCard[], projectId: string): number {
  let maxOrder = -1;
  for (const task of tasks) {
    if (task.projectId === projectId) {
      maxOrder = Math.max(maxOrder, task.order);
    }
  }
  return maxOrder + 1;
}

function resolveCompletedAt(
  current: StoredTaskCard,
  nextStatus: "active" | "completed",
  now: string,
): string | null {
  if (nextStatus === "completed") {
    return current.completedAt ?? now;
  }
  if (current.status === "completed") {
    return null;
  }
  return current.completedAt;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "project";
}

function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim();
  return name.length > 0 && name !== "." && name !== ".." ? name : "attachment";
}

function isPathInside(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return Boolean(child) && !child.startsWith("..") && !isAbsolute(child);
}
