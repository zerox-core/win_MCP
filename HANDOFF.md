# win_MCP 交接说明（2026-11-22）

> 接手这份文档，你就能在 15 分钟内拉起项目、跑通测试、知道下一步该做什么。

---

## 1. 项目是什么

`win_MCP` 是一个**运行在你自己 Windows 电脑上的 MCP（Model Context Protocol）服务器**。
它把本机能力以受控方式暴露给 AI 客户端（飞书 Aily 等），让 AI 能够：

- 读写项目文件（限定在授权目录内）
- 查看 Git 状态与差异
- 执行构建、测试等命令（带审批与超时限制）
- 探测并驱动 Android / Windows / Node / Python 工具链
- 导入签名二进制制品

关键设计前提：**这是一个高权限服务**。它能执行命令、能写文件。
因此整个代码库的重心不在"功能多"，而在"边界是否真的挡得住"。

- 仓库：<https://github.com/zerox-core/win_MCP>
- 可见性：public
- 主分支：`main`
- 语言：TypeScript（Node 20+），另有 C# 管理员代理

---

## 2. 五分钟跑起来

```powershell
cd F:\win_MCP
npm install
npm run build
npx tsc --noEmit          # 类型检查，应为 0 错误
```

跑测试（**必须设置 AUTH_PIN**，否则 config 会在启动时抛错）：

```powershell
$env:AUTH_MODE='pin'
$env:AUTH_PIN='CHANGE-ME-LOCAL-PIN'
node --test --test-concurrency=4 test/*.test.mjs
```

预期：952 个用例全部通过（原 945，新增 7 个 `atomic-replace` 用例）。

本地启动前，先复制配置：

```powershell
Copy-Item .env.example .env
```

然后**必须**编辑 `.env` 至少填这几项：

| 变量 | 说明 |
|---|---|
| `AUTH_PIN` | 至少 8 位，`AUTH_MODE=pin` 时必填。这跟客户端配对无关，是本地工具授权用的 |
| `ALLOWED_DIRS` | 授权目录，**不要写成整个盘符**，写具体项目路径 |
| `OWNER_USER_ID` | 你的用户标识，owner-only 工具依赖它 |
| `PUBLIC_HOST` | 你的公网域名。**留空也行**，启动时会问你要 |

> `MCP_AUTH_TOKEN` **不再是必填**。首次启动会自动生成一个永久客户端密钥，
> 详见第 3 节「客户端配对」。

启动服务：

```powershell
node dist/index.js
```

首次启动会做三件事：

1. 在控制台打印**一次性配对码**，形如 `K7M3-PX9Q`（10 分钟有效）
2. 配对成功后为该客户端生成密钥，密钥**永久有效**、跨重启不变
3. 如果没配 `PUBLIC_HOST`，会**交互式问你**（本地调试直接回车跳过）

```
============================================================
 Client pairing
============================================================
 One-time code:  K7M3-PX9Q
 Expires:        2026-11-22T17:48:31.920Z

 Enter this code once in your MCP client to bind it.
   POST http://127.0.0.1:3000/pair   {"code":"K7M3-PX9Q"}

 Each redemption creates a separate client that can be
 revoked on its own. Restarting issues a new code; already
 paired clients keep working.
 Paired clients: 2 (manage with GET /clients)
============================================================
```

健康检查：

```powershell
# 不带密钥：只有存活状态（status/service/version/timestamp）
curl http://127.0.0.1:3000/health
# 带密钥：完整诊断（工具清单、策略、并发、任务等）
curl -H "Authorization: Bearer <你的clientKey>" http://127.0.0.1:3000/health
```

---

## 3. 客户端配对与公网域名

### 3.1 为什么这么设计

外部 MCP 客户端（飞书 Aily 等）需要一个长期凭据。手输 64 位密钥不现实，
所以拆成两层：

