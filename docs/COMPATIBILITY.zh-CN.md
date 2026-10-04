# Issue #1 兼容性复核

初次复核日期：2026-09-09；最新适配：2026-10-04（OpenClaw `2026.9.8`）。原始反馈：[issue #1](https://github.com/sagemoyi/openclaw-cliproxyapi-provider/issues/1)，重复的 #2 已关闭。

初次复核使用 Node.js `v24.16.0`；原报告使用 `v24.19.0`。隔离兼容测试使用本地模拟 CPA 和测试凭据；另通过本机已配置 CPA 完成三项真实推理验证（见下文），不复刻原报告的远程环境。2026.9.8 的本次验证范围见下方适配记录。宿主 CLI 与插件所解析的 SDK 必须匹配。

## 历史独立验证范围

| OpenClaw | PTY 登录及 profile 持久化 | CLI sync 正常退出 | Gateway 动态刷新 |
| --- | --- | --- | --- |
| `2026.7.1-2` | 通过 | 通过 | 通过，旧选择器需重启 |
| `2026.8.1` | 通过 | 发布成功后挂起 | 未测试 |
| `2026.8.2` | 通过 | 发布成功后挂起 | 未测试 |
| `2026.9.1` | 通过 | 通过 | 通过，无需重启 |
| `2026.9.2` | 通过 | 通过 | 通过，无需重启 |
| `2026.9.3` | 通过；另复现宿主隔离检查拒绝 | 通过 | 通过，无需重启 |
| `2026.9.5` | 未复测 | 通过 | 通过，无需重启 |
| `2026.9.7` | 未复测 | 通过 | 通过，无需重启 |
| `2026.9.8` | 未复测 | 通过 | 通过，无需重启 |

这些结果来自本地模拟 CPA，不代表上述版本在原报告的真实端点上推理成功。

## 已通过的发布兼容测试

使用独立 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH` 和动态分配的本地端口运行：

```bash
npm test
npm run check
npm run test:host
npm run test:gateway
```

分别在 `2026.7.1-2`、`2026.9.1`、`2026.9.2`、`2026.9.3`、`2026.9.5`、`2026.9.7` 运行宿主与 Gateway 用例；每次运行前确认 PATH 中的 OpenClaw 与项目 peer SDK 是同一精确版本。`2026.9.7` 宿主要求 Node.js `>=24.16.0 <25 || >=26.1.0`；历史兼容测试使用仍声明 Node `>=22.16.0` 的旧插件；从 `0.1.4` 起，插件的 Node.js 要求跟随目标宿主，不再覆盖旧宿主。

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

## 2026.9.5 适配记录

- `plugins install --link` 在运行中的 CLI 自身位于被链接包内部时（例如经 `npm run` 调用仓库内 `node_modules/.bin/openclaw`），会被新增的注册表所有权检查拒绝：`package owner "cliproxyapi" has conflicting child rows`。集成测试现在解析 PATH 上首个 realpath 在仓库外的 `openclaw` 再调用；全局安装的 CLI 不受此影响。
- 无 Gateway 运行时，`models list` 只读本地已发布缓存，不再主动实时发现；需 `models list --refresh` 触发实时发现。宿主集成测试按 `--help` 输出探测该标志，旧宿主保持原行为。Gateway 运行时的 `models.list` RPC 与插件服务的 prepared 发布路径不变，`2026.9.5` 验证通过。
- 随包元数据刷新到 CPA `v7.3.10`（上游 commit `a5ab6952`）：新增 kimi-k2.8、muse-spark 系列等 7 个模型 ID；kimi-k3 / kimi-k3-256k 的 `zero_allowed` 变为 `true`；新增 3 个 gpt-image 非文本 ID 排除。上游丰富目录字段语法（`slug`、`supported_reasoning_levels`、`default_reasoning_level`、`context_window`、`max_context_window`、`max_tokens`、`input_modalities`、`visibility`、`display_name`）未变。

## 2026.9.7 适配记录

- 插件使用的公开 SDK 子路径在 `2026.9.7` 仍可导入：`plugin-entry`、`provider-catalog-live-runtime`、`provider-auth`、`provider-auth-runtime`、`provider-model-shared`、`agent-runtime`、`llm`。`loadPreparedModelCatalog` 的 prepared 发布路径未变。
- 宿主集成（CLI 安装、`cpa catalog`/`cpa sync`、`models list --refresh` 增删）与隔离 Gateway 的 `models.list` RPC 在 `2026.9.7` 通过，无需重启。PTY 登录本轮未复测。
- `2026.9.5` / `2026.9.7` 在 `--link` 指向含 `node_modules/openclaw` 的检出目录时，会把宿主包当成冲突的子插件并拒绝安装。集成测试改为 `npm pack` 后安装归档，并使用检出目录内的 peer CLI，使 CLI 与被测 SDK 为同一版本。`plugins.load.paths` 不再指向检出目录，避免源码候选盖住已安装的包记录。
- `2026.9.7` 与本插件的 `engines.node` 都是 `>=24.16.0 <25 || >=26.1.0`。
- 从 `0.1.4` 起，插件版本只声明并验证 OpenClaw `2026.9.7`：`peerDependencies`、`compat.pluginApi`、`minGatewayVersion` 与 `openclaw.build` 都是该版本。目录发布只走 `loadPreparedModelCatalog`，不再保留 `loadModelCatalog` 兼容路径。更早的宿主继续使用 `v0.1.3` 及以前的插件版本。

## 2026.9.8 适配记录（0.1.5）

- `0.1.5` 只兼容 OpenClaw `2026.9.8`；`peerDependencies.openclaw`、`compat.pluginApi`、`minGatewayVersion` 和 `openclaw.build` 统一为该版本，CI 使用同一精确版本。OpenClaw `2026.9.7` 继续使用插件 `v0.1.4`。
- Node.js 要求保持 `>=24.16.0 <25 || >=26.1.0`。插件使用的公开 SDK 子路径仍可导入，`loadPreparedModelCatalog` 的参数和 prepared 发布路径兼容现有实现，无需增加旧宿主代码路径。
- 在 Node.js `v24.16.0` 上验证真实 SDK 的 Chat Completions / Responses 流式传输、推理参数、工具 schema 及 Responses 403 错误保留；宿主 CLI 的 `cpa catalog`、`cpa sync` 正常退出，`models list --refresh` 反映模型新增和删除，主配置不被同步改写。
- `npm run test:ci` 全部通过：70 项单元／契约测试、3 项宿主集成测试和 1 项 Gateway 集成测试。两套集成测试实际执行 `npm pack` → `npm-pack:` 托管安装；Gateway 在线时的 `plugins inspect --runtime --json` 确认插件已加载、provider 已注册、安装来源为 `npm-pack`。公开 `models.list` RPC 验证新增、删除、上下文变化和空目录，无需重启。
- 测试仅使用临时状态目录、本地 mock CPA 和测试凭据，未操作常驻 dev/prod Gateway，未调用真实 CPA 推理；PTY 登录未复测。

## 2026.9.8 在线重载修复（0.1.6）

- `0.1.5` 在安装文件更新后应用到正在运行的 Gateway 时，可触发 `cliproxyapi-catalog` 服务启动超时：宿主对替换候选的 `start()` 限制为 5 秒。服务原来等待首次目录发现及 `loadPreparedModelCatalog` 发布完成；发布又可能等待替换代际激活，阻塞启动并引发后续清理／回滚失败。冷启动测试没有覆盖这一条件。
- 隔离 Gateway 内安装原 `0.1.5` 代码，修改临时安装包的 helper 并执行真实 `plugins reload --json`，复现同样的 5000ms 启动超时和回滚错误。
- `0.1.6` 改为后台发起首次同步，`start()` 立即返回；重复启动仍只保留一个循环，`stop()` 仍等待进行中的同步，过期代际不再调度定时器。
- 修正后 `npm run test:ci` 通过：71 项单元／契约、3 项宿主、1 项 Gateway 集成。Gateway 测试断言真实代码替换已应用、不需要重启，并继续验证目录增删、上下文变化和空目录。该修正从 `0.1.6` 起提供，`0.1.5` 不含该修正；诊断只读取生产日志，修复验证全部在临时环境中完成。

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
