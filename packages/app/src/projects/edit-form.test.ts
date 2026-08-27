import { describe, expect, it } from "vitest";
import { openProjectEditForm, type ProjectEditFormSnapshot } from "./edit-form";

const derivedName: ProjectEditFormSnapshot = {
  projectName: "grumpy-turtle",
  projectCustomName: null,
  hasCustomIcon: false,
  currentIconDataUri: "data:image/png;base64,ZGVyaXZlZA==",
};

const customIcon: ProjectEditFormSnapshot = {
  projectName: "Turtle",
  projectCustomName: "Turtle",
  hasCustomIcon: true,
  currentIconDataUri: "data:image/png;base64,Y3VzdG9t",
};

describe("project edit form model", () => {
  it("has nothing to submit until the user changes something", () => {
    expect(openProjectEditForm(derivedName).getState()).toMatchObject({
      name: "",
      canSubmit: false,
      canUseAutomatic: false,
      submission: { rename: null, icon: null },
    });
  });

  it("submits only the name when only the name changed", () => {
    const model = openProjectEditForm(derivedName);

    model.setName("  Turtle  ");

    expect(model.getState()).toMatchObject({
      canSubmit: true,
      submission: { rename: { customName: "Turtle" }, icon: null },
    });
  });

  it("clears the override when the name is emptied", () => {
    const model = openProjectEditForm(customIcon);

    model.setName("   ");

    expect(model.getState().submission.rename).toEqual({ customName: null });
  });

  it("treats a retyped identical name as no change", () => {
    const model = openProjectEditForm(customIcon);

    model.setName("Turtle");

    expect(model.getState()).toMatchObject({ canSubmit: false, submission: { rename: null } });
  });

  it("previews a picked image and submits it as an upload", () => {
    const model = openProjectEditForm(derivedName);

    model.setPickedImage({ fileName: "logo.png", mimeType: "image/png", data: "aW1hZ2U=" });

    expect(model.getState()).toMatchObject({
      previewDataUri: "data:image/png;base64,aW1hZ2U=",
      pickedFileName: "logo.png",
      canUseAutomatic: true,
      submission: { rename: null, icon: { type: "upload", data: "aW1hZ2U=" } },
    });
  });

  it("keeps a URL client-side and leaves the preview on the current icon", () => {
    const model = openProjectEditForm(derivedName);

    model.setImageUrl("  https://example.com  ");

    expect(model.getState()).toMatchObject({
      previewDataUri: derivedName.currentIconDataUri,
      pickedFileName: null,
      submission: { icon: { type: "url", url: "https://example.com" } },
    });
  });

  it("falls back to the earlier pick when the URL box is emptied", () => {
    const model = openProjectEditForm(derivedName);
    model.setPickedImage({ fileName: "logo.png", mimeType: "image/png", data: "aW1hZ2U=" });

    model.setImageUrl("https://example.com");
    expect(model.getState().submission.icon).toEqual({
      type: "url",
      url: "https://example.com",
    });

    model.setImageUrl("");
    expect(model.getState().submission.icon).toEqual({ type: "upload", data: "aW1hZ2U=" });
  });

  it("resets a stored custom icon back to automatic", () => {
    const model = openProjectEditForm(customIcon);

    expect(model.getState().canUseAutomatic).toBe(true);

    model.useAutomaticIcon();

    expect(model.getState()).toMatchObject({
      previewDataUri: null,
      canUseAutomatic: false,
      submission: { rename: null, icon: { type: "automatic" } },
    });
  });

  it("discards a pick without asking the daemon for an icon it already has", () => {
    const model = openProjectEditForm(derivedName);
    model.setPickedImage({ fileName: "logo.png", mimeType: "image/png", data: "aW1hZ2U=" });

    model.useAutomaticIcon();

    expect(model.getState()).toMatchObject({
      previewDataUri: derivedName.currentIconDataUri,
      canSubmit: false,
      submission: { rename: null, icon: null },
    });
  });

  it("clears the URL box when the user falls back to automatic", () => {
    const model = openProjectEditForm(customIcon);
    model.setImageUrl("https://example.com");
    const before = model.getState().urlResetKey;

    model.useAutomaticIcon();

    expect(model.getState().urlResetKey).not.toBe(before);
  });

  it("submits both fields together when both changed", () => {
    const model = openProjectEditForm(customIcon);

    model.setName("Renamed");
    model.setPickedImage({ fileName: "logo.png", mimeType: "image/png", data: "aW1hZ2U=" });

    expect(model.getState().submission).toEqual({
      rename: { customName: "Renamed" },
      icon: { type: "upload", data: "aW1hZ2U=" },
    });
  });

  it("drops a submit failure as soon as the user edits again", () => {
    const model = openProjectEditForm(derivedName);
    model.setError({ scope: "icon", message: "Enter a valid website or image URL" });

    expect(model.getState().error).toMatchObject({ scope: "icon" });

    model.setImageUrl("https://example.com");

    expect(model.getState().error).toBeNull();
  });
});