| | 客户端密钥（client key） | 配对码（pair code） |
|---|---|---|
| 形态 | 64 位十六进制 | 8 位、形如 `K7M3-PX9Q` |
| 寿命 | **永久**，重启/升级都不变 | 10 分钟，**只用一次** |
| 用途 | 每次请求带在 `Authorization: Bearer` | 仅用于把手输换成自动下发 |
| 存放 | `clients.json` 里只有 **SHA-256 摘要** | 只在内存，重启即失效 |
| 粒度 | **每个客户端一个**，可单独吊销 | 一次重启一个可用码 |

**关键点：客户端只配一次。** 你输一次配对码，客户端拿到永久密钥存起来，
以后不再需要配对码。每次配对产生**独立客户端**，因此可以按客户端单独吊销
（见 3.3）。

### 3.2 配对流程（第一次配置时做一次）

```powershell
# 1. 启动服务，从控制台抄下配对码
node dist/index.js

# 2. 用配对码换永久密钥（把 K7M3-PX9Q 换成你看到的）
curl -X POST http://127.0.0.1:3000/pair `
  -H "Content-Type: application/json" `
  -d '{"code":"K7M3-PX9Q"}'
```

返回：

```json
{
  "ok": true,
  "clientKey": "7df77beb...(64位)",
  "tokenType": "Bearer",
  "usage": "Authorization: Bearer <clientKey>",
  "mcpEndpoint": "https://mcp.example.com/mcp",
  "note": "Store this key in the client. It does not change across restarts."
}
```

把 `clientKey` 填进客户端（飞书里就是 MCP 的 Bearer Token 字段）。
**这个值是永久的**，客户端以后不用再动。

### 3.3 多客户端与单独吊销

**每次配对生成一个独立客户端**，不是共享一个密钥。所以你可以：

- 手机、笔记本、CI 脚本各配一个，互不影响
- 单独吊销其中一个，其他照常工作

配对时可以带 `label` 方便识别：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3000/pair -Method Post `
  -ContentType 'application/json' -Body '{"code":"K7M3-PX9Q","label":"laptop"}'
```

查看已配对客户端（需要任一有效密钥）：

```powershell
curl -H "Authorization: Bearer <clientKey>" http://127.0.0.1:3000/clients
```

```json
{
  "ok": true,
  "clients": [
    { "id": "a8bcc850-...", "label": "laptop", "createdAt": "...", "lastUsedAt": "..." },
    { "id": "7be223cd-...", "label": "phone",  "createdAt": "..." }
  ]
}
```

单独吊销（按 label 或 id）：

```powershell
curl -X POST http://127.0.0.1:3000/clients/revoke `
  -H "Authorization: Bearer <clientKey>" `
  -H "Content-Type: application/json" `
  -d '{"label":"laptop"}'
```

全部吊销（慎用，所有客户端都要重新配对）：

```powershell
curl -X POST http://127.0.0.1:3000/clients/revoke `
  -H "Authorization: Bearer <clientKey>" `
  -H "Content-Type: application/json" `
  -d '{"all":true}'
```

**安全设计**：注册表只存密钥的 SHA-256 摘要（`clients.json`），
**不存明文**。所以即使这个文件泄露，也无法拿来当凭据用。

**也可以在对话里做**（不用开终端）：`manage_clients` 是 owner 专用 MCP 工具：

| action | 作用 |
|---|---|
| `issue_code` | 签发新的配对码（**不用重启服务**），旧码立即失效 |
| `list` | 列出已配对客户端 + 配对码状态 |
| `revoke` | 配 `id` 或 `label`，吊销单个 |
| `revoke_all` | 吊销全部（慎用） |

在飞书里直接说「发个新配对码给手机」「列出已配对的客户端」「吊销 laptop」即可。
非 owner 调用会被 `OWNER_REQUIRED` 拒绝。

`issue_code` 返回配对码、过期时间、以及可直接复制的 `curl` 命令。这是给新设备
配对的推荐方式——**不需要重启服务**，也不会影响已配好的客户端。

### 3.4 配错了怎么办

- **配对码过期/输错太多次** → 说「发个新配对码」（`issue_code`）即可，
  不用重启服务。
  已经配好的客户端**不受影响**，它们的密钥仍然有效。
- **想给新客户端再配一个** → 同样用 `issue_code`。重启服务也会产生新码，
  但不是必需。
- **某个客户端不用了** → 用 `/clients/revoke` 单独吊销它，其他不受影响。
- **怀疑某个密钥泄露** → 吊销那一个即可，不用打断其他客户端。
- **彻底重来** → 删除 `APPROVAL_DATA_DIR\clients.json` 后重启，
  所有客户端需重新配对。

### 3.5 公网域名（内网穿透）

`PUBLIC_HOST` 决定服务端接受哪些 Host/Origin，**不配的话外部客户端连不上**
（本地 `localhost` 仍然可用，因为内置在白名单里）。

启动时如果检测到没配，会交互式问你：

```
--- Public hostname setup ---
PUBLIC_HOST is not set, so only localhost clients are accepted.

