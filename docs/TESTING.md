# 测试与开发指南

[English](DEVELOPMENT.md) | 简体中文

测试分为纯逻辑、宿主集成和真实端点三层。默认测试不需要 CPA 凭据，也不会调用付费模型。

## 开发环境

使用满足项目及宿主要求的 Node.js 版本。在项目根目录执行：

```bash
npm test
npm run check
```

纯逻辑测试使用 Node.js 内置测试运行器，无需额外依赖。宿主集成测试还需要：

- PATH 中可用的 `openclaw` 命令。
- 项目可以解析的 `openclaw` peer SDK。
- 可创建临时目录、启动子进程并监听回环地址的环境。

CLI 和 peer SDK 应使用相同版本。可通过 npm 安装指定的开发测试版本：

```bash
npm install --no-save --package-lock=false openclaw@2026.7.1-2
```

不要将全局安装目录、个人凭据或部署配置写入源码和测试夹具。

## 测试命令

| 命令 | 范围 | 是否需要 CPA 凭据 |
| --- | --- | --- |
| `npm test` | 纯逻辑与 SDK 调用契约 | 否 |
| `npm run check` | 插件入口和运行时模块语法 | 否 |
| `npm run test:host` | 真实 OpenClaw SDK、HTTP/SSE 和 CLI | 否 |
| `npm run test:gateway` | 隔离 Gateway 的自动目录同步 | 否 |
| `npm run test:live` | 指定 CPA 端点的真实模型请求 | 是，会消耗额度 |

当前自动化基线包含 37 项纯逻辑／契约测试、2 项宿主集成测试和 1 项 Gateway 测试。测试数量不代表模型覆盖率，应以各测试的断言为准。

## 纯逻辑与契约测试

覆盖以下行为：

- URL 规范化、反向代理前缀和凭据 URL 拒绝。
- 普通／丰富目录、顶层数组、slug/id 和混合 reasoning 格式。
- 上下文与输出限制、输入模态、隐藏模型、精确 ID 后备数据。
- 稀疏 reasoning、none/auto、max/ultra、非 reasoning 与预算型 thinking。
- 模型新增、删除、空目录及能力变化。
- TTL、并发获取合并、短退避、有界 stale 和凭据隔离。
- 混合 5xx 与 401/403 场景中的认证失效优先级。
- 请求 payload 回调组合和显式模型覆盖。
- 发布完整性、删除残留校验、失败重试及配置指纹。
- 并发发布顺序、服务启动／停止和过期定时器回调。

`test/official-review.test.js` 保留与官方 pi 插件设计对照后补充的格式和生命周期回归。

## 宿主集成测试

```bash
npm run test:host
npm run test:gateway
```

测试启动可控的模拟 CPA 服务，使用测试凭据和操作系统分配的临时状态目录。OpenClaw 的配置与状态通过专用环境变量指向该目录，测试结束关闭其创建的服务器和 Gateway 进程。

测试目录会保留，便于检查目录文件和日志。路径由测试输出提供；清理时只删除确认属于该次测试的目录。

### SDK 与 CLI

`test/host.integration.js` 验证：

- 官方目录 fetch 与流式传输确实发出 HTTP/SSE 请求。
- high、max、显式 ultra、off 和 adaptive 到最终请求参数的映射。
- 目录从 reasoning 切换为非 reasoning 后，后续请求不再发送 effort。
- 工具 schema 和流式结果保持有效。
- 实际安装、加载插件，并通过 CLI 发现和同步模型。
- 目录从 a/b 更新为 b/c，已删除模型不再出现在生成列表中。
- 同步不会修改主配置。

### Gateway 生命周期

`test/gateway.integration.js` 验证后台服务自动发布模型新增、删除、上下文变化及空目录，并检查 legacy Gateway 选择器缓存的重启行为。

该测试面向已验证的 legacy 宿主路径。新版 prepared catalog 的契约测试不能替代新版 Gateway 端到端测试；升级兼容基线时应补充对应验证。

## 真实端点测试

真实测试是显式选择的操作，会向 CPA 发出推理请求并可能产生费用。请使用测试账号和已确认可用的模型。

通过安全的环境注入方式提供 `CPA_API_KEY`，再设置端点和测试用例：

```bash
export CPA_BASE_URL='https://cpa.example.com/v1'
export CPA_LIVE_CASES='[{"id":"MODEL_ID","level":"high"}]'
npm run test:live
```

将 `MODEL_ID` 替换为实际目录中的模型。不要把真实密钥写入文档、脚本、shell 历史或问题报告。建议始终显式设置 `CPA_LIVE_CASES`，避免依赖脚本中的示例模型。

每个用例接受：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | 是 | CPA 返回的精确模型 ID |
| `level` | 建议 | OpenClaw thinking 档位，如 off、low、high、max、adaptive |
| `exact` | 否 | 显式 CPA reasoning effort，须已确认端点支持 |

脚本检查模型是否被发现、调用是否失败，并输出协议、实际 effort、停止原因和用量，不输出认证凭据或原始上游错误体。

建议选择多个能力不同的模型：非 reasoning、允许 none、稀疏档位、max 以及预算型 thinking。负面用例应单独运行；目录宣告但验证器拒绝的 effort 应记作兼容性问题，而非成功覆盖。

自动化测试不主动修改 CPA 账号、配额或模型路由。目录变化使用模拟服务复现。

## 更新后备元数据

`data/cpa-models.json` 是固定 CPA revision 的精简快照。更新时使用完整提交 SHA：

```bash
node scripts/update-metadata.mjs CPA_COMMIT_SHA
git diff -- data/cpa-models.json
npm test
```

更新脚本只执行机械提取。维护者仍需审查：

- 来源 revision、许可证和字段变化。
- 同一 ID 在不同模型定义中的冲突。
- 媒体模型分类、reasoning 预算范围和离散档位。
- 新数据是否与实时目录产生冲突。

不要将快照中的全部模型视为端点可用模型，也不要为未知 alias 添加未经证实的能力映射。

## 提交前检查

```bash
git diff --check
npm test
npm run check
npm run test:host
npm run test:gateway
npm pack --dry-run
```

涉及宿主适配或传输修改时运行集成测试；需要确认服务端行为时再显式运行真实端点测试。发布前检查包中包含运行时模块、manifest、元数据和许可证，不包含凭据、测试状态或 node_modules。

## 验证边界与问题报告

当前测试不证明所有 CPA 模型、最大上下文、多 agent 会话或所有 OpenClaw 版本都受支持。尤其需要区分：

- 元数据映射正确与上游实际接受参数。
- 生成目录已更新与 Gateway 选择器缓存已刷新。
- API 契约成立与完整宿主生命周期已验证。
- 短请求成功与最大上下文压力测试通过。

报告问题时请附上插件、OpenClaw、Node.js 和 CPA 版本，最小配置、复现命令，以及脱敏后的相关模型能力和日志。提交诊断前检查端点域名、私有模型名称、密钥和请求内容，避免泄露部署信息。
