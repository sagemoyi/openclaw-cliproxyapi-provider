# Issue #1 兼容性复核

复核日期：2026-09-09。原始反馈：[issue #1](https://github.com/sagemoyi/openclaw-cliproxyapi-provider/issues/1)，重复的 #2 已关闭。

本轮使用 Node.js `v24.16.0`；原报告使用 `v24.19.0`。隔离兼容测试使用本地模拟 CPA 和测试凭据；另通过本机已配置 CPA 完成三项真实推理验证（见下文），不复刻原报告的远程环境。宿主 CLI 与插件所解析的 SDK 必须匹配。

## 本轮独立验证范围

| OpenClaw | PTY 登录及 profile 持久化 | CLI sync 正常退出 | Gateway 动态刷新 |
| --- | --- | --- | --- |
| `2026.7.1-2` | 通过 | 通过 | 通过，旧选择器需重启 |
| `2026.8.1` | 通过 | 发布成功后挂起 | 未测试 |
| `2026.8.2` | 通过 | 发布成功后挂起 | 未测试 |
| `2026.9.1` | 通过 | 通过 | 通过，无需重启 |
| `2026.9.2` | 通过 | 通过 | 通过，无需重启 |
| `2026.9.3` | 通过；另复现宿主隔离检查拒绝 | 通过 | 通过，无需重启 |

这些结果来自本地模拟 CPA，不代表上述版本在原报告的真实端点上推理成功。

## 已通过的发布兼容测试

使用独立 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH` 和动态分配的本地端口运行：

```bash
npm test
npm run check
npm run test:host
npm run test:gateway
```

分别在 `2026.7.1-2`、`2026.9.1`、`2026.9.2`、`2026.9.3` 运行宿主与 Gateway 用例；每次运行前确认 PATH 中的 OpenClaw 与项目 peer SDK 是同一精确版本。

- 69 项纯逻辑／契约测试通过。
- 真实 SDK 的 Chat Completions 传输、CLI 安装、catalog、sync 及目录新增／删除通过。
- 新增 Responses 回归测试通过：`gpt-5.3-codex-spark` 使用 `POST /v1/responses`，携带正确的 Bearer 测试凭据及 `reasoning.effort`，能读取 SSE 文本；模拟 403 以错误返回，不切换到 Chat Completions。
- September 隔离前台 Gateway 通过公开 `models.list` RPC 验证新增、删除、上下文变化及空目录，无需重启；同时验证已有默认模型访问策略的合并。July 验证 legacy 目录及重启后的旧选择器。
- catalog 输出已改为显式选择模型和诊断字段，不输出端点地址或认证状态；真实 CLI 集成断言通过。模型 ID 和标签仍属于诊断内容，公开前需检查是否含私有信息。

## 2026.8.1 / 2026.8.2 的 sync 退出问题

使用未修改的 `0.1.1` 发布包、对应版本的 SDK/CLI 和本地模拟 CPA，两版均复现：

1. `cpa sync` 输出 `synced: true`、`models: 1`、`mode: "prepared"`。
2. 30 秒后进程仍存活，由测试驱动终止。
3. 资源探针显示 stdout/stderr 的 `PipeWrap` 之外还有 `MessagePort`，其 `hasRef()` 为 `true`，没有未完成的网络请求。

同一 `2026.8.2` 环境下的 `cpa catalog` 对照在约 6.4 秒内正常退出，进一步将问题限定到 prepared 发布路径。

这说明目录发布完成与命令正常退出是两个独立结果。资源和源码证据指向宿主 prepared catalog 的工作线程生命周期，而不是插件的目录请求超时。

本次 `readOnly: false` 路径中，August 宿主的 `activateStandalonePreparedModelRuntime()` 创建 standalone owner；该 owner 持续有效，使目录 worker 留存。`2026.9.3` 增加了 `captureModelRuntimeLifetime()` / `registerPreparedModelRuntimeClose(closeModelRuntime)` 与 CLI 收尾清理：关闭 runtime 会清除 owner，worker 检测到代际失效后停止并终止线程。新版另有 lease 作用域改进，但它不是本次已复现路径的主要原因。

需要可靠的一次性 CLI sync 时，建议使用本轮验证通过的 `2026.9.3`。不通过 `process.exit()` 强制退出或私有 SDK 导入绕过宿主生命周期。`2026.9.1` / `2026.9.2` 的精确版本验证结果见上表。

## 登录与隔离环境

在本机 `2026.9.3` 的实际 PTY 测试中，登录在显示端点和密钥提示之前退出。宿主报告 CLI 与已安装 Gateway 服务的状态目录及配置路径不同，并明确说明未写入凭据或配置。这是宿主的状态存储一致性检查，插件认证回调尚未执行。

使用测试专用配置 `gateway.mode: "remote"`、`gateway.remote.url: "wss://gateway-test.invalid"`，并将实际 CPA 指向本地模拟服务后，`2026.7.1-2`、`2026.8.1`、`2026.8.2`、`2026.9.1`、`2026.9.2` 和 `2026.9.3` 均已完成真实 PTY 登录，退出码为 0：

- 创建 `cliproxyapi:default` API key profile；通过 `models auth list --json` 确认保存成功。
- 写入 provider 的 `baseUrl` 和 `models: []`，加入 `agents.defaults.models["cliproxyapi/*"]`。
- 本地模拟服务接收带测试凭据的模型目录请求，并返回 1 个模型。

上述 remote 模式仅是测试夹具，不是生产环境登录修复建议；认证控制流程没有连接该 `.invalid` Gateway 地址。原报告的每次 TTY 失败仍需具体日志才能逐一归因。

`2026.7.1-2` 的公开认证列表指向隔离状态目录下的 `agents/main/agent/openclaw-agent.sqlite`；`2026.8.1` / `2026.8.2` / `2026.9.1` / `2026.9.2` / `2026.9.3` 则指向 `state/openclaw.sqlite`。缺少旧 JSON 文件或 agent 数据库没有记录，并不代表 auth profile 为空；应使用宿主命令返回的 `authStatePath` 和 profile 列表验证。

因此，复现认证时应记录失败阶段和具体错误。独立 `OPENCLAW_HOME` 或状态目录并不保证所有凭据写入和服务管理命令可用；不要为了通过测试而卸载或重配正在使用的 Gateway。

## SDK 测试自身的状态隔离修正

`2026.9.1` / `2026.9.2` 的直接 SDK 用例最初在 HTTP 请求前失败：它们读取到本机新版 SQLite 状态，支持的 schema 为 15，而状态库为 16。CLI 子进程已有隔离，直接 SDK 导入此前没有。

测试现通过 `test/isolated-host-env.js` 在任何宿主 SDK 导入前创建临时状态目录和空配置，避免依赖或访问个人环境。此外，9.1 Gateway 会因继承 `VOYAGE_API_KEY` 而自动安装无关 provider，并触发配置迁移重启。测试驱动现清除继承的 API key/token 等凭据变量，统一使用模拟配置中的测试凭据。上述修改仅影响测试驱动，不改变插件认证、目录或传输逻辑。

## 0.1.2 的真实推理验证

使用 OpenClaw `2026.9.3` 的公开 SDK、当前插件代码，以及本机已有 CPA 端点和 auth profile。凭据仅通过宿主接口解析，主配置未修改。每个模型只发送一个短请求，要求返回 `OK`，输出上限为 512 tokens。

| 模型 | 协议 | thinking | 结果 |
| --- | --- | --- | --- |
| `gpt-5.3-codex-spark` | OpenAI Responses | low | 正常结束并返回文本 |
| `gpt-5.6-luna` | OpenAI Responses | low | 正常结束并返回文本 |
| `grok-4.3` | Chat Completions | off | 正常结束并返回文本 |

三个请求的 `stopReason` 均为 `stop`，没有 403。目录返回 24 个模型。这证明本轮端点上的代表性实际调用可用，不代表所有模型、最大上下文或原远程环境都已通过。原报告的远程环境未复刻。

## 原报告中尚不能确定的结论

- 六版本同一端点、同一模型上的 403 不能单独定位到插件、代理或上游权限。需要在同环境、同凭据下直接请求 `/responses`，再与 OpenClaw 的请求对照。本轮代表性真实请求均已成功，但不对原远程环境的 403 根因作结论。
- `models: []` 已包含在非交互配置文档及登录生成的配置中；手动配置时应保留它。
- `modelPolicy.allow` 缺失不是模型不可见的充分证据。插件只合并已有策略；未设置该策略时使用 `agents.defaults.models`。手动粘贴凭据也不等同于运行插件登录回调。
- `models set --agent` 的支持范围属于宿主 CLI，应使用相应版本的帮助输出确认。仓库的模型切换示例不包含该参数。
- 隔离环境下 `gateway restart` 的退出状态不证明插件目录是否刷新，应验证实际 Gateway 的模型列表。
- memory 的 OpenAI key 错误需根据具体日志判断；不能直接宣布可忽略。

0.1.2 将展示名调整为 **OpenClaw CLIProxyAPI Provider**；安装包名和 `cliproxyapi` provider ID 保持不变。
