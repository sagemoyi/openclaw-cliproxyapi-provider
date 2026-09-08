# 测试记录

日期：2026-09-08。机器：Linux arm64 / Node 24.16.0。宿主：OpenClaw 2026.7.1-2；端点：本机 CPA v7.2.149。

## 自动化覆盖

`npm test`：27 项纯逻辑/契约测试，包含：

- 路径前缀、URL 凭据拒绝、非法/重复目录行；
- 上下文、输出、输入模态和准确 ID 投影，保守回退；
- reasoning true/false、稀疏档位、预算型 Claude、none/auto、max/ultra 区别；
- 目录新增、删除、空列表、能力变化；
- TTL、并发合并、短退避、有界 stale、401/403 立即失效、按凭据和端点隔离；
- payload 回调组合、现有参数保留、非 reasoning 不注入参数；
- 手动 model override 优先；
- 旧 catalog view 不修改主配置，新 prepared API 刷新原 owner，发布不完整不误报成功；
- 媒体模型排除、prototype 风格模型 ID、上游 reasoning 数组无序、CPA Sol ultra 矛盾诊断。

`node --test test/host.integration.js`：2 项真实宿主集成测试。

- 使用官方 `fetchLiveProviderModelRows` 访问本地模拟 CPA，经官方 `streamSimple` 真实发 HTTP/SSE；检查 high、max、显式 ultra、none 到最终请求体，工具定义和结果流正常。
- 隔离 OpenClaw 配置加载真实插件、调用注册的 CLI、发现/同步目录。正常 `models list` 显示 a/b；修改端点目录并同步后为 b/c，a 消失；主配置内容不变。

`node --test test/gateway.integration.js`：1 项真实 Gateway 生命周期测试。

- 临时独立 Gateway 启动插件服务，每 10 秒发现；a/b 自动发布为 b/c，64K 更新为 96K；成功的空目录写成空列表。
- 明确复现 July `models.list` RPC 缓存仍为 a/b 的宿主限制。
- 停止并重新启动测试 Gateway，RPC 显示 b/c。
- 测试结束停止自己创建的进程；实际用户 Gateway、CPA 和主配置保持不变。

`npm run check`：JavaScript 语法检查。

## 本机真实模型请求

调用链为插件目录/能力投影 → provider stream wrapper → OpenClaw 官方流式 transport → 本机 CPA。不是仅用 curl 验证接口存在。每次只要求回答 `OK`，输出预算 512；捕获最终发送的 reasoning 参数。

| 模型 | API | 发送 effort | 结果 |
| --- | --- | --- | --- |
| `gpt-5.6-luna` | Responses | `low` | HTTP 200，`OK`，正常 stop |
| `grok-4.3` | Chat Completions | `none`（用户 off） | HTTP 200，`OK`，正常 stop |
| `kimi-k3-256k` | Chat Completions | `high` | HTTP 200，`OK`，正常 stop |
| `gpt-5.6-sol` | Responses | `max` | HTTP 200，`OK`，正常 stop |
| `grok-4.20-0309-non-reasoning` | Chat Completions | 不发送 reasoning 参数 | HTTP 200，`OK`，正常 stop |
| `gpt-5.6-sol` | Responses | `ultra`（显式原生透传） | **HTTP 400**，CPA 自身拒绝，实际允许 low/medium/high/xhigh/max |

最后一项是已定位的端点 metadata/验证器不一致，不能记作成功。其 wire payload 透传已在 mock 与真实请求中观察到；正常 thinking UI 不宣告 ultra。直接向 CPA Responses 接口复查也得到相同错误。

本次普通/丰富目录均返回 33 项；过滤隐藏工具/媒体项后注册 24 个文本模型。这个数值是当时快照，不是插件硬编码列表。后备表包含 77 个精确 ID 与 8 个内置媒体 ID；它不能让 CPA 未开放的模型变成可用。

## 未覆盖/不声称的能力

- 没有逐一消耗额度验证全部 24 个模型；Claude/Gemini 的预算型能力路径用源码 + 受控测试验证，本机没有拿这些模型做真实推理。
- 没有压满 272K 或 1M 上下文测试，也没有把大上下文宣称为实际压力测试通过。
- 没有端到端运行新版 prepared Gateway；该适配只有源码核对与参数契约测试。
- 没有宣称当前 turn 内的压缩预算、所有非默认 agent 目录和所有旧 UI 能同步热替换。
- 没有主动新增/移除用户 CPA 的真实账号或模型；变化场景使用可控本地 CPA 模拟服务器。
