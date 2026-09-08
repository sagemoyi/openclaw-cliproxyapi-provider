# OpenClaw CLIProxyAPI Provider

把 CPA endpoint 和凭据交给 OpenClaw，自动发现模型，映射上下文、图像输入和 reasoning 控制，并定期同步目录。独立 provider ID 为 `cliproxyapi`，可与现有 `cpa`、`cpa-responses` 等手动 provider 并存。

已在 **OpenClaw 2026.7.1-2 + CPA v7.2.149** 上验证。实现完全使用公开 SDK，不修改 OpenClaw 核心。

**本机版本的重要限制：** Gateway 的旧 `models.list`/选择器有私有缓存。插件会自动更新磁盘目录和运行时请求，但已缓存的旧选择器在目录变化后需要正常重启 Gateway 才更新。新上游的 prepared catalog 提供了正式刷新接口，本插件包含按 API 探测的适配；该分支做了契约测试和源码核对，尚未在新版 Gateway 上实测。详见 [调研与架构](docs/RESEARCH.md)。

## 安装与配置

在此目录运行：

```bash
openclaw plugins install --link .
openclaw models auth login --provider cliproxyapi --method api-key
openclaw cpa sync
openclaw models list --all --provider cliproxyapi
```

登录只询问 CPA 地址和 API key，并验证能否发现模型。凭据由 OpenClaw 保存为标准 auth profile，模型列表不写进你的主配置。插件会加入 `cliproxyapi/*` 可选模型范围；不改变当前默认模型。

如果已有 `plugins.allow`，把 `cliproxyapi` **追加**进去，不要覆盖原来的列表。安装提示插件未获允许时先完成这一步，再登录。

选一个实际发现到的模型，并让运行中的 Gateway 加载插件：

```bash
openclaw models set cliproxyapi/gpt-5.6-luna
openclaw gateway restart
```

上面模型只是本机实测示例，请使用自己的目录中存在的 ID。已有 provider 和默认模型不会因为安装被迁移或删除。

### 配置文件方式

也可将以下片段合并进已有配置，API key 使用环境变量或 OpenClaw 原有 SecretRef/auth profile 机制：

```json
{
  "models": {
    "providers": {
      "cliproxyapi": {
        "baseUrl": "http://127.0.0.1:18317/v1",
        "apiKey": "${CPA_API_KEY}",
        "models": []
      }
    }
  },
  "agents": {
    "defaults": {
      "models": { "cliproxyapi/*": {} }
    }
  },
  "plugins": {
    "entries": { "cliproxyapi": { "enabled": true } }
  }
}
```

`18317` 是本机 CPA 的端口，CPA 常见默认端口为 `8317`。确保启动 Gateway 的服务环境能读取 `CPA_API_KEY`；只在当前 shell 中 export 不一定会传给 systemd。使用 auth profile 可避免这个问题。`baseUrl` 支持根地址、已有 `/v1`、反向代理路径前缀；不支持在 URL 中夹带密钥或 query。

`models: []` 是有意保留为空，自动目录由插件生成。不要为图方便强制配置 provider 级 `api`：默认会为 OpenAI 归属模型使用 Responses，为其他模型使用 Chat Completions。特殊部署可用标准 provider/model 的 `api` 字段覆盖。

## 日常使用与同步

```bash
openclaw cpa catalog   # 实时诊断：模型能力、来源、告警；不输出凭据
openclaw cpa sync      # 立即刷新 OpenClaw 生成目录，不修改 openclaw.json
openclaw models list --all --provider cliproxyapi
```

Gateway 后台默认每 60 秒检查 CPA；同步成功后新增、删除和能力变化以完整快照替换。请求前也会检查缓存，拒绝调用已经从 CPA 目录移除的模型。旧会话选择了新模型不支持的 reasoning 档位时，会降到支持的较低档位或该模型默认档位。

本机 July 版的旧选择器若仍显示旧目录，运行 `openclaw gateway restart`。插件不会自行重启正在服务的 Gateway，也不会通过不断改写配置来强迫重载。已经发送到上游的请求不在中途切换能力；旧会话的上下文/压缩预算不保证在当前 turn 内重算。

网络/5xx 故障最多沿用 TTL 之后 300 秒的进程内成功快照；401/403 立即废弃缓存，认证失败不能退回旧目录。成功的空列表表示确实没有可用模型，不会当成网络失败恢复旧列表。CPA 可能因账号状态、配额耗尽暂时隐藏模型，这些也视为当前不可用。

