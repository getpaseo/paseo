import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { getCheckoutImageDiff, IMAGE_DIFF_MAX_SIDE_BYTES } from "./checkout-git.js";
import { runGitCommand } from "./run-git-command.js";

const repos: string[] = [];

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "paseo-image-diff-"));
  repos.push(repo);
  await runGitCommand(["init"], { cwd: repo });
  await runGitCommand(["config", "user.email", "test@example.com"], { cwd: repo });
  await runGitCommand(["config", "user.name", "Test User"], { cwd: repo });
  return repo;
}

async function png(color: { r: number; g: number; b: number; alpha?: number }): Promise<Buffer> {
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { ...color, alpha: color.alpha ?? 1 },
    },
  })
    .png()
    .toBuffer();
}

async function jpeg(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: color,
    },
  })
    .jpeg()
    .toBuffer();
}

async function sizedPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

async function commitImage(repo: string, path: string, bytes: Buffer): Promise<void> {
  await writeFile(join(repo, path), bytes);
  await runGitCommand(["add", path], { cwd: repo });
  await runGitCommand(["-c", "commit.gpgsign=false", "commit", "-m", `commit ${path}`], {
    cwd: repo,
  });
}

function expectAvailableImage(image: { status: string }) {
  expect(image).toMatchObject({ status: "available" });
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })));
});

