import { randomUUID } from "node:crypto";
import {
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ChatError } from "./channels";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const DEFAULT_PRESIGN_TTL = 60 * 5; // 5 min

export const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/"];
export const ALLOWED_MIME_EXACT = new Set([
  "application/pdf",
  "application/zip",
  "application/json",
  "application/x-tar",
  "application/x-gzip",
  "application/octet-stream",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

export function assertAllowedMime(mime: string) {
  if (typeof mime !== "string" || mime.length === 0 || mime.length > 120) {
    throw new ChatError("bad_request", "Invalid mime type");
  }
  if (ALLOWED_MIME_EXACT.has(mime)) return;
  if (ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p))) return;
  throw new ChatError("bad_request", "Mime type not allowed");
}

export function assertAllowedSize(size: number, max = DEFAULT_MAX_BYTES) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new ChatError("bad_request", "Invalid size");
  }
  if (size > max) {
    throw new ChatError("bad_request", `File exceeds ${max} bytes`);
  }
}

export interface UploadConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
}

export function uploadConfigFromEnv(): UploadConfig | null {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION ?? "us-east-1";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: process.env.S3_ENDPOINT || undefined,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: !!process.env.S3_ENDPOINT,
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || undefined,
  };
}

export function buildS3Client(cfg: UploadConfig): S3Client {
  const clientConfig: S3ClientConfig = {
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // The AWS SDK v3 now injects x-amz-checksum-* headers by default. Most
    // S3-compatible stores (LocalStack, MinIO, R2) reject the empty default,
    // so only sign the checksum when the AWS API genuinely requires it.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
  if (cfg.endpoint) {
    clientConfig.endpoint = cfg.endpoint;
    clientConfig.forcePathStyle = cfg.forcePathStyle ?? true;
  }
  return new S3Client(clientConfig);
}

export interface PresignInput {
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  orgId: string;
}

export interface PresignResult {
  key: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  publicUrl: string;
  expiresAt: string;
}

export async function createPresignedUpload(
  cfg: UploadConfig,
  input: PresignInput,
  client?: S3Client,
  ttlSeconds = DEFAULT_PRESIGN_TTL,
): Promise<PresignResult> {
  assertAllowedMime(input.mimeType);
  assertAllowedSize(input.sizeBytes);

  const ext = safeExtension(input.filename);
  const key = `orgs/${input.orgId}/u/${input.userId}/${Date.now()}-${randomUUID()}${ext}`;
  const s3 = client ?? buildS3Client(cfg);
  // NOTE: we intentionally do not pin ContentLength on the signed command.
  // Some S3-compatible stores (e.g. LocalStack) reject PUTs whose headers
  // don't exactly match the signed Content-Length; skipping it keeps the
  // signed URL permissive and we enforce size server-side on a follow-up
  // HEAD after upload.
  const cmd = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ContentType: input.mimeType,
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: ttlSeconds });
  const publicUrl = cfg.publicBaseUrl
    ? `${cfg.publicBaseUrl.replace(/\/$/, "")}/${key}`
    : url.split("?")[0]!;
  return {
    key,
    url,
    method: "PUT",
    headers: {
      "Content-Type": input.mimeType,
    },
    publicUrl,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
}

function safeExtension(filename: string): string {
  const ext = filename.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0];
  return ext ? ext.toLowerCase() : "";
}
