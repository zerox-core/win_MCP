# 三种接入方式

`win_mcp` 是**跑在你自己 Windows 电脑上的能力接口**，通过内网穿透（Cloudflare Tunnel
或 ngrok）暴露一个 HTTPS 地址。谁来调用它，决定了你选哪种接入方式。

| 方式 | 适合谁 | 需要写代码 | 审批在哪 |
|---|---|---|---|
| **A. 飞书 Aily** | 日常用飞书对话 | 不需要 | 飞书弹卡片 |
| **B. 桌面 MCP 客户端** | 想用 Claude/GPT 客户端操作本机 | 不需要 | 客户端弹窗 |
| **C. 纯 API 桥接** | 只有一个云端 API key，没有 MCP 客户端 | 不用写，本仓库自带 | 终端里问 |

三条路的**服务端完全是同一个**，只是客户端不同。所以配好服务端之后，随时可以切换或同时用。

---

# 第 0 步：先把服务端跑起来（三条路都需要）

```powershell
git clone <本仓库>
cd win_mcp
npm install
npm run build
Copy-Item .env.example .env
```

编辑 `.env`，**只有 4 项必须填**：

```env
# 1. 允许 AI 碰哪些目录。写具体路径，不要写整个盘符。
ALLOWED_DIRS=F:\MyProjects

# 2. 你的标识，owner 专属工具（如 manage_clients）靠它认人
OWNER_USER_ID=owner

# 3. 至少 8 位，本地工具授权用
AUTH_MODE=pin
AUTH_PIN=换成你自己的至少8位

# 4. 公网域名。可以先留空，启动时会问你
# PUBLIC_HOST=mcp.example.com
```

启动：

```powershell
node dist/index.js
```

会看到配对码：

```
============================================================
 Client pairing
============================================================
 One-time code:  K7M3-PX9Q
 Expires:        2026-11-23T04:24:18.855Z
   POST http://127.0.0.1:3000/pair   {"code":"K7M3-PX9Q"}
============================================================
```

**这个配对码就是三条路共用的入门券。** 用它换一个永久密钥：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3000/pair -Method Post `
  -ContentType 'application/json' -Body '{"code":"K7M3-PX9Q","label":"my-laptop"}'
```

返回的 `clientKey`（64 位）就是后面三条路都要填的凭据。**永久有效，重启不变。**

---

# 第 1 步：把服务端暴露到公网

飞书/云端模型都要访问你的电脑，必须有公网地址。

## 推荐：Cloudflare Tunnel（免费、域名固定）

```powershell
cloudflared tunnel login                                    # 浏览器授权
cloudflared tunnel create win-mcp
cloudflared tunnel route dns win-mcp mcp.你的域名.com
cloudflared tunnel run --url http://127.0.0.1:3000 win-mcp
```

然后 `.env` 里写：

```env
PUBLIC_HOST=mcp.你的域名.com
```

重启服务生效。

## 备选：ngrok（快速试，域名会变）

```powershell
ngrok http 3000 --domain your-name.ngrok-free.app
```

```env
PUBLIC_HOST=your-name.ngrok-free.app
```

> **不建议长期用 ngrok 免费版**：每次重启换域名，所有客户端的 endpoint 都要跟着改。
> 这正是「影响使用体验」的典型。

## 只在本机用？

跳过这一步，把地址写成 `http://127.0.0.1:3000/mcp` 即可。

---

# 路径 A：飞书 Aily

在 Aily 里新建 MCP 连接：

```text
MCP endpoint:   https://mcp.你的域名.com/mcp
Authorization:  Bearer <你的clientKey>
x-aily-user:    owner          ← 必须和 .env 里的 OWNER_USER_ID 一致
```

要点：

- `Authorization` 要填成**固定请求头**，值以 `Bearer ` 开头（注意后面一个空格）
- **别把 token 写在描述/名称/头像里**，那些字段不会当成请求头发送
- 保存后先让 Aily 列一次工具，确认能看到 43 个；再 `ping` 一次验证连通

详细版见 [docs/aily-integration-guide.md](aily-integration-guide.md)。

---

# 路径 B：桌面 MCP 客户端

Claude Desktop、Cline、Continue、Cherry Studio、Cursor 这类都原生支持 MCP，
**不用写任何代码**。

