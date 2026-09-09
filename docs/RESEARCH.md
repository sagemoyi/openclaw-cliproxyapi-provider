# 架构与兼容性

[English](ARCHITECTURE.md) | 简体中文

本文说明 provider 的数据来源、宿主集成边界和维护约束。安装与使用见 [README](../README.zh-CN.md)，验证方法见 [测试与开发指南](TESTING.md)。

## 设计范围

插件负责将 CPA 的模型可用性与能力信息接入 OpenClaw。认证存储、推理传输、工具事件、会话执行和生成目录的持久化由宿主负责。

实现使用 OpenClaw 公共 SDK，不导入带构建哈希的私有模块，不修改宿主源码，不向 CPA 管理接口索要管理权限。

## 数据来源

| 来源 | 用途 | 边界 |
| --- | --- | --- |
| `/v1/models` | 模型可用性与归属 | 定义可注册的模型集合 |
| `/v1/models?client_version=` | 上下文、输出限制、输入模态、reasoning 档位 | 可能包含合成默认值，不等同于完整原生能力事实 |
| `data/cpa-models.json` | 已知模型能力补充、模板修正和媒体模型排除 | 按精确 ID 匹配，不推断任意 alias，不扩展可用模型集合 |
| 显式 provider/model 配置 | 部署特定的能力和协议覆盖 | 经 OpenClaw 原有配置机制处理 |

CPA 在查询参数中存在 `client_version` 时返回客户端能力目录。已审查的实现对空值或不可解析的版本保留扩展 reasoning 档位；官方 pi 插件使用 `client_version=pi`，本项目使用空值。

解析器接受 `models[]`、`data[]` 或顶层数组。丰富目录的模型标识支持 `slug` 和 `id`，reasoning 支持字符串及含 `effort` 字段的对象。非法行和重复丰富目录 ID 会使快照构建失败，避免把坏响应解释为模型删除。

普通接口返回成功而丰富接口返回 404/405 时，允许使用后备数据。忽略查询参数、仅返回普通列表的旧端点也可回退。认证错误、服务端错误和无效响应不被当作“不支持丰富目录”。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `index.js` | 注册 provider、认证入口、控制面目录、服务和 CLI |
| `src/catalog.js` | URL 校验、目录获取、能力投影、缓存和诊断 |
| `src/provider.js` | 动态模型解析、配置覆盖、thinking profile 和请求参数适配 |
| `src/sync.js` | 调用宿主目录发布 API 并验证发布结果 |
| `src/lifecycle.js` | 串行同步、发布指纹及后台服务生命周期 |
| `scripts/update-metadata.mjs` | 从固定 CPA revision 更新后备数据 |

## OpenClaw 集成

`registerProvider` 注册认证与文本运行时模型能力。`catalog.run` 提供模型配置，`prepareDynamicModel`、`resolveDynamicModel` 和 `normalizeResolvedModel` 处理动态模型及最新元数据。

`registerModelCatalogProvider` 提供统一控制面的 live catalog。`resolveThinkingProfile` 提供模型可用的思考档位；`wrapStreamFn` 和 `wrapSimpleCompletionStreamFn` 在请求前重新检查目录并修正最终 payload。

HTTP 目录访问使用 `fetchLiveProviderModelRows`。推理请求继续走宿主的标准传输，历史消息处理复用 OpenAI-compatible replay hooks。不自行实现 SSE 解析器或 agent 执行循环。

## 能力投影

实时字段优先，缺失时使用随包数据，仍未知时采用保守默认值。上下文与输出限制只接受正的安全整数；输出限制不超过上下文。

后备数据还处理两类已知信息缺口：

- 部分非 reasoning 模型继承客户端模板的通用思考档位。
- 部分预算型 thinking 模型在客户端目录中不包含离散档位，需要根据已知预算范围转换。

这些修正依赖精确 ID 和已审查的 CPA 定义。未知 alias、服务端自定义映射和未来模板变化可能无法可靠识别；诊断信息会暴露来源与限制，用户可禁用后备数据或显式覆盖模型配置。

成本默认值是未知占位，不是价格承诺。插件不访问 models.dev，也不下载或执行目录中的指令、工具定义或脚本。

## 缓存与同步

缓存键由规范化端点和凭据的 SHA-256 构成，进程内最多保留 16 个条目。同一目录的并发获取合并；普通与丰富目录请求完成并通过校验后才替换成功快照。

