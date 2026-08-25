# 测试

## 理念

测试证明行为，而非结构。每个测试应该回答："这验证了什么用户可见或 API 可见的行为？"

## 测试驱动开发

按垂直切片工作：一个测试，一个实现，重复。每个测试响应你从上一个周期学到的内容。

```
正确（垂直）：
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3

错误（水平）：
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5
```

先写所有测试再写所有实现会产生糟糕的测试——你最终测试的是想象的行为，而不是实际的行为。

## 确定性优先

测试必须在每次运行中产生相同的结果：

- 没有条件断言或分支路径
- 不依赖时序、随机性或网络抖动
- 没有弱断言（`toBeTruthy`、`toBeDefined`）
- 断言完整的预期行为，而不是片段

```typescript
// 不好：有条件的且弱的
it("创建一个工具调用", async () => {
  const result = await createToolCall(input);
  if (result.ok) {
    expect(result.id).toBeDefined();
  }
});

// 好：确定性的且明确的
it("当 provider 超时时返回超时错误", async () => {
  const result = await createToolCall(input);
  expect(result).toEqual({
    ok: false,
    error: { code: "PROVIDER_TIMEOUT", waitedMs: 30000 },
  });
});
```

## 不稳定的测试就是 bug

永远不要因为测试不稳定就删除它。找到变异的来源（时间、随机性、竞态条件、共享状态、非确定性输出、环境漂移）并修复它。

## 真实依赖优于 mock

Mock 不是默认选择。它们需要一个明确的决定。

- **数据库**：真实的测试数据库，而不是 mock
- **API**：带有测试/沙箱凭据的真实 API，而不是请求 mock
- **文件系统**：会被清理的临时目录，而不是 fs mock

问："在运行时使用真实依赖，这还能成立吗？" 如果不能，就不要 mock。

### 改用可替换的适配器

当你需要测试隔离时，将代码设计为依赖是可注入的：

```typescript
interface EmailSender {
  send(to: string, body: string): Promise<void>;
}

// 生产环境
const realSender: EmailSender = { send: sendgrid.send };

// 测试：内存适配器
function createTestEmailSender() {
  const sent: Array<{ to: string; body: string }> = [];
  return {
    send: async (to: string, body: string) => {
      sent.push({ to, body });
    },
    sent,
  };
}
```

## 端到端意味着端到端

当测试被标记为端到端时，它调用真实服务。没有环境变量门控，没有条件跳过，没有 mock 外部依赖。

## 测试组织

- 将测试与实现放在一起：`thing.ts` + `thing.test.ts`
- 将复杂的设置提取为可复用的辅助函数
- 测试体应该读起来像普通英语
- 构建让复杂流程变简单的测试辅助函数词汇表

### 文件命名

Vitest 通过后缀来识别测试。后缀告诉运行器它属于哪个类别。

| 后缀                    | 是什么                                                       | 在哪里运行                                                              |
| ----------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `*.test.ts(x)`          | 单元测试——纯净、快速、无需 daemon                            | `npm run test:unit`                                                     |
| `*.posix.test.ts`       | 需要仅 POSIX 行为的单元测试                                  | unit，在 Windows 上跳过                                                 |
| `*.browser.test.ts`     | 需要真实浏览器（DOM）的应用测试                              | `npm run test:browser`（Vitest 浏览器模式，Playwright provider，无头 Chromium） |
| `*.e2e.test.ts`         | 针对真实 daemon 的端到端测试                                 | `npm run test:e2e`                                                      |
| `*.real.e2e.test.ts`    | 访问真实 provider（Claude/Codex/Copilot/OpenCode/Pi）的 E2E——需要在 `packages/server/.env.test` 中配置凭据 | `npm run test:integration:real` / `test:e2e:real`                     |
| `*.local.e2e.test.ts`   | 需要仅本地资源的 E2E                                         | `npm run test:integration:local` / `test:e2e:local`                     |

应用级 Playwright 浏览器 E2E 位于 `packages/app/e2e/*.spec.ts`，通过 `npm run test:e2e --workspace=@getpaseo/app` 运行（独立于 Vitest E2E）。访问真实 provider 的应用 Playwright spec 使用 `*.real.spec.ts`，通过 `npm run test:e2e:real --workspace=@getpaseo/app` 运行；默认的应用 E2E 项目会忽略该后缀，因此 CI 不需要 provider 凭据。