Two supported options:
  Cloudflare Tunnel (recommended, free, stable hostname)
    1. cloudflared tunnel create win-mcp
    2. cloudflared tunnel route dns win-mcp mcp.example.com
    3. cloudflared tunnel run --url http://127.0.0.1:3000 win-mcp
    -> PUBLIC_HOST=mcp.example.com

  ngrok (quick trial, hostname changes unless you pay)
    1. ngrok http 3000 --domain your-name.ngrok-free.app
    -> PUBLIC_HOST=your-name.ngrok-free.app

Enter the bare hostname only (no scheme, no path, no trailing slash).
PUBLIC_HOST (empty to skip):
```

填完会自动写回 `.env` 并提示重启生效。校验规则：**只接受裸主机名**，
不能带 `http://`、路径、端口或尾部斜杠。

> **建议用 Cloudflare Tunnel**：免费、主机名固定，不会像 ngrok 免费版那样
> 每次重启换域名（域名一换，客户端的 endpoint 就得跟着改，这正是你想避免的）。

**非交互环境**（CI、服务托管、`WINMCP_NONINTERACTIVE=1`）不会卡在提示上，
只打印配置指引后继续启动。要禁用向导：设 `WINMCP_NONINTERACTIVE=1`。

---

## 4. 代码地图

```
src/
├── index.ts              # 组合根：Express app、路由、工具注册（改这里要格外小心）
├── config.ts             # 全部环境变量解析与校验（启动即校验，失败直接抛错）
├── auth/pinAuth.ts       # PIN 会话状态机（activeUsers、驱逐策略）
├── security/
│   ├── auth.ts           # Bearer 中间件 + 限流
│   ├── toolAccess.ts     # 工具授权闸门 + owner 判定 + 路径审批
│   ├── directoryGrantStore.ts  # once/session/permanent 三档目录授权
│   ├── approval.ts       # 审批挑战签名与消费
│   ├── pathGuard.ts      # 路径规范化、符号链接/联接点逃逸防护
│   ├── networkGuard.ts   # SSRF 防护（元数据地址、内网段）
│   ├── clientPairing.ts  # 永久客户端密钥 + 一次性配对码
│   ├── pairingRoutes.ts  # POST /pair 与 /pair/status
│   ├── publicHostGuide.ts # 启动时 PUBLIC_HOST 交互式引导
│   ├── atomicReplace.ts  # Windows 安全的 rename 重试（EPERM/EBUSY）
│   └── logger.ts         # 结构化日志 + 敏感值脱敏
├── tools/                # 43 个工具实现，每个对应一个 MCP tool
├── development/          # 开发任务子系统（任务队列、worker、工具链探测）
│   ├── tasks/            # 任务协调器、worker 协议、心跳
│   ├── android/          # ADB、Gradle、签名
│   ├── windows/          # MSBuild、Electron、原生项目
│   └── servers/          # 本地开发服务器管理
├── android-workflow/     # Android 暂存验证状态机（Profile 注册表）
├── artifacts/            # 二进制制品：摘要、签名、物化
└── textTransfers/        # 大文本分块传输

broker/                   # C# 管理员代理（named pipe，隔离提权操作）
test/                     # 131 个测试文件，与 src 结构大致对应
scripts/                  # 启动、隧道、守护、凭据管理脚本
docs/                     # 面向使用者的文档
```

