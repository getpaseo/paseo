import { ipcRenderer } from "electron";
import type {
  WidgetAction,
  WidgetActionResult,
  WidgetDisplay,
  WidgetDisplayItem,
  WidgetQuestion,
} from "@getpaseo/protocol/desktop-agent-widget";

// Sandboxed preload: no runtime imports except Electron. Nothing is exposed to page content.
interface Draft {
  message: string;
  selections: number[][];
  texts: string[];
  question: number;
}
const drafts = new Map<string, Draft>();
let display: WidgetDisplay | null = null;
let selected = "";
let reduced = false;
let busy: WidgetDisplayItem | null = null;
let busyProfileId: string | undefined;
let notice = "";
let failed = false;
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
function draft(key: string): Draft {
  let value = drafts.get(key);
  if (!value) {
    value = { message: "", selections: [], texts: [], question: 0 };
    drafts.set(key, value);
  }
  return value;
}
function current() {
  return busy ?? display?.requests.find((item) => item.key === selected) ?? display?.requests[0];
}
function answered(question: WidgetQuestion, value: Draft, index: number) {
  if (value.selections[index]?.length) return true;
  const hasText = question.options.length === 0 || question.allowOther;
  return hasText && (Boolean(value.texts[index]?.trim()) || question.allowEmpty);
}
function canSubmit(item: WidgetDisplayItem) {
  return item.questions.every((question, index) => answered(question, draft(item.key), index));
}
function questionBody(item: WidgetDisplayItem): string {
  const value = draft(item.key);
  const index = Math.min(value.question, item.questions.length - 1);
  value.question = index;
  const question = item.questions[index];
  if (!question) return "";
  const tabs = item.questions
    .map(
      (entry, i) =>
        `<button data-focus="question-${i}" data-question="${i}" aria-current="${i === index}">${escape(entry.header)}</button>`,
    )
    .join("");
  const options = question.options
    .map(
      (option, i) =>
        `<label class="option"><input data-focus="option-${i}" type="${question.multiSelect ? "checkbox" : "radio"}" name="option" value="${i}" ${value.selections[index]?.includes(i) ? "checked" : ""} ${busy ? "disabled" : ""}><span>${escape(option.label)}<small>${escape(option.description ?? "")}</small></span></label>`,
    )
    .join("");
  const text = question.options.length === 0 || question.allowOther;
  const textInput = text
    ? `<label class="sr-only" for="answer">${escape(question.question)}</label><textarea id="answer" data-focus="answer" class="answer" placeholder="${escape(question.placeholder ?? "…")}" ${busy ? "disabled" : ""}>${escape(value.texts[index] ?? "")}</textarea>`
    : "";
  return `<div class="tabs">${tabs}</div><h2 class="question-title">${escape(question.question)}</h2><div class="options">${options}</div>${textInput}`;
}
function actions(item: WidgetDisplayItem): string {
  if (!display) return "";
  const labels = display.labels;
  const disabled = busy !== null || !item.online;
  if (item.kind === "plan") {
    const handoffReason = item.handoffDisabledReason;
    const profiles = item.handoffProfiles ?? [];
    const handoff = handoffReason
      ? ""
      : `<div class="action-row handoff-row"><span>${escape(labels.handoff)} :</span>${profiles.length ? profiles.map((profile) => `<button type="button" data-action="handoff" data-profile-id="${escape(profile.id)}" aria-busy="${busyProfileId === profile.id}" ${disabled ? "disabled" : ""}>${busyProfileId === profile.id ? `${escape(labels.pending)} · ` : ""}${escape(profile.name)}</button>`).join("") : `<span>${escape(labels.noProfiles ?? "Aucun profil disponible")}</span>`}</div>`;
    return `<form class="actions plan-actions"><div class="action-row"><label class="sr-only" for="comment">${escape(labels.comment)}</label><input id="comment" data-focus="comment" type="text" placeholder="${escape(labels.comment)}" value="${escape(draft(item.key).message)}" ${disabled ? "disabled" : ""}><button id="send-comment" type="submit" ${disabled || !draft(item.key).message.trim() ? "disabled" : ""}>${escape(labels.sendComment)}</button></div><div class="action-row"><button type="button" data-action="approve" class="primary" ${disabled || !item.canApprove ? "disabled" : ""}>${escape(labels.execute)} ↗</button></div>${handoff}${handoffReason ? `<small class="handoff-reason">${escape(handoffReason)}</small>` : ""}</form>`;
  }
  const value = draft(item.key);
  const last = value.question >= item.questions.length - 1;
  const valid = last
    ? canSubmit(item)
    : answered(item.questions[value.question], value, value.question);
  return `<div class="actions"><button data-focus="answer-button" id="answer-button" class="primary" data-action="${last ? "answer" : "question-next"}" ${disabled || !valid ? "disabled" : ""}>${escape(last ? labels.submit : labels.next)}</button></div>`;
}
interface ReadingPosition {
  focus?: string;
  caret: number | null;
  scroll: number;
}
function readingPosition(root: HTMLElement): ReadingPosition {
  const active = document.activeElement;
  const focus = active instanceof HTMLElement ? active.dataset.focus : undefined;
  const caret =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active.selectionStart
      : null;
  return { focus, caret, scroll: root.querySelector(".body")?.scrollTop ?? 0 };
}
function restoreReadingPosition(root: HTMLElement, position: ReadingPosition) {
  const body = root.querySelector(".body");
  if (body) body.scrollTop = position.scroll;
  if (!position.focus) return;
  const target = root.querySelector<HTMLElement>(`[data-focus="${position.focus}"]`);
  target?.focus({ preventScroll: true });
  if (position.caret === null) return;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.type === "radio" || target.type === "checkbox") return;
  target.setSelectionRange(position.caret, position.caret);
}
function requestContent(
  item: WidgetDisplayItem | undefined,
  labels: WidgetDisplay["labels"],
): string {
  if (!item) return `<div class="body empty">${escape(notice || labels.sent)}</div>`;
  const heading = item.kind === "plan" ? labels.plan : labels.question;
  const body =
    item.kind === "plan" ? `<div class="markdown">${item.planHtml}</div>` : questionBody(item);
  return `<div class="body"><p class="status">${escape(heading)}</p>${body}</div>${actions(item)}`;
}
function header(item: WidgetDisplayItem | undefined, labels: WidgetDisplay["labels"]) {
  const project = item?.project;
  const name = project?.name ?? item?.workspace ?? "";
  const initial = escape(Array.from(name.trim())[0]?.toUpperCase() ?? "");
  const icon = project?.emoji
    ? `<span class="avatar emoji">${escape(project.emoji)}</span>`
    : `<span class="avatar" style="background-color:${project?.color ?? "#7a6aa8"}"><span class="initial">${initial}</span>${project?.iconDataUri ? `<img src="${escape(project.iconDataUri)}" alt="">` : ""}</span>`;
  return `<header><div class="header-identity">${icon}<span class="identity"><b>${escape(name)}</b><small>${escape(project?.branchName ?? "")}</small></span></div><button data-action="reduce" aria-label="${escape(labels.minimize)}" title="${escape(labels.minimize)}">−</button></header>`;
}
function footer(position: number, count: number, labels: WidgetDisplay["labels"]) {
  const disabled = count < 2 || busy !== null;
  return `<footer class="queue"><span>${count ? position : 0} / ${count}</span><button data-action="previous" aria-label="←" ${disabled ? "disabled" : ""}>←</button><button data-action="next" aria-label="→" ${disabled ? "disabled" : ""}>→</button><button data-action="hide" aria-label="${escape(labels.close)}">×</button></footer>`;
}
function render() {
  const root = document.getElementById("widget");
  if (!root || !display) return;
  const positionBefore = readingPosition(root);
  const previous = selected;
  const item = current();
  selected = item?.key ?? "";
  const { labels, requests } = display;
  if (reduced) {
    root.innerHTML = `<div class="pill"><span aria-hidden="true">⠿</span><button data-action="restore"><b>Paseo</b> · ${requests.length}</button><button data-action="hide" aria-label="${escape(labels.close)}" title="${escape(labels.close)}">×</button></div>`;
    return;
  }
  const content = requestContent(item, labels);
  let status = notice;
  if (busy) status = labels.pending;
  else if (item && !item.online) status = labels.offline;
  const position =
    Math.max(
      0,
      requests.findIndex((entry) => entry.key === selected),
    ) + 1;
  const statusHtml = status
    ? `<p class="notice ${failed ? "error" : ""}" role="status">${escape(status)}</p>`
    : "";
  root.innerHTML = `<section class="sheet"><div class="surface">${header(item, labels)}${content}${statusHtml}${footer(position, requests.length, labels)}</div></section>`;
  const logo = root.querySelector<HTMLImageElement>(".avatar img");
  logo?.addEventListener("error", () => logo.remove(), { once: true });
  if (selected !== previous) return;
  restoreReadingPosition(root, positionBefore);
}
async function submit(action: WidgetAction) {
  const item = current();
  if (!item || !item.online || busy || !display) return;
  busy = item;
  busyProfileId = action.type === "handoff" ? action.profileId : undefined;
  notice = "";
  failed = false;
  render();
  try {
    const result: WidgetActionResult = await ipcRenderer.invoke("paseo:agent-widget:act", action);
    if (result.error) throw new Error(result.error);
    display.requests = display.requests.filter((entry) => entry.key !== action.key);
    drafts.delete(action.key);
    notice = display.labels.sent;
  } catch (error) {
    failed = true;
    notice = error instanceof Error ? error.message : display.labels.failed;
    // Keep failed feedback accessible even if another client resolved the request meanwhile.
    if (!display.requests.some((entry) => entry.key === item.key))
      display.requests.push({ ...item, online: false });
  } finally {
    busy = null;
    busyProfileId = undefined;
    render();
  }
}
async function resize(value: boolean) {
  await ipcRenderer.invoke("paseo:agent-widget:reduce", value);
}
function move(direction: number) {
  if (!display?.requests.length || busy) return;
  const index = display.requests.findIndex((item) => item.key === selected);
  selected =
    display.requests[(index + direction + display.requests.length) % display.requests.length].key;
  notice = "";
  failed = false;
  render();
}
function submitHandoff(item: WidgetDisplayItem | undefined, profileId: string | undefined) {
  if (!item?.planCallId || item.planText === undefined || item.handoffDisabledReason || !profileId)
    return;
  void submit({
    type: "handoff",
    profileId,
    key: item.key,
    planCallId: item.planCallId,
    planText: item.planText,
  });
}
function handleClick(event: MouseEvent) {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("a")) {
    event.preventDefault();
    return;
  }
  const button = event.target.closest<HTMLButtonElement>("button");
  if (!button || button.disabled) return;
  const item = current();
  if (button.dataset.question && item) {
    draft(item.key).question = Number(button.dataset.question);
    render();
    return;
  }
  switch (button.dataset.action) {
    case "hide":
      void ipcRenderer.invoke("paseo:agent-widget:hide");
      break;
    case "reduce":
      void resize(true);
      break;
    case "restore":
      void resize(false);
      break;
    case "previous":
      move(-1);
      break;
    case "next":
      move(1);
      break;
    case "question-next":
      if (item) {
        draft(item.key).question++;
        render();
      }
      break;
    case "approve":
      if (item) void submit({ type: "approve", key: item.key });
      break;
    case "handoff":
      submitHandoff(item, button.dataset.profileId);
      break;
    case "answer":
      if (item) {
        const value = draft(item.key);
        void submit({
          type: "answer",
          key: item.key,
          selections: Array.from(
            { length: item.questions.length },
            (_, i) => value.selections[i] ?? [],
          ),
          texts: Array.from({ length: item.questions.length }, (_, i) => value.texts[i] ?? ""),
        });
      }
      break;
  }
}
function handleInput(event: Event) {
  const item = current();
  const element = event.target;
  if (!item || !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
    return;
  const value = draft(item.key);
  if (element.id === "comment") {
    value.message = element.value;
    const button = document.querySelector<HTMLButtonElement>("#send-comment");
    if (button) button.disabled = !value.message.trim() || !item.online || busy !== null;
    return;
  }
  if (element.id === "answer") {
    value.texts[value.question] = element.value;
    if (element.value) value.selections[value.question] = [];
  } else if (element.name === "option") {
    value.selections[value.question] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="option"]:checked'),
      (option) => Number(option.value),
    );
    value.texts[value.question] = "";
  }
  render();
}
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("widget")!.style.height = "100%";
  document.addEventListener("click", handleClick);
  document.addEventListener("input", handleInput);
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.isComposing ||
      !(event.target instanceof HTMLTextAreaElement) ||
      event.target.id !== "answer"
    )
      return;
    event.preventDefault();
    document.querySelector<HTMLButtonElement>("#answer-button")?.click();
  });
  document.addEventListener("submit", (event) => {
    event.preventDefault();
    const item = current();
    if (!item) return;
    const message = draft(item.key).message.trim();
    if (message) void submit({ type: "comment", key: item.key, message });
  });
  ipcRenderer.on("paseo:agent-widget:update", (_event, value: WidgetDisplay) => {
    const previousKeys = new Set(display?.requests.map((item) => item.key));
    const currentKey = current()?.key;
    const arrived = value.requests.some((item) => !previousKeys.has(item.key));
    const currentDisappeared =
      currentKey && !value.requests.some((item) => item.key === currentKey);
    display = value;
    render();
    if (currentDisappeared && !arrived && !busy && !reduced) void resize(true);
  });
  ipcRenderer.on("paseo:agent-widget:reduced", (_event, value: boolean) => {
    reduced = value;
    render();
  });
  void ipcRenderer.invoke("paseo:agent-widget:ready").then((value: WidgetDisplay | null) => {
    display = value;
    render();
    return;
  });
});