在线 provider 冒烟测试应属于 `*.real.e2e.test.ts`，而不是 `*.test.ts`，即使它们受环境变量保护。默认单元套件必须使用确定性 provider 适配器/伪造，以便缺失配额、认证中断和上游模型漂移不会阻塞正常 CI。

### 测试设置

- Server：`packages/server/src/test-utils/vitest-setup.ts` 加载 `.env.test`，设置 `PASEO_SUPERVISED=0`，并禁用 Git/SSH 提示。新的全局环境 shim 应添加到这里，而不是单独的测试中。
- App：`packages/app/vitest.setup.ts` 提供 `expo`/`__DEV__` shim，并 stub 一些仅原生模块（`react-native-unistyles`、`react-native-svg`、`expo-linking`、`@xterm/addon-ligatures`）。这里的 stub 适用于在 Node 中没有有意义行为的模块——而不是许可 mock 应用代码。

## 本地运行测试

本仓库的测试套件很重。批量运行会冻结机器，尤其是在多个 agent 并行运行时。

- 只运行你修改的文件：`npx vitest run <path> --bail=1`
- 除非明确要求，永远不要对整个工作区运行 `npm run test`。
- 对于大范围扫描，重定向到文件并在之后读取：`npx vitest run <path> --bail=1 > /tmp/test-output.txt 2>&1`
- 永远不要重新运行另一个 agent 已报告为绿色的套件。
- 对于全量套件的信心，推送到 CI 并检查 GitHub Actions。
- 永远不要在本地运行完整的 Playwright E2E 套件——将全量套件验证推迟到 CI。当你修改或需要证明特定流程时，允许针对性的 Playwright spec。
- 应用 Playwright spec 每次运行共享一个隔离的 daemon。创建项目或工作区的辅助函数必须在清理期间移除 daemon 项目记录，而不仅仅是删除临时目录。Agent 辅助函数必须将预期的 `workspaceId` 传递给 agent 创建；永远不要从 `cwd` 推断所有权。
- CI 可以将应用 Playwright 分片到多个作业中；每个分片仍然从全局设置拥有一个完整的隔离 daemon/relay/Metro 堆栈。重启 daemon 的辅助函数必须保留全局设置环境，包括禁用的语音/本地模型设置，以便重启不会改变被测试的表面或启动后台下载。

## 测试中的 agent 认证

Agent provider 处理自己的认证。不要向测试添加认证检查、环境变量门控或条件跳过。如果认证失败，报告它。

## 使用测试进行调试

将测试用作你的调试场地：

1. 向被测试的代码添加临时日志
2. 运行测试，观察实际值
3. 通过测试输出端到端地跟踪流程
4. 用实际输出确认每个假设
5. 完成后移除日志

测试输出是真相的来源，而不是你对代码的理解。

## 为可测试性设计

如果代码不可测试，重构它。迹象包括：

- 你想使用 mock
- 你无法注入依赖
- 你需要测试私有内部
- 设置需要太多全局状态

追求深度模块：小接口，深度实现。更少的方法 = 需要更少的测试，更简单的参数 = 更简单的设置。

## 两种测试类别，没有其他

本仓库中的每个测试恰好属于以下两种形式之一：

1. **使用端口和适配器的单元测试**——生产代码通过注入的接口接收其真实世界的依赖（数据库、HTTP、CLI 进程、时钟、随机性、文件系统、其他模块）。测试使用与生产模块放在一起的类型化内存伪造来接线。**没有 `vi.mock`、`vi.hoisted`、`vi.spyOn` 自己的导出、JSDOM、`@testing-library` 组件挂载、RN 测试渲染器、猴子补丁全局变量或伪造服务器夹具。** 如果测试需要其中任何一个，生产模块缺少一个端口——修复接口，然后针对伪造适配器编写测试。
2. **真实的端到端测试**——真实的 daemon，真实的网络，真实的浏览器（Playwright 用于应用代码）或真实的隔离服务器实例（用于 daemon 代码）。没有 JSDOM，没有 mock 的传输。

介于两者之间的任何东西——JSDOM 中的组件测试、mock 被测模块的 vitest 测试、断言私有状态的测试——都是即将被淘汰的垃圾。
