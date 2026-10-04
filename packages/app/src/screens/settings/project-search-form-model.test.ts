import { describe, expect, it } from "vitest";
import { openProjectSearchForm } from "./project-search-form-model";

describe("project search directories form", () => {
  it("starts at home and keeps a draft until save succeeds", () => {
    const form = openProjectSearchForm();
    expect(form.getState().roots.map((root) => root.path)).toEqual(["~"]);
    expect(form.getState().canSave).toBe(false);
    form.addRoot();
    const added = form.getState().roots[1]!;
    expect(form.getState().canSave).toBe(false);
    form.setRoot(added.id, " /Volumes/Projects ");
    expect(form.getSubmission()).toEqual({ projects: { searchRoots: ["~", "/Volumes/Projects"] } });
    form.markSaved();
    expect(form.getState().canSave).toBe(false);
    form.setRoot(added.id, "/Volumes/Work");
    expect(form.getState().canSave).toBe(true);
  });

  it("rejects relative paths and accepts POSIX, tilde, drive and UNC paths", () => {
    const form = openProjectSearchForm();
    const id = form.getState().roots[0]!.id;
    for (const path of ["", "work", "./work", "~someone/work", "C:work"]) {
      form.setRoot(id, path);
      expect(form.getState().canSave).toBe(false);
      expect(form.getSubmission()).toBeNull();
    }
    for (const path of ["/Volumes/Work", "~/work", "C:\\work", "\\\\server\\share"]) {
      form.setRoot(id, path);
      expect(form.getState().canSave).toBe(true);
    }
  });

  it("preserves field identities when removing a directory and keeps at least one", () => {
    const form = openProjectSearchForm(["~", "/work", "/repos"]);
    const [home, work, repos] = form.getState().roots;
    form.removeRoot(work!.id);
    expect(form.getState().roots).toEqual([home, repos]);
    form.removeRoot(home!.id);
    form.removeRoot(repos!.id);
    expect(form.getState().roots).toEqual([repos]);
  });

  it("limits configured directories to the protocol limit", () => {
    const form = openProjectSearchForm(Array.from({ length: 16 }, (_, i) => `/work/${i}`));
    expect(form.getState().canAdd).toBe(false);
    form.addRoot();
    expect(form.getState().roots).toHaveLength(16);
  });

  it("resets to home through an explicit save without reusing edited inputs", () => {
    const form = openProjectSearchForm(["/work"]);
    const oldId = form.getState().roots[0]!.id;
    form.resetToHome();
    expect(form.getState().roots[0]!.id).not.toBe(oldId);
    expect(form.getState().roots[0]!.path).toBe("~");
    expect(form.getSubmission()).toEqual({ projects: {} });
    expect(form.getState().canSave).toBe(true);
  });

  it("does not replace unsaved edits when the host configuration refreshes", () => {
    const form = openProjectSearchForm(["~"]);
    const id = form.getState().roots[0]!.id;
    form.setRoot(id, "/my-draft");
    form.applySavedRoots(["/changed-elsewhere"]);
    expect(form.getState().roots[0]!.path).toBe("/my-draft");
    form.markSaved();
    form.applySavedRoots(["/another-device"]);
    expect(form.getState().roots[0]!.path).toBe("/another-device");
    expect(form.getState().canSave).toBe(false);
  });
});
