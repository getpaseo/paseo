import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalstackContainer, type StartedLocalStackContainer } from "@testcontainers/localstack";
import { CreateBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  ALLOWED_MIME_EXACT,
  assertAllowedMime,
  assertAllowedSize,
  buildS3Client,
  createPresignedUpload,
  type UploadConfig,
} from "./uploads";

const BUCKET = "hubcode-test";
let container: StartedLocalStackContainer;
let cfg: UploadConfig;
let s3: S3Client;

beforeAll(async () => {
  container = await new LocalstackContainer("localstack/localstack:3").start();
  cfg = {
    endpoint: container.getConnectionUri(),
    region: "us-east-1",
    bucket: BUCKET,
    accessKeyId: "test",
    secretAccessKey: "test",
    forcePathStyle: true,
  };
  s3 = buildS3Client(cfg);
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
}, 180_000);

afterAll(async () => {
  s3?.destroy();
  await container?.stop();
});

describe("mime & size validation", () => {
  it("accepts images, video, audio, and the exact-match whitelist", () => {
    expect(() => assertAllowedMime("image/png")).not.toThrow();
    expect(() => assertAllowedMime("video/mp4")).not.toThrow();
    expect(() => assertAllowedMime("audio/ogg")).not.toThrow();
    for (const mime of ALLOWED_MIME_EXACT) {
      expect(() => assertAllowedMime(mime)).not.toThrow();
    }
  });
  it("rejects executables and unknown types", () => {
    expect(() => assertAllowedMime("application/x-sh")).toThrow();
    expect(() => assertAllowedMime("application/x-msdownload")).toThrow();
    expect(() => assertAllowedMime("")).toThrow();
  });
  it("enforces size limits", () => {
    expect(() => assertAllowedSize(1)).not.toThrow();
    expect(() => assertAllowedSize(25 * 1024 * 1024)).not.toThrow();
    expect(() => assertAllowedSize(25 * 1024 * 1024 + 1)).toThrow();
    expect(() => assertAllowedSize(0)).toThrow();
    expect(() => assertAllowedSize(-1)).toThrow();
  });
});

describe("presigned PUT against LocalStack", () => {
  it("produces a URL that allows the object to be PUT directly", async () => {
    const presigned = await createPresignedUpload(
      cfg,
      {
        userId: "user_alice",
        orgId: "org_acme",
        filename: "screenshot.PNG",
        mimeType: "image/png",
        sizeBytes: 1024,
      },
      s3,
      300,
    );
    expect(presigned.url).toContain(BUCKET);
    expect(presigned.key).toMatch(/^orgs\/org_acme\/u\/user_alice\/\d+-[a-f0-9-]+\.png$/);

    const body = Buffer.alloc(1024, 0xab);
    const res = await fetch(presigned.url, {
      method: "PUT",
      body,
      headers: { "Content-Type": "image/png" },
    });
    expect(res.status).toBe(200);

    // Confirm the object is there.
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: presigned.key }));
    expect(head.ContentLength).toBe(1024);
    expect(head.ContentType).toBe("image/png");
  });

  it("rejects disallowed mime types before generating a URL", async () => {
    await expect(
      createPresignedUpload(
        cfg,
        {
          userId: "user_alice",
          orgId: "org_acme",
          filename: "run.sh",
          mimeType: "application/x-sh",
          sizeBytes: 100,
        },
        s3,
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});