## 通用配置格式

大多数客户端用同一套 JSON：

```json
{
  "mcpServers": {
    "win-mcp": {
      "url": "https://mcp.你的域名.com/mcp",
      "headers": {
        "Authorization": "Bearer <你的clientKey>"
      }
    }
  }
}
```

## Claude Desktop

编辑 `%APPDATA%\Claude\claude_desktop_config.json`，把上面的 JSON 合并进去，
然后**完全退出并重启** Claude Desktop（托盘里也要退）。

## Cline / Continue / Cursor

在客户端的 MCP 设置页选「远程 / HTTP」，填：

- URL：`https://mcp.你的域名.com/mcp`
- Header：`Authorization: Bearer <你的clientKey>`

## 验证

连上后问一句「列一下你能用的工具」，应该能看到 43 个；再说「ping 一下」。

> **注意**：这类客户端一般支持 MCP 的审批表单（elicitation），所以写文件、跑命令时
> 会在客户端弹确认框，跟飞书体验一致。

---

# 路径 C：纯 API 桥接

**适合情况**：你只有 OpenAI/DeepSeek/通义/本地 Ollama 这类 API key，
用的客户端不支持 MCP。

**核心原理**：云端模型本身**发不出 HTTP 请求**，它只会输出「我要调用某工具」。
桥接程序就是那只手——替它真的去调你的服务器。

```
你的电脑
  ├─ win_mcp 服务端（localhost:3000）
  └─ 桥接程序 ← 你运行这个
        │
        ├─ ① 把 43 个工具定义发给云端模型
        ├─ ② 模型回「调用 read_file{path}」
        ├─ ③ 桥接真的去调服务器 ← 关键
        ├─ ④ 结果喂回模型
        └─ ⑤ 循环直到模型不再要工具
```

## 配置

桥接程序**零依赖**（用 Node 内置 fetch），不用额外 `npm install`。

```powershell
npm run build        # 如果还没 build

$env:MCP_BRIDGE_URL      = "https://mcp.你的域名.com/mcp"
$env:MCP_BRIDGE_TOKEN    = "<你的clientKey>"
$env:MCP_BRIDGE_PROVIDER = "deepseek"          # 见下表
$env:MCP_BRIDGE_MODEL    = "deepseek-chat"
$env:MCP_BRIDGE_API_KEY  = "<你的模型API key>"

node dist/bridge/cli.js "看看我的项目里有什么文件"
```

## 支持的模型服务

| provider | base URL | 说明 |
|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | 默认 |
| `openai` | `https://api.openai.com/v1` | |
| `anthropic` | `https://api.anthropic.com` | Claude |
| `openai-compatible` | 自己填 `MCP_BRIDGE_BASE_URL` | 通义、Kimi、智谱、Groq、OpenRouter、vLLM、Ollama、LM Studio… |

只要对方兼容 `/chat/completions` 接口，就能用 `openai-compatible`：

```powershell
$env:MCP_BRIDGE_PROVIDER = "openai-compatible"
$env:MCP_BRIDGE_BASE_URL = "http://127.0.0.1:11434/v1"   # 比如 Ollama
$env:MCP_BRIDGE_MODEL    = "qwen2.5-coder"
```

## 交互模式

不带指令参数就是对话模式，会保留上下文：

```powershell
node dist/bridge/cli.js
```

```
win-mcp bridge — 43 tools — model deepseek-chat @ https://api.deepseek.com/v1
MCP: https://mcp.你的域名.com/mcp

Type an instruction. /exit to quit, /reset to clear context.

you> 看看项目里有什么
  → list_directory(path="F:\\MyProjects")
    ✓
项目里有 3 个目录……

you> /exit
```

指令：`/exit` 退出，`/reset` 清空上下文。

## 审批（重要）

写文件、跑命令这类操作，服务端会要求确认。**桥接程序会在你的终端里弹表单**：

```
  ── approval required ──
  Authorize write_file?
  Target: F:\MyProjects\a.txt
  Scope: exact path
  Risk: The caller supplied an absolute path.

  [1] Allow once
  [2] Allow for this session
  [3] Always allow
  [4] Deny

  choose>
```

用 `MCP_BRIDGE_APPROVE` 控制：

