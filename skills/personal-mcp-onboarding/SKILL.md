---
name: personal-mcp-onboarding
description: Teach an individual developer to independently install and use this local MCP on their own Windows computer. Use when asked about personal-device setup, Cloudflare or ngrok tunnel selection and configuration, connecting a desktop MCP client (Claude Desktop, Cline, Cursor, Continue), running the API bridge for models without MCP support (DeepSeek/OpenAI/Anthropic/Ollama), Aily MCP connection values, separate-device security, or Android and Windows development prerequisites. Inspect relevant local state first, then provide manual guidance only; never create accounts, enter secrets, install software, or change machine configuration without a separate explicit request.
---

# Personal MCP Onboarding

Guide one developer through running this repository on their own Windows computer and connecting
a client to it. Match the user's language. Keep the guidance manual and detection-first.

## Safety boundary

- Never create an ngrok account, enter a token, write `.env`, install software, alter environment variables, start a tunnel, or change client configuration unless the user separately asks to perform that action.
- Never display, repeat, place in a document, or put in a command a real `MCP_AUTH_TOKEN`, client key, ngrok authtoken, owner ID, endpoint, or user directory.
- Treat every device as independent. Do not reuse or share `.env`, tokens, ngrok URLs, allowed directories, or owner identities between computers.
- Explain that source code may be shared through Git; credentials, local build output, and personal machine paths may not.

## Workflow

1. Ask two questions before detection or setup guidance: **Which client will call this MCP — Aily, a desktop MCP client, or the API bridge?** and **Which public transport do you want: Cloudflare or ngrok?** Do not infer either answer from a project name, an existing URL, or a screenshot.
2. Route the response from those answers. All three clients share one server, so the server steps are identical; only the client step differs.
3. Identify the target: base Node project, Android project, Windows native project, or a combination.
4. Inspect only prerequisites relevant to the target and chosen transport. Prefer the repository's environment-inspection capability when available; otherwise use read-only checks. Mark each item **ready**, **missing**, **misconfigured**, or **not checked**.
5. Give manual steps in this order: clone the repository, make a local `.env`, install missing prerequisites, launch the local MCP, pair a client, configure the chosen transport, configure the client, then verify health and tool discovery.
6. Tell the user to create a new client entry, verify `ping` and tool discovery, then disable the prior same-purpose entry. Never recommend two active same-purpose entries because duplicate tool inventories make routing ambiguous.
7. Put all machine-changing commands under **Optional manual action**. Do not run them yourself until the user explicitly requests it.
8. Finish with a compact verification checklist and the next safe action.

## Pairing (shared by every client)

The server mints a permanent per-install client key on first start and prints a one-time pairing
code. Tell the user to redeem the code for their own key:

```text
POST http://127.0.0.1:3000/pair   {"code":"<the printed code>","label":"<device name>"}
```

The returned `clientKey` is what every client uses as its Bearer credential. It survives restarts,
so a client is configured once. Each pairing creates a **separate revocable client**; never tell
users to share one key between devices. Never display a real key.

If the user lost the code or wants to add a device without restarting, the owner can issue a new
one from chat with `manage_clients` action `issue_code`.

## Detection checklist

### Base setup

Check only what is needed and report versions or paths only when they are not sensitive:

- Node.js, npm and pnpm when the target is a Node project;
- Git;
- repository dependencies and build state when the repository is present;
- local MCP health endpoint and port 3000 only after the user has started it;
- cloudflared executable and named-tunnel service only when the user chose Cloudflare with a dedicated domain;
- ngrok executable and an active tunnel only when the user chose ngrok.

For a missing item, provide the official product name, the expected result, and a post-install verification command. Do not automate downloads or account registration.

### Android setup

For an Android project, additionally check Android Studio, `ANDROID_HOME` or `ANDROID_SDK_ROOT`, a JDK compatible with the project, Android SDK platform tools and `adb`, the project Gradle wrapper, and a connected device only when the user wants device testing.

