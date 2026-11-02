import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import { ko } from "@/i18n/resources/ko";
import { ru } from "@/i18n/resources/ru";
import { goalWaitingOnDetail, goalWaitingOnText } from "./goal-waiting-on";
import { makeChangeSet, makeGoal, makeTask } from "./test-utils/goal-fixture";

const i18n = createInstance();
let t: TFunction;

beforeAll(async () => {
  t = await i18n.init({
    lng: "en",
    fallbackLng: "en",
    compatibilityJSON: "v4",
    interpolation: { escapeValue: false },
    resources: { en: { translation: en }, ko: { translation: ko }, ru: { translation: ru } },
  });
});

const executing = { status: "executing" as const };

describe("goalWaitingOnText", () => {
  it("uses the plural form the count asks for", () => {
    const one = makeGoal({
      ...executing,
      tasks: [makeTask("t1", { status: "running", title: "Add tests" })],
    });
    expect(goalWaitingOnText(t, one)).toBe("Running Add tests");
    const two = makeGoal({
      ...executing,
      tasks: [makeTask("t1", { status: "running" }), makeTask("t2", { status: "running" })],
    });
    expect(goalWaitingOnText(t, two)).toBe("Running 2 tasks: t1, t2");
  });

  it("names held change sets and fixed phases", () => {
    const held = makeGoal({
      ...executing,
      changeSets: [makeChangeSet("cs-1", "t1", { status: "awaiting_human" })],
    });
    expect(goalWaitingOnText(t, held)).toBe("Waiting for your approval of cs-1");
    expect(goalWaitingOnText(t, makeGoal({ status: "awaiting_plan_approval" }))).toBe(
      "Waiting for your plan approval",
    );
  });

  it("translates, and is null for an ended goal", async () => {
    await i18n.changeLanguage("ko");
    expect(goalWaitingOnText(t, makeGoal({ status: "awaiting_plan_approval" }))).toBe(
      ko.goals.waitingOn.planApproval,
    );
    await i18n.changeLanguage("en");
    expect(goalWaitingOnText(t, makeGoal({ status: "failed" }))).toBeNull();
  });

  it("falls back to the protocol's English label for a missing key", async () => {
    const bare = createInstance();
    const bareT = await bare.init({ lng: "en", resources: { en: { translation: {} } } });
    expect(goalWaitingOnText(bareT, makeGoal({ status: "awaiting_plan_approval" }))).toBe(
      "plan approval",
    );
  });

  it("resolves the extra plural forms a language needs", async () => {
    await i18n.changeLanguage("ru");
    const three = makeGoal({
      ...executing,
      tasks: ["t1", "t2", "t3"].map((id) => makeTask(id, { status: "running" })),
    });
    expect(goalWaitingOnText(t, three)).toBe("Выполняются задачи (3): t1, t2, t3");
    await i18n.changeLanguage("en");
  });
});

describe("goalWaitingOnDetail", () => {
  it("keeps only phrases that name tasks or changes", () => {
    expect(goalWaitingOnDetail(t, makeGoal({ status: "awaiting_plan_approval" }))).toBeNull();
    const running = makeGoal({
      ...executing,
      tasks: [makeTask("t1", { status: "running", title: "Add tests" })],
    });
    expect(goalWaitingOnDetail(t, running)).toBe("Running Add tests");
  });
});