**读代码建议顺序**：`config.ts` → `security/auth.ts` → `security/toolAccess.ts` →
`tools/` 里挑一个（建议 `read_file` 或 `execute_command`）→ `index.ts`。

---

## 5. 安全模型（改代码前必须理解）

这是整个项目的核心。四层防线：

**第一层 — 传输鉴权（`security/auth.ts`）**
`MCP_AUTH_TOKEN` 非空即启用 Bearer 校验，用 `timingSafeEqual` 比较。
`AUTH_MODE` 决定工具级身份：`pin`（需 PIN 会话）/ `header`（信任请求头）/ `none`（全部放行）。

> ⚠️ `AUTH_MODE=none` 会让 `isAuthenticated()` 恒为 `true`，owner 隔离随之失效。
> 生产环境不要用它。

**第二层 — 工具授权（`security/toolAccess.ts`）**
`authorizeToolCall` 校验身份；`authorizeOwnerToolCall` 额外要求
`getRequestUserId() === OWNER_USER_ID`。开发类工具走 owner 闸门。

**第三层 — 目录边界（`security/pathGuard.ts` + `directoryGrantStore.ts`）**
所有路径先规范化再比对授权根，防 `..`、符号链接、Windows 联接点逃逸。
三档授权：`allow_once`（单次、绑定参数摘要）、`session`、`permanent`。
挑战是签名的，含 user / tool / args digest / roots / nonce / 过期时间。

**第四层 — 命令审批（`tools/command.ts` + `commandPolicy.ts`）**
命令分类为 safe / confirmation_required / blocked。
`GIT_COMMAND_POLICY`、`OWNER_COMMAND_POLICY`、`COMMAND_PREAPPROVED_EXE` 控制豁免范围。
即便豁免，目录限制、超时、输出上限、取消能力仍然生效。

**改动这些文件时，必须同时更新对应测试**。这是项目约定，也是历史事故的来源
（见 `docs/known-issues.md`）。

---

## 6. 当前状态

已完成并可用：

- 35 个 MCP 工具，覆盖文件、Git、命令、开发任务、制品、文本传输
- 四层安全模型全部落地并有测试覆盖
- Android 暂存验证状态机（含 Profile 热重载）
- Windows 开发适配器（MSBuild / Electron / 原生）
- C# 管理员代理，named pipe + 共享密钥
- Cloudflare 命名隧道与 ngrok 双通道脚本

需要注意的设计约束：

- **工具总数是契约**。`test/development-docs.test.mjs` 断言工具清单长度，
  新增工具要同步改 README、`.env.example` 和该测试。
- **`restart_service` 只在托管启动时注册**（`WINMCP_MANAGED_LAUNCH=1`），
  避免生产实例自己重启自己。
- **隧道 ID 不写进代码**。`prod-supervisor.mjs` 从
  `CLOUDFLARE_TUNNEL_UUID` 读取，`stop-prod-service.ps1` 未设置时直接报错退出。

---

## 7. 已知问题

**测试并发抖动（已修复，2026-11-22）**

历史上 `test/local-dev-server-worker.test.mjs`、`test/development-task-worker.test.mjs`
在 `--test-concurrency=4` 下随机失败，报 `worker heartbeat lost` 或 `TASK_INTERRUPTED`
（约 25%–75% 的轮次会有 1–3 个失败）。

**根因不是心跳间隔，而是 Windows 的原子替换。**

`src/development/tasks/store.ts` 用「临时文件 + `renameSync`」写 `metadata.json`。
Windows 上 `rename` 覆盖一个正被其他句柄打开的文件会直接失败（`EPERM`/`EBUSY`/`EACCES`），
不会等待。协调器在轮询 `metadata.json` 的同时 worker 在重写它，于是：

