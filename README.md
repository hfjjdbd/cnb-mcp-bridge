# cnb-mcp-bridge

**共同第一作者 / Equal first authors: [hfjjdbd](https://github.com/hfjjdbd) & [Codex](https://github.com/codex) (OpenAI AI coding assistant).**

一个面向 MCP 客户端的轻量连接脚本：将远程 **Streamable HTTP MCP 工具**接入本地 **stdio MCP**，可选支持 CNB 云开发环境地址自动发现。它不是 Codex 专用插件，也不是独立 EXE。

本项目的接入代码基于官方 MCP SDK；远端可复用开源 [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) 与 [mcp-proxy](https://github.com/punkpeye/mcp-proxy)。本项目不包含、复制或修改这些上游项目的实现。作者与依赖贡献者见 [AUTHORS.md](AUTHORS.md)。

## 两种接入方式

```text
支持 HTTP MCP 的 agent ─────────────→ 已部署的远程 MCP 服务
支持 stdio MCP 的 agent → 本项目脚本 → 已部署的远程 MCP 服务
```

- 客户端支持 Streamable HTTP 和认证请求头时，可直接连接远程地址，不必安装本项目。
- 客户端仅支持 stdio，或需要 CNB 地址发现时，可使用本项目。
- 本项目目前转发 `tools/list`、`tools/call`，包括工具结果中的文本和其他标准内容块。不转发 resources、prompts、sampling、elicitation 或 MCP tasks。
- 不保证所有 agent 产品均支持所需协议、请求头或本地进程；需按具体客户端能力配置。
- 不提供远端部署、容器保活、备份或持久化管理。

## 安装

需要 Node.js 22 或更新版本，以及一个已部署、带认证的 Streamable HTTP MCP 服务。

```sh
git clone https://github.com/hfjjdbd/cnb-mcp-bridge.git
cd cnb-mcp-bridge
npm ci --ignore-scripts
npm test
```

仓库提供源码，尚未发布 npm 包或 EXE。Windows 使用 `node.exe` 执行脚本；Linux/macOS 使用 `node`。

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
| `CNB_CLI_PATH` | 已安装 CNB CLI 的 `bin/cnb.js` 绝对路径 |
| `CNB_MCP_PORT` | 远端 MCP 服务端口，默认 `8000` |
| `MCP_API_KEY_FILE` 或 `MCP_API_KEY` | 远端 MCP 服务的独立认证密钥 |

CNB CLI 必须已登录，或收到现有 CNB 认证环境变量。CNB 认证用于查询环境地址；MCP 密钥用于调用工具，二者不是同一凭据。需要透传哪些环境变量由 MCP 客户端决定；脚本不会替你创建或保存 CNB 令牌。

发现逻辑只接受目标仓库唯一的运行中环境；没有匹配项或同时有多个匹配项时停止连接，不选择其他仓库。它不会启动、停止、重建容器或部署服务。生成的地址为 `https://<business-id>-<port>.cnb.run/mcp`。

地址在建立新远程连接时发现。容器重建后，已有连接中的操作可能失败；确认操作结果后重启本地 MCP 客户端以重新发现地址，不要盲目重复写操作。该机制不保证在断线时无缝恢复。

## 多 agent 与隐私边界

各客户端可以启动各自的桥接进程。远端是否隔离终端、目录和权限由远端 MCP 服务决定；本项目不提供多租户隔离。访问同一工作区时，应协调文件修改并只管理自己的终端进程。

桥接器只连接配置的服务或 CNB 官方发现出的端点，不使用 Remote Desktop Commander 的托管转发平台。底层云平台、网络和 agent 产品本身的限制仍由各自服务决定。

连接要求 HTTPS，仅回环地址允许 HTTP 用于本地测试。认证放在请求头中，禁止带凭据、查询参数或片段的 URL，并拒绝 HTTP 重定向。桥接器不打印密钥和 CNB CLI 原始错误输出，但远端工具的正常结果会原样返回：调用敏感文件或环境变量工具仍可能把数据交给 agent。

详见 [SECURITY.md](SECURITY.md)。本仓库的配置与测试使用虚构示例，不包含任何正在运行的实例标识、连接密钥或私人仓库信息。

## 测试与限制

`npm test` 在本机启动临时测试服务，验证两个 stdio 客户端并发访问、工具错误传递、认证拒绝、CNB 精确选择和 URL 校验，不需要真实账户或云容器。

工具调用超时为五分钟。连接失败不会自动重放工具调用，因为远端操作可能已经发生。远端返回的 `isError` 结果会原样转发。

## 许可证

本项目原创接入代码使用 [MIT License](LICENSE)。依赖项目遵循各自的许可证。
