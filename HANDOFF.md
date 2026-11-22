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
| `MCP_AUTH_TOKEN` | 随机长字符串，`openssl rand -hex 32` 或等价方式生成 |
| `AUTH_PIN` | 至少 8 位，`AUTH_MODE=pin` 时必填 |
| `ALLOWED_DIRS` | 授权目录，**不要写成整个盘符**，写具体项目路径 |
| `OWNER_USER_ID` | 你的用户标识，owner-only 工具依赖它 |
| `PUBLIC_HOST` | 你的公网域名；纯本地调试可留空 |

启动服务：

```powershell
node dist/index.js
# 健康检查
curl http://127.0.0.1:3000/health
```

---

## 3. 代码地图

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
│   └── logger.ts         # 结构化日志 + 敏感值脱敏
├── tools/                # 35 个工具实现，每个对应一个 MCP tool
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

## 4. 安全模型（改代码前必须理解）

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

## 5. 当前状态

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

## 6. 已知问题

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

**仍然失败的一步：Production audit。**
`npm audit --omit=dev` 报 6 个漏洞（1 critical / 4 high / 1 moderate）：

| 包 | 严重度 | 说明 |
|---|---|---|
| `proxy-addr` ≤2.0.7 | critical | IPv4-mapped IPv6 信任子网导致 IP 伪造 |
| `body-parser` <1.20.9 | high | 压缩请求体尾部字节 DoS |
| `zod` <4.6.6 | high | 超大受约束集合校验时内存耗尽 |
| `qs` ≤6.16.0 | moderate | 括号键逗号解析绕过数组上限 / DoS（3 条） |

`zod` 由 `@modelcontextprotocol/core` 传递依赖引入，因此升级可能牵动 MCP SDK。
`npm audit fix` 声称都能修，但本机当时连不上 registry 未能验证。
**这是独立的依赖升级任务，需要单独评估（尤其 zod 大版本与 MCP SDK 的兼容性），
不要和别的改动混在一个 PR 里。**

---

## 7. 下一步建议（按价值排序）

1. ~~修掉测试并发抖动~~ **已完成**（第 6 节）。`npm test` 现在可以作为合并门槛。
2. **清掉 `npm audit` 的 6 个漏洞**（第 6 节末）。这是 CI 上唯一还红的一步，
   也是当前唯一 known security debt。注意 `zod` 是 `@modelcontextprotocol/core`
   的传递依赖，升级前先确认 SDK 兼容性。
3. **给 `/health` 加鉴权或裁剪字段**。当前它无鉴权返回工具清单、
   `gitCommandPolicy`、`directoryApprovalFallback` 等。对外暴露过多侦查信息。
4. ~~补 CI~~ **已完成**：`.github/workflows/windows-development.yml`
   已监听 `main`，注入测试用 `AUTH_PIN`，Node / Broker / Python 三个套件都能跑通。
5. **配置样例的默认值收敛**。`.env.example` 里 `CONSENT_ABSOLUTE_PATH=confirm`
   是对的，但文档示例偶尔出现 `allow`，需要统一。
6. **补充 CHANGELOG 与版本策略**。当前是 `1.0.0` 单点，没有发布流程。
7. **把剩余的裸 `renameSync` 也收敛**。`textTransfers/`、`artifacts/`、
   `android/projectProvider.ts` 等处仍有 staging→rename；其中会覆盖已存在
   文件的场景应改用 `renameWithRetry`（纯目录 rename 不涉及文件共享冲突，可不动）。

---

## 8. 开发约定

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

## 9. 常用命令速查

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

## 10. 环境与凭据纪律

**绝对不能提交的东西：**

- `.env`、`.env.test`（`.gitignore` 已覆盖，但请勿用 `git add -f`）
- `C:\Users\<你>\.cloudflared\*.json`（隧道凭证）
- `logs/`、`approval.key`、`approvals.json`、`directory-grants.json`
- 任何真实域名、隧道 UUID、Token、PIN、个人路径

**如果你需要引用自己的隧道**，写进本地 `.env`：

```env
CLOUDFLARE_TUNNEL_UUID=你的真实UUID
CLOUDFLARE_CONFIG_PATH=%USERPROFILE%\.cloudflared\config.yml
```

代码从环境变量读，仓库里永远只有占位符。

---

## 11. 交接检查清单

接手当天应该完成：

- [ ] `npm install && npm run build` 成功
- [ ] `npx tsc --noEmit` 零错误
- [ ] 测试跑通，理解第 6 节的偶发失败
- [ ] 能说清四层安全模型各挡什么
- [ ] 说得出 `AUTH_MODE=none` 的风险
- [ ] 知道改工具清单要同步哪三处
- [ ] 本地 `node dist/index.js` 起得来，`/health` 有响应

完成后，从第 7 节第 1 项开始。