1. worker 的状态写入抛 `EPERM` → 被 `catch {}` 吞掉 → 状态推进失败、任务卡在 `spawn`/`server:starting`；
2. 协调器等不到心跳 → 把任务判成 `interrupted`；
3. 测试看到既不是 `running` 也不是 `cancelled`，超时失败。

同样的裸 `renameSync` 还出现在心跳、审批、目录授权等 6 处写入路径上。

**修复**：新增 `src/security/atomicReplace.ts` 的 `renameWithRetry`，
只对这三个 Windows 共享冲突码做有界重试（最多 40 次，指数退避，单次上限 400ms），
其余错误（`ENOENT`/`EXDEV`/`EINVAL`…）立刻抛出，不掩盖真实问题。
已接入 `tasks/store.ts`、`tasks/workerProtocol.ts`、`security/approvalStore.ts`、
`security/directoryGrantStore.ts`、`workspaces/context.ts`、
`environment/planStore.ts`、`credentials/dpapiStore.ts`。

回归测试：`test/atomic-replace.test.mjs`（7 个用例，覆盖退避序列、
错误分类、真实文件系统替换、任务元数据争用）。

**注意**：这类问题只在 Windows 上出现，Linux CI 永远复现不到。
如果你在新增「临时文件 + rename」的写入路径，请直接用 `renameWithRetry`，
不要写裸 `fs.renameSync`。

**CI 从「永不运行」到「跑通」修复的其余环节（同批，2026-11-22）**

`npm test` 之前其实从来没在 CI 跑过测试：

- `node --test test/*.test.mjs` 依赖 shell 展开通配符，Windows 的 PowerShell 不展开，
  Node 收到字面量 `test/*.test.mjs` 就报 `Could not find`。本地能过是因为交互式 shell
  先展开了。现改由 `scripts/run-tests.mjs` 自己展开，任何 shell/Node 版本一致。
- 测试跑起来后暴露 13 个失败，根因是 Windows 8.3 短路径：`os.tmpdir()` 返回
  `C:\Users\RUNNER~1\...`，而 `realpath` 返回 `C:\Users\runneradmin\...`。
  生产代码里 `trustedExecutable.isWithin` 和 `web/testFiles.validateTestFiles`
  拿已规范化的路径去比未规范化的根，导致合法文件被判「逃逸根」——
  前者把 `incompatible` 降级成 `untrusted`，后者让 web 工作流在这类机器上完全不可用。
  两处都改为两侧同一规范形式比较；测试侧改为从规范化临时根构造期望值。
- Python e2e 缺 `httpx`；装上后又因控制台 cp1252 编码无法打印 `→` 而崩溃（断言其实全过）。
  现安装依赖并让 stdout/stderr 以 `errors="replace"` 输出。
- e2e 里工具清单硬编码为 36，实际已是 42（7 个工具新增后没同步）。现改为单点
  维护的 `expected_tools` 集合，并新增一条 `/health` 与 `tools/list` 一致性断言。

**Production audit 的 6 个漏洞（已修复，2026-11-22）**

`npm audit --omit=dev` 曾报 6 个漏洞（1 critical / 4 high / 1 moderate）：

| 包 | 严重度 | 说明 | 修复后 |
|---|---|---|---|
| `proxy-addr` ≤2.0.7 | critical | IPv4-mapped IPv6 信任子网导致 IP 伪造 | 2.0.8 |
| `body-parser` <1.20.9 | high | 压缩请求体尾部字节 DoS | 1.20.9 |
| `zod` <4.6.6 | high | 超大受约束集合校验时内存耗尽 | 4.6.7 |
| `qs` ≤6.16.0 | moderate | 括号键逗号解析绕过数组上限 / DoS（3 条） | 6.17.1 |

**两类不同成因，别混为一谈：**

