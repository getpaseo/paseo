# Native Fork 功能验收清单 (#1834)

对齐时间: 2026-07-02。四种核心场景 × 截图计划,验证 provider-native session fork 的截断机制、附件回退路径、以及跨 provider 的通用性。

## 场景矩阵

|                              | Claude/Codex(原生 fork) | Kiro/TRAE(原生 fork,无 per-message) |
|------------------------------|--------------------------|----------------------------------------|
| **按消息 fork → New tab**     | 场景 A1(核心:截断验证)   | (无此能力,跳过)                        |
| **按消息 fork → New Workspace** | 场景 A2(附件式回退验证)  | (无此能力,跳过)                        |
| **tab ⋮ 整段 Fork agent**     | 场景 C                   | 场景 D                                 |

## 前置:三轮会话

用 Codex 新建一个会话,连续发 3 轮(用于场景 A1/A2 的截断验证):
- msg1: "1+1等于几?" → assistant: "2"
- msg2: "2+2等于几?" → assistant: "4"
- msg3: "3+3等于几?" → assistant: "6"

Claude 复用已有的"你是什么模型"会话作为场景 C 的样本(不需要三轮)。

## 场景 A1 — Codex,按第 2 条消息 fork → New tab(核心:验证截断机制)

1. A1-1 原始会话总览(3 轮消息可见,标出将从 msg2 fork)
2. A1-2 悬浮 msg2 的 assistant 回复,fork 菜单图标出现
3. A1-3 点开 fork 下拉菜单(Fork in a new tab / new workspace 两个选项可见)
4. A1-4 点击 "new tab" 瞬间 — pending toast("Forking...")
5. A1-5 fork 完成 — success toast + 新 tab 出现
6. A1-6 新 tab 里发消息:"我们前面聊了几个算式?" / "第三个问题是什么?"
7. A1-7 assistant 回复 — **应该只提到 msg1/msg2("1+1","2+2"),不知道 msg3("3+3")** → 证明截断生效(不是整段复制)

## 场景 A2 — Codex,同一原始会话,同一条 msg2 fork → New Workspace

1. A2-1 同样打开 fork 菜单(可复用 A1-3 或重新截)
2. A2-2 点击 "new workspace" → 跳转到 `/new?draftId=...`
3. A2-3 新草稿页面显示 "Chat history / Previous conversation" 附件 pill(而不是原生历史 — 因为原生 session 绑定 provider+cwd 搬不走)

## 场景 C — Claude/Codex,tab ⋮ 整段 Fork agent

1. C-1 右键/点击 tab 的 ⋮ 菜单,"Fork agent" 入口可见
2. C-2 点击后 — pending toast
3. C-3 完成 — success toast + 新 tab
4. C-4(可选)新 tab 里滚动历史,证明是完整原生会话(不是附件),从底部/最后一条开始,无需截断

## 场景 D — Kiro 或 TRAE,tab ⋮ 整段 Fork agent

1. D-1 右键 ⋮ 菜单,"Fork agent" 入口可见(证明非 Claude/Codex 也有这个能力)
2. D-2 pending toast
3. D-3 success toast + 新 tab

## 交付物

- 约 17 张截图,分 4 节 + 1 个"截断验证"小节(A1-6/A1-7 是唯一需要"追问验证底层机制"的地方)
- 汇总生成 HTML 验收报告(tariq-html 风格),本地产出,**暂不推远端**,用户过一遍确认无误后才讨论是否推 PR
