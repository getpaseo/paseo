import { describe, expect, it } from "vitest";

import { zhCN } from "./zh-CN";

describe("zh-CN visible UI copy", () => {
  it("does not mix English nouns into common workspace and project actions", () => {
    expect(zhCN.workspace.header.actions.copyPath).toBe("复制工作区路径");
    expect(zhCN.workspace.git.openInEditor.openIn).toBe("在 {{target}} 中打开工作区");
    expect(zhCN.sidebar.project.actions.openSettings).toBe("打开项目设置");
    expect(zhCN.sidebar.project.actions.remove).toBe("移除项目");
    expect(zhCN.settings.project.backToProjects).toBe("返回项目");
  });

  it("fully localizes project detail controls and metadata labels", () => {
    expect(zhCN.settings.project.worktree.title).toBe("Worktree 生命周期钩子");
    expect(zhCN.settings.project.worktree.setup).toBe("初始化");
    expect(zhCN.settings.project.worktree.teardown).toBe("清理");
    expect(zhCN.settings.project.scripts.title).toBe("脚本");
    expect(zhCN.settings.project.scripts.empty).toBe("还没有脚本。");
    expect(zhCN.settings.project.scripts.actions.add).toBe("添加脚本");
    expect(zhCN.settings.project.metadata.pullRequest).toBe("拉取请求（PR）");
  });

  it("localizes visible provider, appearance, home, and terminal labels", () => {
    expect(zhCN.settings.providers.models.many).toBe("{{count}} 个模型");
    expect(zhCN.settings.providers.models.searchPlaceholder).toBe("搜索模型");
    expect(zhCN.settings.appearance.theme.options.light).toBe("浅色");
    expect(zhCN.settings.appearance.theme.options.dark).toBe("深色");
    expect(zhCN.openProject.tiles.addProject.title).toBe("添加项目");
    expect(zhCN.openProject.tiles.setupProviders.title).toBe("设置提供商");
    expect(zhCN.settings.host.terminalProfiles.hooksTitle).toBe("启用终端 Agent 钩子");
  });

  it("localizes attachment and device-pairing edge states", () => {
    expect(zhCN.composer.attachments.addIssueOrPr).toBe("添加 Issue 或 PR");
    expect(zhCN.composer.github.searchPlaceholder).toBe("搜索 Issue 和 PR...");
    expect(zhCN.pairing.device.loadingOffer).toBe("正在加载配对信息...");
  });
});