- **zod / qs 靠升级就够**。zod 从 4.4.3 升到 4.6.7，本项目 `^4.2.0` 和
  `@modelcontextprotocol/core@2.0.0-beta.5` 的 `dependencies.zod: ^4.2.0`
  都允许——注意它是**普通 dependency 不是 peer**，所以不可能冲突（这一条曾被
  交接文档误判为高风险）。qs 必须用 `overrides`：express 4.22.3 的 qs 范围是
  `~6.16.0`，低于修复所需的 6.17.1，而 express 4.x 没有任何版本放宽它。
- **body-parser / proxy-addr 是被 lockfile 钉死的**。express 的范围
  （`~1.20.5` / `~2.0.7`）本来就允许修复版，只是 lock 里是旧的；所以光升 express
  不解决问题（express 4.22.3 依然允许 1.20.6）。用 `overrides` 强制到
  1.20.9 / 2.0.8，两者都落在原范围内。

**刻意停留在 express 4**：express 5 是 HTTP 层的整体重写，而这个问题用
overrides 就能解决，不值得为此引入大版本风险。

验证（`npm ci` 干净装后）：
- `npm audit --omit=dev --registry=https://registry.npmjs.org` → **0 漏洞**
- `npx tsc --noEmit` → 0 错误
- `npm test` → **953/953**
- `py test/e2e_test.py` → **44/44**（这条真正走 express / body-parser /
  proxy-addr 的请求链路，比单测更能证明没升级坏）

**顺带修掉的 Secret scan 自指问题**：该步骤把 `APPROVAL_STATE_SECRET`
以字面量写在自己这个 workflow 文件里，扫描时必然匹配到自己 → 永远报
`file:.github/workflows/windows-development.yml`。任何已提交的值都无法同时满足
「扫描器要知道它」和「仓库里不能有它」。现改为运行时随机生成，`AUTH_PIN`
（Node 测试和 Python e2e 各一处）同样处理。

**至此 CI 全绿（13 个步骤全部通过）**，`npm test` + `npm audit` 都可作为合并门槛。

---

## 8. 下一步建议（按价值排序）

1. ~~修掉测试并发抖动~~ **已完成**（第 7 节）。`npm test` 现在可以作为合并门槛。
2. ~~清掉 `npm audit` 的 6 个漏洞~~ **已完成**（第 7 节）。CI 十三步全绿。
3. ~~给 `/health` 加鉴权或裁剪字段~~ **已完成**（第 3 节）。
   不带密钥只返回 status/service/version/timestamp，带密钥才返回完整诊断。
4. ~~补 CI~~ **已完成**：`.github/workflows/windows-development.yml`
   已监听 `main`，Node / Broker / Python 三个套件 + audit + secret scan 全部跑通。
5. ~~客户端配对与公网域名引导~~ **已完成**（第 3 节）。
6. **配置样例的默认值收敛**。`.env.example` 里 `CONSENT_ABSOLUTE_PATH=confirm`
   是对的，但文档示例偶尔出现 `allow`，需要统一。
7. **补充 CHANGELOG 与版本策略**。当前是 `1.0.0` 单点，没有发布流程。
8. **把剩余的裸 `renameSync` 也收敛**。`textTransfers/`、`artifacts/`、
   `android/projectProvider.ts` 等处仍有 staging→rename；其中会覆盖已存在
   文件的场景应改用 `renameWithRetry`（纯目录 rename 不涉及文件共享冲突，可不动）。
9. ~~配对密钥的撤销界面~~ **已完成**（第 3.3 节）。每次配对生成独立客户端，
   可 `GET /clients` 列出、`POST /clients/revoke` 单独吊销。

---

## 9. 开发约定

**提交前自检：**

```powershell
npx tsc --noEmit
$env:AUTH_MODE='pin'; $env:AUTH_PIN='CHANGE-ME-LOCAL-PIN'
node --test --test-concurrency=4 test/*.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scan-development-secrets.ps1
```

第三条是密钥扫描脚本，提交前务必跑一次。

**关于 `node --test test/*.test.mjs`**：交互式 PowerShell 会先展开通配符，所以这样写能跑；
但在 CI 等非交互环境不会展开。要得到和 CI 一致的结果，用 `npm test`
（内部走 `scripts/run-tests.mjs`，自己展开，任何 shell 都一样）。

