---
title: Hoplite
description: 为 Paseo 安装和配置 Hoplite。
nav: Hoplite
---

# Hoplite {#hoplite}

通过 daemon 主机上的 Hoplite CLI，在 Paseo 中运行 Hoplite 的云端编程 Agent。

## 开始使用 {#getting-started}

1. 在 daemon 主机上安装 [Hoplite CLI](https://hoplite.sh/docs/cli)。
2. 运行 `hoplite login`。
3. 在 Paseo 中打开 **设置 → Hosts → 你的主机 → Providers**，在目录里找到 **Hoplite** 并选择 **添加**。

Paseo 会启动 `hoplite acp`。认证和项目设置见 [Hoplite 的 ACP 指南](https://hoplite.sh/docs/cli/acp)。

如果 `hoplite` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers)，并在参数中保留 `acp`。

## 项目和云端工作区 {#projects-and-the-cloud-workspace}

Hoplite 在云端工作区中运行 Agent。你的本地文件和 Paseo 的回环 MCP 工具在该云端工作区中不可用。

请打开一个关联了 Hoplite 项目的仓库，或者设置 `agents.providers.hoplite.env.HOPLITE_PROJECT_ID`，在所有地方使用同一个项目。如果既没有关联的仓库也没有固定的项目，发现过程会报告 `No Hoplite project`。