// This window has its own preload and drafts; main-window readiness cannot speak for it.
const localBuildId = process.argv.find((arg) => arg.startsWith("--paseo-build-id="))?.slice(17);
if (localBuildId) {
  window.addEventListener("DOMContentLoaded", () => {
    let lastActivity = 0;
    for (const event of ["pointermove", "pointerdown", "keydown", "wheel", "input"]) {
      document.addEventListener(
        event,
        () => {
          if (Date.now() - lastActivity < 250) return;
          lastActivity = Date.now();
          void ipcRenderer.invoke("paseo:local-update:activity");
        },
        true,
      );
    }
    const banner = document.createElement("aside");
    banner.setAttribute("role", "status");
    Object.assign(banner.style, {
      position: "fixed",
      bottom: "20px",
      left: "20px",
      right: "20px",
      background: "#383534",
      color: "#f9f7f4",
      borderRadius: "8px",
      padding: "12px",
      zIndex: "1000",
      font: "12px system-ui",
    });
    const label = document.createElement("span");
    const postpone = document.createElement("button");
    postpone.textContent = "Reporter 30 min";
    postpone.addEventListener("click", () => {
      void ipcRenderer.invoke("paseo:local-update:postpone");
    });
    banner.append(label, postpone);
    ipcRenderer.on(
      "paseo:local-update:status",
      (_event, value: { phase: string; deadline?: number; error?: string }) => {
        if (value.phase === "current") {
          banner.remove();
          return;
        }
        label.textContent = "Mise à jour prête — activation au repos ";
        if (value.phase === "error") label.textContent = value.error ?? "Mise à jour non activée";
        if (value.phase === "countdown")
          label.textContent = `Mise à jour dans ${Math.max(0, Math.ceil(((value.deadline ?? 0) - Date.now()) / 1000))} s `;
        postpone.hidden = value.phase === "error" || value.phase === "activating";
        if (!banner.isConnected) document.body.append(banner);
      },
    );
    ipcRenderer.on("paseo:local-update:prepare", (_event, token: string) => {
      void ipcRenderer.invoke("paseo:local-update:prepared", token, {
        ok: !busy,
        state: { drafts: [...drafts], selected, reduced },
      });
    });
    void ipcRenderer
      .invoke("paseo:local-update:popup-state")
      .then(
        (value: { drafts?: [string, Draft][]; selected?: string; reduced?: boolean } | null) => {
          if (value?.drafts) for (const [key, entry] of value.drafts) drafts.set(key, entry);
          if (value?.selected) selected = value.selected;
          if (typeof value?.reduced === "boolean") reduced = value.reduced;
          render();
          return ipcRenderer.invoke("paseo:local-update:ready", localBuildId);
        },
      );
  });
}