**编码规范：**

- 所有源文件 UTF-8，无 BOM
- 不要引入新的全局状态，除非像 `pinAuth` 那样有明确生命周期
- 路径处理一律走 `pathGuard`，不要直接 `fs` 拼接
- 日志一律走 `logger`，它会自动脱敏；不要 `console.log` 敏感值

**分支与合并：**

- `main` 受保护，走 PR
- 一个 PR 只做一件事，安全边界改动单独提
- 改了安全相关文件，PR 描述里必须写明威胁模型变化

---

## 10. 常用命令速查

```powershell
# 构建 / 类型检查
npm run build
npx tsc --noEmit

# 测试
$env:AUTH_MODE='pin'; $env:AUTH_PIN='CHANGE-ME-LOCAL-PIN'
npm test                                   # 与 CI 一致（推荐）
node --test --test-concurrency=4 test/*.test.mjs   # 也行，但依赖 shell 展开通配符
node --test test/某个具体.test.mjs          # 单跑一个

# Python e2e（需要 httpx）
py -m pip install httpx
py test/e2e_test.py

# 启动
node dist/index.js
powershell -File scripts/start-winmcp.ps1 -CheckOnly   # 只做预检

# 客户端配对（首次配置客户端时做一次，见第 3 节）
# 1) 从启动横幅抄下配对码，2) 换永久密钥：
curl -X POST http://127.0.0.1:3000/pair -H "Content-Type: application/json" -d '{"code":"K7M3-PX9Q"}'

# 健康检查：不带密钥只有存活状态，带密钥才是完整诊断
curl http://127.0.0.1:3000/health
curl -H "Authorization: Bearer <clientKey>" http://127.0.0.1:3000/health

# 配对状态（不泄露码本身）
curl http://127.0.0.1:3000/pair/status

# 隧道
powershell -File scripts/test-cloudflare-tunnel.ps1 -CheckOnly -ConfigPath <path>
node scripts/prod-supervisor.mjs

# 安全扫描
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scan-development-secrets.ps1

# 依赖漏洞
npm audit --omit=dev --registry=https://registry.npmjs.org

# 管理员代理（需要管理员权限）
dotnet test broker/WinMcp.AdminBroker.Tests/WinMcp.AdminBroker.Tests.csproj
powershell -File scripts/build-admin-broker.ps1
```

---

## 11. 环境与凭据纪律

**绝对不能提交的东西：**

- `.env`、`.env.test`（`.gitignore` 已覆盖，但请勿用 `git add -f`）
- `C:\Users\<你>\.cloudflared\*.json`（隧道凭证）
- `logs/`、`approval.key`、`approvals.json`、`directory-grants.json`
- **`clients.json`**（已配对客户端注册表，只含密钥摘要，在 `APPROVAL_DATA_DIR` 下，0600）
- 任何真实域名、隧道 UUID、Token、PIN、个人路径

**如果你需要引用自己的隧道**，写进本地 `.env`：

```env
CLOUDFLARE_TUNNEL_UUID=你的真实UUID
CLOUDFLARE_CONFIG_PATH=%USERPROFILE%\.cloudflared\config.yml
```

代码从环境变量读，仓库里永远只有占位符。

---

## 12. 交接检查清单

接手当天应该完成：

- [ ] `npm install && npm run build` 成功
- [ ] `npx tsc --noEmit` 零错误
- [ ] 测试跑通（`npm test`，983 个用例）
- [ ] 能说清四层安全模型各挡什么
- [ ] 说得出 `AUTH_MODE=none` 的风险
- [ ] 知道改工具清单要同步哪三处
- [ ] 本地 `node dist/index.js` 起得来，控制台打印出配对码
- [ ] 用配对码 `POST /pair` 拿到 clientKey，再用它访问 `/health` 看到全量

完成后，从第 8 节第 6 项开始（前五项都已完成）。
