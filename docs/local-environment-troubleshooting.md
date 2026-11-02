# 本机环境排障：Provider 不可用、握手超时、会话被打断

这份文档记录**不是 Paseo 代码 bug、但会让 Paseo 报错**的本机环境问题，以及每类问题最稳的修法。

适用场景：`Providers` 页面里某个 agent 显示「未安装」或「错误」，但你确信 CLI 装好了。

---

## 0. 先做这三步定位

```powershell
# 1. daemon 眼里的 provider 状态（available=false 就是没解析到可执行文件）
cd D:\GitHubProjects\paseo
node packages\cli\dist\index.js daemon status

# 2. daemon 的启动时间（早于 CLI 安装时间，就说明是 PATH 快照问题）
$supervisor = (Get-Content "$env:USERPROFILE\.paseo\paseo.pid" -Raw | ConvertFrom-Json).pid
(Get-Process -Id $supervisor).StartTime

# 3. daemon 日志里的真实报错
Get-Content "$env:USERPROFILE\.paseo\daemon.log" -Tail 80
```

`available: true` 只说明**可执行文件存在**，不代表 agent 能完成 ACP 握手。两者要分开验证：

```powershell
# 直接对 agent 做一次 ACP initialize，绕过 Paseo
node scripts\acp-handshake-probe.mjs --timeout 20000 -- <命令> <参数...>

# 例：MiniMax Code
node scripts\acp-handshake-probe.mjs --timeout 20000 -- "$env:USERPROFILE\.minimax-code\mcode.cmd" acp
```

- 退出码 `0` + `outcome: answered initialize` → agent 本身没问题，问题在 Paseo 的解析/环境。
- 退出码 `1` + `stderr` 有内容 → 按 stderr 修（常见是下面的第 2 类）。

---

## 1. Provider 显示「未安装」，但 CLI 确实装了

### 1.1 原因 A：daemon 的 PATH 是启动时的快照（Windows）

Windows 给新进程的是**父进程启动那一刻**的 `PATH`。daemon 在后台常驻，所以：

- daemon 启动之后才安装的 CLI，daemon 永远看不到；
- 报错表现是 `available: false` / 「未安装」，但在新开的终端里 `where <cli>` 正常。

**诊断**：对比注册表 PATH 与进程 PATH。

```powershell
$userPath = (Get-ItemProperty 'HKCU:\Environment' -Name Path).Path
$machinePath = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name Path).Path
($userPath + ';' + $machinePath) -split ';' | Where-Object { $_ -and ($env:PATH -split ';') -notcontains $_ }
```

列出来的目录就是「注册表有、当前进程没有」的，通常正是新装 CLI 的目录。

**修法（按牢固程度排序）**：

1. **根治**：让 daemon 启动时刷新 PATH（`refreshWindowsProcessPath`，见 PR #8413 / `packages/server/src/executable-resolution/windows.ts`）。合入后升级即可。
2. **重启**：从**已经包含该 PATH 的终端**重启 daemon（或直接重启 Paseo 桌面端）。重启后新进程会继承当前 PATH。
3. **兜底**：在 `$env:USERPROFILE\.paseo\config.json` 里给该 provider 写**绝对路径**。能立刻生效，但 CLI 换目录/换版本后会再次失效，属于权宜之计。

```json
{
  "agents": {
    "providers": {
      "grok": {
        "extends": "acp",
        "command": ["C:\\Users\\<你>\\.grok\\bin\\grok.exe", "agent", "stdio"]
      }
    }
  }
}
```

### 1.2 原因 B：nvm for Windows 切换了 Node 版本

nvm-windows 的机制：`C:\nvm4w\nodejs` 是一个**指向当前版本的符号链接**，而 `PATH` 里只有这个链接。

```
C:\nvm4w\nodejs  ->  D:\Programs\nvm\v24.13.0
```

`npm i -g` 装的东西在**每个 Node 版本下各有一份**。所以 `nvm use` 一换版本：

- 旧版本里装的全局 CLI（`claude`、`pi` 等）立刻「消失」；
- 用旧版本编译的原生模块（`better-sqlite3` 之类）立刻 ABI 不匹配。

**诊断**：

```powershell
(Get-Item 'C:\nvm4w\nodejs').Target      # 当前指向哪个版本
node -v; npm prefix -g
Get-ChildItem 'D:\Programs\nvm' -Directory | ForEach-Object {
  "$($_.Name): claude=$(Test-Path (Join-Path $_.FullName 'claude.cmd')) pi=$(Test-Path (Join-Path $_.FullName 'pi.cmd'))"
}
```

如果 CLI 只存在于**非当前**版本目录里，就是这个原因。

**修法（二选一）**：

- **保持当前 Node 版本**：在活动版本里重装，然后重启 daemon（provider 快照会自动刷新，通常不用重启）。
  ```powershell
  npm install -g @anthropic-ai/claude-code@<版本>
  npm install -g @earendil-works/pi-coding-agent@<版本>
  ```
- **切回原来能用的版本**：`nvm use <版本>`，然后重启 daemon。

