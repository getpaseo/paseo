import type {
  PluginFloatingWidgetContribution,
  PluginFloatingWidgetSize,
  PluginText,
} from "@getpaseo/plugin/client";
import { requirePluginText } from "@getpaseo/plugin/client/host";

export function parseFloatingWidgetSize(size: PluginFloatingWidgetSize): PluginFloatingWidgetSize {
  if (
    !size ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > 1024 ||
    size.height > 1024
  ) {
    throw new Error("Floating widget size must be between 1 and 1024 logical pixels");
  }
  return { width: size.width, height: size.height };
}

export function parseFloatingWidget(
  contribution: PluginFloatingWidgetContribution<PluginText>,
): PluginFloatingWidgetContribution<PluginText> {
  const {
    Component,
    initialPosition = "bottom-right",
    initiallyVisible = true,
    chrome = "toolbar",
  } = contribution;
  if (
    typeof Component !== "function" &&
    !(typeof Component === "object" && Component !== null && "$$typeof" in Component)
  ) {
    throw new Error(`Floating widget ${contribution.id} is not a component`);
  }
  if (!["top-left", "top-right", "bottom-left", "bottom-right"].includes(initialPosition)) {
    throw new Error(`Floating widget ${contribution.id} has invalid initial position`);
  }
  if (typeof initiallyVisible !== "boolean") {
    throw new Error(`Floating widget ${contribution.id} has invalid visibility`);
  }
  if (chrome !== "toolbar" && chrome !== "none") {
    throw new Error(`Floating widget ${contribution.id} has invalid chrome`);
  }
  return {
    id: contribution.id,
    title: requirePluginText(contribution.title),
    Component,
    size: parseFloatingWidgetSize(contribution.size ?? { width: 160, height: 160 }),
    initialPosition,
    initiallyVisible,
    chrome,
  };
}