瞬时故障允许在 TTL 后的有限窗口内使用旧数据，不延长原快照寿命。同步读取也保留过期标志。任一接口返回 401/403 都优先使缓存失效，即使另一接口同时返回 5xx。

目录发布使用串行队列，避免较早操作晚于较新操作写入。成功发布的指纹包含端点、目录 revision、配置和 agent 范围；失败不更新指纹，因此可以重试。过期快照不作为新目录发布。

服务停止会等待进行中的启动或刷新任务。generation 检查阻止已停止或被替代的定时器重新建立刷新循环。插件不提供独立的磁盘缓存或凭据文件。

## 宿主目录发布

### Legacy catalog API

当宿主提供 `loadModelCatalog` 时，插件构造包含最新模型的临时配置视图，并调用 `useCache:false`。宿主负责合并、凭据处理、目录写锁及文件持久化；临时视图不会写回 OpenClaw 主配置。

此路径主要面向默认 agent 的目录发布。其他 agent 继续使用宿主发现和请求前检查，不承诺所有既有会话同步热替换。

部分版本另有 Gateway `models.list` 缓存，其失效机制不在公共 SDK 中。插件不通过私有 API、替换 RPC 或反复修改配置规避该边界；用户可能需要正常重启或配置重载。

### Prepared catalog API

当宿主提供 `loadPreparedModelCatalog` 时，插件传入真实配置，并设置 `readOnly:false`、`refreshFullCatalog:true`，由宿主刷新已发布的目录状态，不再构造 legacy 临时视图。

该分支已完成源码与参数契约核对，尚未完成新版 Gateway 端到端验证。API 探测用于选择集成路径，不代表所有后续版本都已经验证。

两条路径都会校验发现的模型是否完整发布，以及是否意外残留已删除模型。用户显式配置的模型不作为意外残留。

## 兼容性基线

| 组件 | 基线 | 验证范围 |
| --- | --- | --- |
| OpenClaw | `2026.7.1-2` | 真实 SDK、CLI 安装和隔离 Gateway 集成 |
| OpenClaw prepared catalog | `2026.9.1`、`2026.9.2`、`2026.9.3` | 真实 SDK、CLI 和隔离 Gateway；通过公开 RPC 验证无需重启的目录更新 |
| CPA | `v7.2.149` 与下列固定源码 revision | 目录及 thinking 逻辑审查、代表性请求验证 |
| 官方 pi 插件 | `1.4.15` | 目录解析、映射、缓存与刷新实现参考 |

兼容范围不是对所有模型、代理配置或最大上下文的验证承诺。CPA 目录与实际请求验证器可能不一致，尤其是扩展 reasoning 档位；该差异不能仅靠客户端 metadata 完全消除。

## 官方 pi 插件与复用边界

[pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider) 是本项目目录格式兼容和刷新协调的重要参考。

pi 插件使用 `pi.extensions`、pi ExtensionAPI、登录命令及会话事件。OpenClaw 的 provider 注册、认证和目录发布具有独立生命周期，不能仅通过添加 manifest 直接加载整套 pi 扩展。

本项目保留两者适用的通用做法，同时采用适合 OpenClaw 的独立实现：

- 兼容多种目录和 reasoning 字段格式。
- 协调刷新，防止过期操作覆盖较新状态。
- 使用 OpenClaw 公共传输，而不引入 pi Codex transport 的运行时源码补丁。
- 保留按凭据隔离、有界 stale 和认证失败失效策略。
- 不接管 TUI、Fast、暂停、重试或上下文压缩。

## 源码参考

以下链接固定到审查时的 revision，便于后续维护复核：

- [CPA OpenAI models handler](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/sdk/api/handlers/openai/openai_handlers.go)
- [CPA 客户端目录生成](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/internal/client/codex/models/models.go)
- [CPA 模型注册表](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/internal/registry/model_registry.go)
- [CPA thinking 转换](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/internal/thinking/convert.go)与[验证](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/internal/thinking/validate.go)
- [OpenClaw prepared catalog](https://github.com/openclaw/openclaw/blob/225845acbfe8bed7f155d3113affeeee2fd48fbc/src/agents/prepared-model-catalog.ts)
- [OpenClaw Gateway catalog](https://github.com/openclaw/openclaw/blob/225845acbfe8bed7f155d3113affeeee2fd48fbc/src/gateway/server-model-catalog.ts)
- [官方 pi 插件](https://github.com/router-for-me/pi-cliproxyapi-provider/tree/ffc7cc3fe05b64483651b427e5117ae22dd6aad0)