> 判断依据：`nvm use` 的时间点如果早于「问题开始出现」的时间点，就基本可以锁定是它。
> `Get-Item 'C:\nvm4w\nodejs' | Select-Object CreationTime, LastWriteTime` 能看到切换时间。

---

## 2. Provider 显示「错误 / Timed out refreshing ... after 120000ms; pending: initialize」

典型现象：

- `daemon status` 里 `available: true`；
- 但 UI 上 provider 报错，日志里每 30 秒刷一次 `Timed out refreshing <Provider> after 120000ms; pending: initialize`；
- 该 CLI 的 `--version` 能正常打印。

**原因**：CLI 依赖的原生模块（`*.node`）是用**另一个 Node 版本**编译的，当前 Node 加载失败后进程卡住，不返回 ACP 握手。

日志会明确写出 ABI：

```
The module '...\better_sqlite3.node' was compiled against a different
Node.js version using NODE_MODULE_VERSION 127. This version of Node.js
requires NODE_MODULE_VERSION <另一个值>.
```

（127 = Node 22，137 = Node 24。）

**诊断**：用第 0 步的 `acp-handshake-probe.mjs` 直接跑，stderr 里就是上面这段。

**修法**：用**当前活动的 Node** 重建该原生模块。

```powershell
$dir = "$env:USERPROFILE\.minimax-code\releases\<版本>\node_modules\@minimax-ai\code"
$native = "$dir\node_modules\better-sqlite3\build\Release\better_sqlite3.node"

# 先备份，便于回退
Copy-Item $native "$native.bak" -Force

Push-Location $dir
npm rebuild better-sqlite3
Pop-Location
```

重建后立刻用探针验收：

```powershell
node scripts\acp-handshake-probe.mjs --timeout 20000 -- "$env:USERPROFILE\.minimax-code\mcode.cmd" acp
```

或者让 CLI 自己的更新器按当前 Node 重装（例如 `mcode update`），效果等价。

> 注意：以后再切换 Node 版本、或让 CLI 自我更新，都可能再次破坏 ABI。切换版本后重新跑一遍探针是最省事的预防手段。

---

## 3. 重启 daemon 会打断当前会话（工具调用「被中断」）

**机制**：agent 会话跑在 daemon 进程里。`paseo daemon restart` 杀掉 daemon 的同时，也杀掉了正在执行这条命令的 agent —— 于是工具调用显示为中断，命令的实际结果拿不到。

**稳妥做法**：把重启放到**分离进程**里，结果写进日志文件，再去轮询验证。

```powershell
$log = 'D:\Temp\paseo-restart.log'
Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
  '-NoProfile','-Command',
  "Start-Sleep -Seconds 3; node 'D:\GitHubProjects\paseo\packages\cli\dist\index.js' daemon restart *> '$log'; " +
  "Add-Content '$log' \"exit=`$LASTEXITCODE at `$(Get-Date -Format o)\""
)
```

然后（等 10~20 秒）验证：

```powershell
Get-Content D:\Temp\paseo-restart.log -Tail 5
node packages\cli\dist\index.js daemon status | Select-String 'workerPid|providers'
```

判断标准：

- `workerPid` 变了 → 重启成功；
- `providers` 里目标 provider 是 `available: true` → 解析成功；
- 需要更硬的证据就再跑一次 `acp-handshake-probe.mjs`。

**不要**在同一个工具调用里既发重启又等结果，否则必然看不到成败。

---

## 4. 验收清单（改完必跑）

```powershell
# 1. 可执行文件层面
node packages\cli\dist\index.js daemon status   # 所有目标 provider available: true

# 2. 协议层面（每个 ACP provider 各跑一次）
node scripts\acp-handshake-probe.mjs --timeout 20000 -- <命令> acp   # exit=0, answered initialize

# 3. 运行时层面
Get-Content "$env:USERPROFILE\.paseo\daemon.log" -Tail 50
#   不应再有 "Timed out refreshing <Provider>" / "Provider '<x>' is not available"
```

三项都过，才算真的修好。只改 config 或只重装、不跑第 2 步，很容易出现「状态显示可用、实际握手失败」。

---

## 5. 常见 provider 的安装位置与包名

| Provider | 可执行文件 | 全局包 |
| --- | --- | --- |
| Claude | `claude`（npm 全局 bin） | `@anthropic-ai/claude-code` |
| Pi | `pi`（npm 全局 bin） | `@earendil-works/pi-coding-agent` |
| MiniMax Code | `%USERPROFILE%\.minimax-code\mcode.cmd` | `@minimax-ai/code`（自带 launcher 布局） |
| Grok | `%USERPROFILE%\.grok\bin\grok.exe` | 官方安装器 |
| Kimi Code CLI | `%USERPROFILE%\.kimi-code\bin\kimi.exe` | 官方安装器 |

前三个走 npm 全局，**受 nvm 版本影响**；后两个是独立安装器，不受 Node 版本影响，但会受第 1.1 节 PATH 快照影响。