When an Android prerequisite is missing, explain the manual Android Studio SDK Manager setting or environment variable to configure, then give one safe verification command such as `adb version` or `./gradlew --version`.

### Windows native setup

For a Windows native project, additionally check Visual Studio Build Tools or Visual Studio with the Desktop development with C++ workload, MSVC, a Windows SDK, CMake when the project uses it, and the project's build entry point.

Explain the required workload and verification command, but do not invoke an installer or change the machine automatically.

## Manual connection guidance

All three clients use the same server and the same `clientKey`. Give only placeholders.

### Shared server configuration

Tell the user to copy `.env.example` to a local `.env` and fill `ALLOWED_DIRS` (their own project
roots only), `OWNER_USER_ID`, and `AUTH_PIN`. `MCP_AUTH_TOKEN` is optional. They must not set
`AUTH_MODE=none` in any deployment reachable from the internet.

### Cloudflare

Only when the user chose Cloudflare and confirmed a dedicated MCP domain, tell
them to use their own Cloudflare account and a named tunnel. The local tunnel
configuration must point only to the local MCP port; the public hostname should
be a dedicated hostname such as `mcp.<the-user's-domain>`. Explain that login
credentials, certificate files, tunnel JSON, and tunnel IDs are local secrets
and must never be committed, pasted into a client, or shared between devices.
Set `PUBLIC_HOST` to the bare hostname, no scheme or path.

### ngrok

Tell the user to create their own ngrok account, install ngrok, add their own authtoken locally, and expose the locally running MCP port. They must copy the resulting personal HTTPS endpoint and append the repository's MCP path. Explain that a free ngrok domain can change after a restart, so the client endpoint must be updated when it changes.

### Aily

Give only these placeholders:

```text
MCP endpoint: https://<the-user's-public-hostname>/mcp
Authorization: Bearer <the-user's-own-clientKey>
x-aily-user: <the-user's-own-OWNER_USER_ID>
```

State explicitly: `Bearer ` plus the key belongs in the actual request-header input value. A display
name or description field is only explanatory text and does not send the authorization value.

For a personal MCP restricted to its owner, tell the user to configure `Authorization` as a fixed
request header value so Aily can discover the server tools during registration.

### Desktop MCP client (Claude Desktop, Cline, Cursor, Continue)

No code is needed. Give this JSON shape and tell them to put it where their client expects it:

```json
{
  "mcpServers": {
    "win-mcp": {
      "url": "https://<the-user's-public-hostname>/mcp",
      "headers": { "Authorization": "Bearer <the-user's-own-clientKey>" }
    }
  }
}
```

For Claude Desktop the file is `%APPDATA%\Claude\claude_desktop_config.json`, and the app must be
fully quit (including the tray icon) before it reloads. For Cline/Continue/Cursor, guide them to
the client's remote/HTTP MCP settings and the same URL plus header.

Note that these clients support MCP approval forms, so writes and commands will show a confirmation
prompt in the client, which is the intended behaviour.

### API bridge (models without MCP support)

Use this only when the user has a model API key but no MCP-capable client. Explain the architecture
in one line: **the hosted model cannot issue HTTP requests, so the bridge process executes the
tool calls the model asks for.**

The bridge is built in and needs no extra dependency. Give these variables as placeholders:

```text
MCP_BRIDGE_URL        https://<the-user's-public-hostname>/mcp
MCP_BRIDGE_TOKEN      <the-user's-own-clientKey>
MCP_BRIDGE_PROVIDER   deepseek | openai | anthropic | openai-compatible
MCP_BRIDGE_MODEL      <model id>
MCP_BRIDGE_API_KEY    <the-user's-own model API key>
```

