# cnb-mcp-bridge

**共同第一作者 / Equal first authors: [hfjjdbd](https://github.com/hfjjdbd) & [Codex](https://github.com/codex) (OpenAI AI coding assistant).**

一个轻量的 MCP 直连工具集：既可以把远程 **Streamable HTTP MCP** 接入本地 **stdio MCP**，也可以把容器内现有 **stdio MCP backend** 自托管为带认证的 Streamable HTTP MCP；可选支持 CNB 云开发环境地址自动发现。它不是 Codex 专用插件，也不是独立 EXE。

本项目的接入代码基于官方 MCP SDK；远端可复用开源 [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) 与 [mcp-proxy](https://github.com/punkpeye/mcp-proxy)。本项目不包含、复制或修改这些上游项目的实现。作者与依赖贡献者见 [AUTHORS.md](AUTHORS.md)。

## 两种接入方式

```text
远端容器：
local stdio MCP backend → cnb-mcp-gateway → HTTPS Streamable HTTP MCP

本地客户端：
支持 HTTP MCP 的 agent ───────────────────────────────→ gateway
支持 stdio MCP 的 agent → cnb-mcp-bridge → gateway
```

- `bin/server.mjs` / `cnb-mcp-gateway`：把本机 stdio MCP backend（例如 Desktop Commander MCP）通过带独立 API key 的 Streamable HTTP MCP 暴露出去。
- `bin/bridge.mjs` / `cnb-mcp-bridge`：把远端 Streamable HTTP MCP 转成客户端可消费的 stdio MCP，并可选自动发现 CNB workspace 地址。
- 两端都只代理 `tools/list`、`tools/call`；不转发 resources、prompts、sampling、elicitation 或 MCP tasks。
- 目标数据面不依赖 Desktop Commander 的 hosted Remote relay；底层 CNB 网络、客户端 AI 服务和仓库本身仍各自独立。
- 本项目不负责启动/停止 CNB workspace、备份业务数据或提供多租户沙箱。

## 安装

需要 Node.js 22 或更新版本，以及一个已部署、带认证的 Streamable HTTP MCP 服务。

```sh
git clone https://github.com/hfjjdbd/cnb-mcp-bridge.git
cd cnb-mcp-bridge
npm ci --ignore-scripts
npm test
```

仓库提供源码，尚未发布 npm 包或 EXE。Windows 使用 `node.exe` 执行脚本；Linux/macOS 使用 `node`。

## 在远端启动自托管 Gateway

远端需要一个可直接以 stdio 运行的 MCP backend。下面只用虚构路径和独立密钥文件示例：

```sh
install -d -m 700 "$HOME/.local/state/cnb-mcp"
umask 077
# 首次部署时自行生成随机密钥并安全传给客户端；不要把密钥写进仓库。
# printf '%s' '<random-secret>' > "$HOME/.local/state/cnb-mcp/api-key"

GATEWAY_HOST=0.0.0.0 \
GATEWAY_PORT=8000 \
GATEWAY_API_KEY_FILE="$HOME/.local/state/cnb-mcp/api-key" \
GATEWAY_BACKEND_COMMAND=/absolute/path/to/stdio-mcp-server \
GATEWAY_BACKEND_CWD=/workspace \
node bin/server.mjs
```

Gateway 提供 `GET /healthz` 最小健康状态和 `/mcp` Streamable HTTP MCP。默认拒绝带浏览器 `Origin` 的请求；需要浏览器访问时显式设置 `GATEWAY_ALLOWED_ORIGINS`。Session 只保存在内存，并受空闲 TTL / 最大 session 数限制。一个 gateway 共享一个可重建的 stdio backend；工具失败或超时不会自动重放，以避免重复写操作。

完整环境变量和 CLI 参数：

```sh
node bin/server.mjs --help
```

在 CNB workspace 中通常监听 `0.0.0.0:8000`，由 CNB 提供外部 HTTPS。当前 CNB edge 会向转发请求注入/重写一个形如 `http://<business-id>-<port>.cnb.run` 的 `Origin`；因此若启用 gateway 默认的 Origin 拒绝策略，应把这个**精确的 edge Origin**加入 `GATEWAY_ALLOWED_ORIGINS`。它与客户端访问的外部 HTTPS URL 不同。不要在公开配置中硬编码真实 business id；客户端可以使用下文的 CNB 自动发现。

## 通用 stdio 客户端配置

以下为常见的 `mcpServers` 配置形式。使用你自己的绝对路径、服务地址和私有密钥文件；不同客户端的配置字段可能不同。

```json
{
  "mcpServers": {
    "remote-tools": {
      "command": "node",
      "args": ["/absolute/path/to/cnb-mcp-bridge/bin/bridge.mjs"],
      "env": {
        "MCP_ENDPOINT": "https://mcp.example.com/mcp",
        "MCP_API_KEY_FILE": "/absolute/path/outside/repository/mcp-api-key"
      }
    }
  }
}
```

Windows 示例路径写为 `C:/projects/cnb-mcp-bridge/bin/bridge.mjs`；若客户端找不到 Node，请将 `command` 改为 `node.exe` 的完整路径。

密钥文件由你自行保存在仓库之外，内容为实际服务端接受的密钥。不要把密钥写进公开的 JSON 示例。使用密钥管理器时，也可由客户端进程注入 `MCP_API_KEY`；两种方式不能同时配置。

默认发送 `X-API-Key` 请求头。对于 Bearer 认证，设置 `MCP_AUTH_HEADER=Authorization`，密钥文件内容使用完整的 `Bearer <your-token>`。

## 可选：CNB 地址自动发现

不配置 `MCP_ENDPOINT`，改为配置：

| 环境变量 | 说明 |
| --- | --- |
| `CNB_REPOSITORY` | 目标仓库路径，例如 `example/workspace` |
| `CNB_CLI_PATH` | 已安装 CNB CLI 的 Node 入口绝对路径，例如实际的 `cnb` JavaScript 入口 |
| `CNB_MCP_PORT` | 远端 MCP 服务端口，默认 `8000` |
| `CNB_TOKEN_FILE` | 可选；非交互环境从仓库外的私有文件读取 CNB API token。普通本地使用优先 `cnb login` |
| `MCP_API_KEY_FILE` 或 `MCP_API_KEY` | 远端 MCP 服务的独立认证密钥 |

CNB CLI 必须已登录、收到现有 CNB 认证环境变量，或显式配置 `CNB_TOKEN_FILE`。CNB 认证只用于查询 workspace 地址；MCP 密钥只用于调用远端工具，二者不是同一凭据。`CNB_TOKEN_FILE` 和 MCP key 文件都应位于仓库外并限制文件权限；脚本不会创建 CNB token。

发现逻辑只接受目标仓库唯一的运行中环境；没有匹配项或同时有多个匹配项时停止连接，不选择其他仓库。它不会启动、停止、重建容器或部署服务。生成的地址为 `https://<business-id>-<port>.cnb.run/mcp`。

地址在建立新远程连接时发现。容器重建后，已有连接中的操作可能失败；确认操作结果后重启本地 MCP 客户端以重新发现地址，不要盲目重复写操作。该机制不保证在断线时无缝恢复。

## 多 agent 与隐私边界

各客户端可以启动各自的桥接进程。远端是否隔离终端、目录和权限由远端 MCP 服务决定；本项目不提供多租户隔离。访问同一工作区时，应协调文件修改并只管理自己的终端进程。

桥接器只连接配置的服务或 CNB 官方发现出的端点，不使用 Remote Desktop Commander 的托管转发平台。底层云平台、网络和 agent 产品本身的限制仍由各自服务决定。

连接要求 HTTPS，仅回环地址允许 HTTP 用于本地测试。认证放在请求头中，禁止带凭据、查询参数或片段的 URL，并拒绝 HTTP 重定向。桥接器不打印密钥和 CNB CLI 原始错误输出，但远端工具的正常结果会原样返回：调用敏感文件或环境变量工具仍可能把数据交给 agent。

本地电脑同时接入一个或多个 CNB workspace 的完整部署、动态地址发现、独立 key、重建恢复与轮换流程见 [docs/LOCAL_AGENT.md](docs/LOCAL_AGENT.md)。贡献与 AI 协助说明见 [CONTRIBUTORS.md](CONTRIBUTORS.md) 与 [AUTHORS.md](AUTHORS.md)。\n\n详见 [SECURITY.md](SECURITY.md)。本仓库的配置与测试使用虚构示例，不包含任何正在运行的实例标识、连接密钥或私人仓库信息。

## 测试与限制

`npm test` 在本机启动临时 HTTP/stdio MCP 服务，验证 gateway 认证、Origin/session 边界、多客户端共享 backend、工具超时不重放、bridge→gateway 以及 CNB 精确选择和 URL 校验；不需要真实账户或云容器。`npm run check` 额外执行 Node 语法检查。

工具调用超时为五分钟。连接失败不会自动重放工具调用，因为远端操作可能已经发生。远端返回的 `isError` 结果会原样转发。

## 许可证

本项目原创接入代码使用 [MIT License](LICENSE)。依赖项目遵循各自的许可证。