| 值 | 行为 |
|---|---|
| `ask`（默认） | 每次都在终端里问 |
| `allow_once` | 全部自动放行一次，不问 |
| `allow_session` | 本次运行内自动放行 |
| `allow_permanent` | 永久记住 |
| `deny` | 全部拒绝 |
| `off` | 不声明审批能力，让服务端按自己的策略处理 |

> ⚠️ **`allow_once` 及以上等于跳过人工确认**。只在你完全信任那个模型、
> 且 `ALLOWED_DIRS` 范围很窄的时候用。
>
> 没有终端时（比如 CI）默认**拒绝**，不会静默放行。

## 所见即所得的输出

```
win-mcp bridge — 43 tools — model deepseek-chat @ https://api.deepseek.com/v1
MCP: https://mcp.你的域名.com/mcp

  → read_file(path="package.json")
    ✓
  → execute_command(command="npm test")
    ✓
测试全部通过，共 1016 个用例。
```

`→` 是工具调用，`✓` 是成功，`✗` 是失败。加 `MCP_BRIDGE_VERBOSE=1` 还能看到 token 用量和结果摘要。

## 已知限制

- **模型不认识 `oneOf`**：仓库里 9 个工具（`git_workflow`、`manage_text_transfer` 等）
  用的是 `oneOf` 分支结构，桥接程序会自动**展平成 `action` 枚举**再发给模型。
  服务端仍然做完整校验，展平只影响模型怎么理解，不降低安全性。
- **不保留跨会话记忆**：每次启动是新的。同一个会话内（REPL）保留上下文。
- **大输出会截断**：单个工具结果超过约 12000 字符时，保留开头和结尾，中间标注省略。

---

# 三条路怎么选

```
你平时用飞书吗？
  ├─ 是 → 路径 A
  └─ 否 → 你有支持 MCP 的客户端吗（Claude Desktop / Cline / Cursor）？
            ├─ 有 → 路径 B（最省事，功能最全）
            └─ 没有，只有一个 API key → 路径 C
```

**经验之谈**：路径 B 的体验最好——客户端会渲染审批表单、能展示 diff、能多轮澄清。
路径 C 是「只有 API key 时的保底方案」，能用，但审批只能在终端里敲数字。

---

# 排错

## 401 / 无法连接

按顺序查：

1. **配对了吗？** 没配对直接调 `/mcp` 必然 401
2. **密钥对吗？** 用带密钥的 `/health` 测：
   ```powershell
   curl -H "Authorization: Bearer <clientKey>" https://你的域名/health
   ```
   返回 43 个工具 = 密钥对；只返回 4 个字段 = 密钥错
3. **endpoint 是 `/mcp` 吗？**
4. **`PUBLIC_HOST` 配了吗？** 没配会拒绝外部 Host
5. **隧道在线吗？** `cloudflared tunnel info win-mcp`

## 桥接程序报 "cannot reach the MCP server"

- 本地先试 `http://127.0.0.1:3000/mcp`
- 远程确认隧道进程还活着
- 报 401 时看提示：它会告诉你去配对

## 模型一直说"我没有工具"

工具定义没送到模型。检查：

- `MCP_BRIDGE_PROVIDER` 和 `MCP_BRIDGE_BASE_URL` 是否匹配（有的服务要 `/v1`，有的不要）
- 启动横幅显示的 tools 数量是不是 43

## 写文件被拒："client cannot display a form"

`MCP_BRIDGE_APPROVE=off` 会导致这个。改成 `ask` 或 `allow_once`。

## 审批每次都问，很烦

改成 `MCP_BRIDGE_APPROVE=allow_session`，本次运行内不再问。

---

# 安全须知

1. **`ALLOWED_DIRS` 写窄**。写 `F:\MyProjects`，不要写 `F:\`。
2. **`clientKey` 等同密码**。别提交、别截图、别发群里。
3. **`clients.json` 只有摘要**，泄露也无法直接使用，但仍然别提交。
4. **云端模型是外部输入源**。它能控制 `execute_command`，理论上存在提示词注入风险；
   四层防护（鉴权/owner/目录边界/命令审批）能挡住大部分，但别给它整盘权限。
5. **不用了随时吊销**：在对话里说「吊销 laptop」，或
   `POST /clients/revoke {"label":"laptop"}`。
