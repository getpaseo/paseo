---
title: Hoplite
description: 为 Paseo 安装并添加 Hoplite。
nav: Hoplite
---

# Hoplite {#hoplite}

Paseo 通过你已安装的 `hoplite` CLI 提供的 Agent Client Protocol（`hoplite acp`）运行 Hoplite 的云端编程 Agent。

## 开始使用 {#getting-started}

启动 Agent 前，请先在 Paseo 设置中添加 Hoplite。

1. 在 daemon 主机上安装 [Hoplite CLI](https://hoplite.sh/docs/cli)。
2. 在终端中运行 `hoplite login`。
3. 在 Paseo 中打开 **设置 → Hosts → 你的主机 → Providers**，选择 **+ Provider**，找到 **Hoplite**，然后选择 **添加**。

认证和项目设置见 [Hoplite 的 ACP 指南](https://hoplite.sh/docs/cli/acp)。如果 `hoplite` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers#custom-binary)，并在参数中保留 `acp`。

## 项目和云端工作区 {#projects-and-the-cloud-workspace}

Hoplite 在云端工作区中运行 Agent。你的本地文件和 Paseo 的回环 MCP 工具在那里不可用。

请打开一个关联了 Hoplite 项目的仓库，或者设置 `agents.providers.hoplite.env.HOPLITE_PROJECT_ID`，在所有地方使用同一个项目。如果既没有关联的仓库也没有固定的项目，发现过程会报告 `No Hoplite project`。