describe("getCheckoutImageDiff", () => {
  it("returns old, new, and diff images for a modified PNG", async () => {
    const repo = await createRepo();
    await commitImage(repo, "baseline.png", await png({ r: 255, g: 0, b: 0 }));
    await writeFile(join(repo, "baseline.png"), await png({ r: 0, g: 255, b: 0 }));

    const result = await getCheckoutImageDiff(repo, {
      path: "baseline.png",
      compare: { mode: "uncommitted" },
    });

    expectAvailableImage(result.oldImage);
    expectAvailableImage(result.newImage);
    expect(result.diffImage).toMatchObject({
      status: "available",
      mimeType: "image/png",
      width: 2,
      height: 2,
    });
  });

  it("reads repo-relative image paths from a subdirectory workspace", async () => {
    const repo = await createRepo();
    const workspace = join(repo, "sub");
    await mkdir(workspace);
    await commitImage(repo, "sub/baseline.png", await png({ r: 255, g: 0, b: 0 }));
    await writeFile(join(workspace, "baseline.png"), await png({ r: 0, g: 255, b: 0 }));

    const result = await getCheckoutImageDiff(workspace, {
      path: "sub/baseline.png",
      compare: { mode: "uncommitted" },
    });

    expectAvailableImage(result.oldImage);
    expectAvailableImage(result.newImage);
    expectAvailableImage(result.diffImage);
  });

  it("returns only the new side for an untracked image", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "new.png"), await png({ r: 0, g: 0, b: 255 }));

    const result = await getCheckoutImageDiff(repo, {
      path: "new.png",
      compare: { mode: "uncommitted" },
    });

    expect(result.oldImage).toEqual({ status: "missing" });
    expect(result.newImage.status).toBe("available");
    expect(result.diffImage.status).toBe("missing");
  });

  it("returns only the old side for a deleted image", async () => {
    const repo = await createRepo();
    await commitImage(repo, "deleted.png", await png({ r: 255, g: 255, b: 0 }));
    await rm(join(repo, "deleted.png"));

    const result = await getCheckoutImageDiff(repo, {
      path: "deleted.png",
      compare: { mode: "uncommitted" },
    });

    expectAvailableImage(result.oldImage);
    expect(result.newImage.status).toBe("missing");
    expect(result.diffImage.status).toBe("missing");
  });

  it("uses oldPath for the old side of a renamed image", async () => {
    const repo = await createRepo();
    await commitImage(repo, "before.png", await png({ r: 255, g: 0, b: 0 }));
    await runGitCommand(["mv", "before.png", "after.png"], { cwd: repo });
    await writeFile(join(repo, "after.png"), await png({ r: 0, g: 255, b: 0 }));

    const result = await getCheckoutImageDiff(repo, {
      path: "after.png",
      oldPath: "before.png",
      compare: { mode: "uncommitted" },
    });

    expectAvailableImage(result.oldImage);
    expectAvailableImage(result.newImage);
    expectAvailableImage(result.diffImage);
  });

  it("uses the oldPath extension for the old side MIME type", async () => {
    const repo = await createRepo();
    await commitImage(repo, "before.jpg", await jpeg({ r: 255, g: 0, b: 0 }));
    await runGitCommand(["mv", "before.jpg", "after.png"], { cwd: repo });
    await writeFile(join(repo, "after.png"), await png({ r: 0, g: 255, b: 0 }));

    const result = await getCheckoutImageDiff(repo, {
      path: "after.png",
      oldPath: "before.jpg",
      compare: { mode: "uncommitted" },
    });

    expect(result.oldImage).toMatchObject({ status: "available", mimeType: "image/jpeg" });
    expect(result.newImage).toMatchObject({ status: "available", mimeType: "image/png" });
    expect(result.diffImage).toMatchObject({ status: "available", mimeType: "image/png" });
  });

  it("rejects paths outside the repository", async () => {
    const repo = await createRepo();

    await expect(
      getCheckoutImageDiff(repo, {
        path: "../outside.png",
        compare: { mode: "uncommitted" },
      }),
    ).rejects.toThrow(/inside the repository/i);
  });

  it("rejects absolute Windows paths", async () => {
    const repo = await createRepo();

    await expect(
      getCheckoutImageDiff(repo, {
        path: String.raw`C:\outside.png`,
        compare: { mode: "uncommitted" },
      }),
    ).rejects.toThrow(/repository-relative/i);
  });

  it("returns too_large instead of bytes when a side exceeds the cap", async () => {
    const repo = await createRepo();
    const oversized = Buffer.alloc(IMAGE_DIFF_MAX_SIDE_BYTES + 1, 1);
    await writeFile(join(repo, "huge.png"), oversized);

    const result = await getCheckoutImageDiff(repo, {
      path: "huge.png",
      compare: { mode: "uncommitted" },
    });

    expect(result.newImage).toEqual({
      status: "too_large",
      size: IMAGE_DIFF_MAX_SIDE_BYTES + 1,
      maxSize: IMAGE_DIFF_MAX_SIDE_BYTES,
    });
  });

  it("does not read a working-tree image through a symlink", async () => {
    const repo = await createRepo();
    const outsideDir = await mkdtemp(join(tmpdir(), "paseo-image-outside-"));
    repos.push(outsideDir);
    await writeFile(join(outsideDir, "outside.png"), await png({ r: 1, g: 2, b: 3 }));
    await symlink(join(outsideDir, "outside.png"), join(repo, "linked.png"));

    const result = await getCheckoutImageDiff(repo, {
      path: "linked.png",
      compare: { mode: "uncommitted" },
    });

    expect(result.newImage.status).toBe("read_error");
    expect(result.newImage).toMatchObject({
      status: "read_error",
      message: expect.stringMatching(/symlink/i),
    });
  });

  it("returns too_large before diffing images with too many decoded pixels", async () => {
    const repo = await createRepo();
    await commitImage(repo, "large.png", await sizedPng(4096, 4096));
    await writeFile(join(repo, "large.png"), await sizedPng(4096, 4096));

    const result = await getCheckoutImageDiff(repo, {
      path: "large.png",
      compare: { mode: "uncommitted" },
    });

    expect(result.diffImage.status).toBe("too_large");
  });

  it("returns a dimension mismatch diff status when dimensions change", async () => {
    const repo = await createRepo();
    await commitImage(repo, "baseline.png", await sizedPng(2, 2));
    await writeFile(join(repo, "baseline.png"), await sizedPng(3, 2));

    const result = await getCheckoutImageDiff(repo, {
      path: "baseline.png",
      compare: { mode: "uncommitted" },
    });

    expect(result.diffImage).toEqual({
      status: "dimension_mismatch",
      oldWidth: 2,
      oldHeight: 2,
      newWidth: 3,
      newHeight: 2,
    });
  });

  it("returns unsupported for non-image binary files", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "archive.zip"), Buffer.from([0, 1, 2, 3]));

    const result = await getCheckoutImageDiff(repo, {
      path: "archive.zip",
      compare: { mode: "uncommitted" },
    });

    expect(result.oldImage).toEqual({ status: "unsupported", mimeType: null });
    expect(result.newImage).toEqual({ status: "unsupported", mimeType: null });
    expect(result.diffImage).toEqual({ status: "unsupported", mimeType: null });
  });
});