高级可选配置：

```json
{
  "plugins": {
    "entries": {
      "cliproxyapi": {
        "enabled": true,
        "config": {
          "refreshSeconds": 60,
          "staleSeconds": 300,
          "timeoutMs": 10000,
          "useBundledMetadata": true
        }
      }
    }
  }
}
```

## 能力处理与明确限制

- 可用性只来自你的 CPA `/v1/models`；不会把上游静态表中未开放的模型加进来。
- 丰富 metadata 来自 `/v1/models?client_version=`。只读取能力字段，不使用目录里的 Codex 指令、工具定义、shell 或 agent 配置。
- `context_window` 用作当前上下文；`max_context_window` 仅保留作诊断，不擅自启用更大的窗口。输出预算取 `max_tokens`。缺失时用准确 ID 匹配的 CPA 后备表，再缺失则使用保守的 32K/4K。
- CPA 会把模板 reasoning 继承给部分没有可调 reasoning 的模型。插件用随包 CPA 原生表修正已知情况，也补足 Codex 投影丢失的预算型 thinking。这里的 `reasoning: false` 指不宣告可调思考控制，不是证明模型内部完全不推理。
- 后备表按精确 ID 匹配，不剥离前缀或猜测任意 alias 的真实底层模型；没有 provenance 的自定义模型仍可能带 CPA 的模板默认值，诊断会提示。表随插件维护，不会在运行时把凭据发到第三方。若 CPA 已有更新的定义而与表冲突，可关闭 `useBundledMetadata` 或使用标准 model override。
- 图像/视频生成模型不作为聊天模型注册；本插件提供文本/图像输入的 LLM provider，不提供图片生成工具。未知或旧 CPA 缺失类型信息时不能保证分类完备。
- CPA 未提供计价；成本填 0 代表未知占位，**不代表免费**。可用标准 model cost override。
- 常规 `low/medium/high/xhigh/max` 按每个模型的实际列表暴露；`none` 映射到 `off`，预算型动态控制映射到 `adaptive`。不支持关闭思考的模型不会宣告 `off`。
- **`ultra` 不作为正常 `/think` 选项宣告。** 本机 OpenClaw 会把它转换为 `max` 并启用自己的编排语义；而 CPA v7.2.149 给 GPT Sol 宣告了 ultra，实际请求却返回 400，只接受到 max。`cpa catalog` 会保留原始声明并告警。如你已验证自己的 CPA 确实接受某个原生 effort，可在标准模型参数中设置 `cpaReasoningEffort` 做显式透传；不会自动替你尝试或重发失败请求。
- July 兼容路径主要物化默认 agent 的目录；其他 agent 仍走 OpenClaw 原有发现和请求前检查。没有声称能热替换所有已存在的 agent/会话快照。

例如，已确认端点接受某原生档位时的高级透传：

```json
{
  "agents": {
    "defaults": {
      "models": {
        "cliproxyapi/your-model": {
          "params": { "cpaReasoningEffort": "max" }
        }
      }
    }
  }
}
```

## 开发与验证

纯逻辑测试没有第三方依赖：

```bash
npm test
npm run check
```

宿主集成测试需要 `openclaw` 可执行文件以及可解析的 `openclaw` peer SDK；不要把机器上的全局路径写进插件代码。开发时可安装匹配的 peer，或将 `node_modules/openclaw` 链接到本机安装位置。

```bash
node --test test/host.integration.js
node --test test/gateway.integration.js
```

这些测试创建 `/tmp/cpa-*-test-*` 隔离状态，停止自己启动的 Gateway，不修改你的实际配置；测试产物保留便于复查。

真实请求测试（会消耗模型额度）：

```bash
CPA_BASE_URL=http://127.0.0.1:8317/v1 CPA_API_KEY=... node test/live.mjs
```

可通过 `CPA_LIVE_CASES` JSON 数组指定实际可用的模型和档位。实测结果见 [测试记录](docs/TESTING.md)。

后备 metadata 的维护：

```bash
node scripts/update-metadata.mjs <CPA完整commit SHA>
npm test
```

更新工具只下载固定 commit 的数据，机械提取字段；维护者需要审查 diff、模型分类和新的 thinking 规则。许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