Run `npm run bridge -- "their instruction"`, or `npm run bridge` with no instruction for an
interactive session. For any provider that speaks the OpenAI `/chat/completions` shape (Qwen, Kimi,
Zhipu, Groq, OpenRouter, vLLM, Ollama, LM Studio), use `openai-compatible` plus their own
`MCP_BRIDGE_BASE_URL`.

Warn explicitly about approvals: the bridge asks in the terminal for every write and command.
Setting `MCP_BRIDGE_APPROVE` to `allow_once` or above skips that confirmation, so it is only
appropriate with a narrowly scoped `ALLOWED_DIRS`. Without a terminal the bridge denies by default.

Also warn that hosted models are an external input source: they can drive `execute_command`, so a
prompt-injection payload in a file or web page the model reads could attempt actions. The four
server-side layers (Bearer auth, owner identity, directory boundary, command approval) are what
contain that; never widen `ALLOWED_DIRS` to a whole drive.

Recommend `MCP_BRIDGE_SCOPE` whenever `ALLOWED_DIRS` covers more than the single project the task
touches. It confines one run to the named directories and refuses other paths before they reach the
server, which is the specific defence against a steered model reading a sibling project. Mention
that it disables `execute_command` while active (that tool's reach cannot be verified against a
scope) unless the user accepts the risk with `MCP_BRIDGE_SCOPE_ALLOW_EXEC=1`.

## Response shape

Use these sections when relevant:

1. **Detection result** — a short status table.
2. **Manual setup steps** — numbered and dependency ordered.
3. **Client connection values** — placeholders only, for the chosen client.
4. **Android or Windows prerequisites** — only for the chosen target.
5. **Verification** — expected local health and tool discovery outcome.
6. **Security notes** — device independence and secret handling.

### Verifying the connection

Independently of the client, tell the user to confirm the server side:

```powershell
curl -H "Authorization: Bearer <clientKey>" https://<host>/health
```

A full diagnostics body (tool inventory and policies) means the key is correct; a four-field
liveness response means the key is wrong. This one check distinguishes an auth problem from a
network or tunnel problem, so recommend it before deeper troubleshooting.

## Teaching examples

### Node project connected through a chosen transport

First ask the transport and dedicated-domain questions. Start by reporting whether Node, npm, pnpm, Git, the repository, the local health endpoint, and the selected connector are ready. If the local server is not running, tell the user to start it manually with the repository-provided launcher. Then guide them to configure their selected transport, copy their own endpoint into a new Aily entry, set the owner-only fixed Authorization header to `Bearer <the-user's-own-MCP_AUTH_TOKEN>`, verify that Aily can enumerate the MCP tools, and only then disable the old same-purpose entry. Do not provide an actual endpoint or token.

When an Aily agent needs PNPM verification, guide it to call `node_development` with an authorized
project `workdir` and exactly one of `pnpm_version`, `test_run`, `build`, or `typecheck`. Explain
that this is the supported structured route when Aily does not attach the generic
`execute_command` tool; it never accepts arbitrary Shell commands or arguments.

For npm projects, use the same authorized workdir with only the fixed actions
`npm_ci`, `npm_test`, `npm_build`, `npm_lint`, or `npm_typecheck`; the server checks the
corresponding `package.json` script before running. For Java projects use `java_development`
with `maven_test`, `maven_package`, `maven_clean_test`, `gradle_test`, `gradle_build`, or
`gradle_assemble_debug`. Git changes use `git_workflow`; `worktree_add` accepts only a
project-relative directory and ref. Always complete `workspace_context` bootstrap/select,
read declared instructions, and `mark_instructions_read` before these tools. Do not replace
structured actions with `execute_command`.

### Android machine without SDK command-line tools or adb

Report Android Studio and JDK status, then mark SDK command-line tools and platform tools as missing. Tell the user to open Android Studio's SDK Manager, install the required command-line and platform tools for their project, set the SDK root if necessary, reopen the terminal, and verify with `adb version`. Only after that, continue with the base MCP and Aily connection steps.
