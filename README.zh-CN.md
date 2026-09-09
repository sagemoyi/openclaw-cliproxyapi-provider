# OpenClaw CLIProxyAPI Provider

[English](README.md) | 简体中文

为 [OpenClaw](https://github.com/openclaw/openclaw) 提供 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA）动态模型发现。配置端点和凭据后，插件自动加载可用模型、解析模型能力，并同步到 OpenClaw 的模型目录。

插件 ID：`openclaw-cliproxyapi-provider`。模型 provider ID：`cliproxyapi`。使用 OpenClaw 公共插件 SDK，无需修改 OpenClaw 或 CPA 核心。

## 功能

- 通过交互式登录配置 CPA 地址和 API key。
- 自动发现模型，读取上下文长度、输出限制、输入模态和 reasoning 档位。
- 定期同步模型新增、删除及能力变化，提供手动刷新命令。
- 按模型提供 OpenClaw thinking 选项，适配请求中的 reasoning 参数。
- 复用 OpenClaw 的认证、请求传输和目录持久化机制。
- 支持标准 provider/model 配置覆盖，可与已有静态 provider 并存。

## 要求

- Node.js 22.16.0 或更高版本，同时满足所使用 OpenClaw 版本的运行要求。
- OpenClaw 2026.7.1-2 或更高版本；SDK 兼容范围和验证边界见 [架构与兼容性](docs/RESEARCH.md)，跨版本反馈复核见 [issue #1 测试记录](docs/COMPATIBILITY.zh-CN.md)。
- 一个可访问的 CPA HTTP(S) 端点，以及具有模型访问权限的 API key。无需管理密钥。

旧版 OpenClaw 的 Gateway 模型选择器可能保留目录缓存。插件可更新生成目录和请求时的能力信息，但选择器可能需要重启 Gateway 才能显示变化。详见 [故障排查](#故障排查)。

## 安装

当前源码面向 **0.2.0（尚未发布）**，使用新插件 ID。已发布的 **0.1.2** 仍使用 `cliproxyapi`；旧安装切换到当前源码前，请先阅读 [ID 迁移说明](docs/PLUGIN_ID_MIGRATION.zh-CN.md)。

从 ClawHub 安装公开版本：

```bash
openclaw plugins install clawhub:@sagemoyi/openclaw-cliproxyapi-provider
```

请使用支持 `clawhub:` 插件来源的 OpenClaw 版本。安装后按下文完成交互式配置，并重启 Gateway 加载插件。

从源码安装：

```bash
git clone https://github.com/sagemoyi/openclaw-cliproxyapi-provider.git
cd openclaw-cliproxyapi-provider
openclaw plugins install --link .
```

`--link` 使用当前检出目录作为插件来源，请保留该目录。当前安装方式不依赖 npm 发布。

也可以先生成安装包：

```bash
npm pack
openclaw plugins install ./sagemoyi-openclaw-cliproxyapi-provider-0.2.0.tgz
```

如果启用了 `plugins.allow`，请将 `openclaw-cliproxyapi-provider` 加入现有列表，不要替换其他已允许的插件。

## 升级

以下命令适用于已安装新 ID 的版本。0.1.2 及更早版本使用 `openclaw plugins update cliproxyapi`，切换到 0.2.0 需要 [一次性迁移](docs/PLUGIN_ID_MIGRATION.zh-CN.md)。

通过 ClawHub 安装后，使用插件 ID `openclaw-cliproxyapi-provider` 预览升级：

```bash
openclaw plugins update openclaw-cliproxyapi-provider --dry-run
```

确认预览结果后执行升级，并重启 Gateway 加载新版本：

```bash
openclaw plugins update openclaw-cliproxyapi-provider
openclaw gateway restart
```

`plugins update` 的参数是已安装的插件 ID。安装时使用的包名是 `@sagemoyi/openclaw-cliproxyapi-provider`，展示名是 **OpenClaw CLIProxyAPI Provider**；升级时使用 `openclaw-cliproxyapi-provider`。如果提示找不到插件，运行 `openclaw plugins list`，并确认当前命令使用的是安装该插件的配置和状态目录。

升级命令使用记录的安装来源。通过 `--link` 安装的源码版本应更新对应检出目录，再重启 Gateway；通过本地 `.tgz` 安装的版本应安装新的包文件。

## 交互式配置（推荐）

```bash
openclaw models auth login --provider cliproxyapi --method api-key
```

如果配置了多个 agent，OpenClaw 可能提示 `Multiple agents are configured, but the model command has no explicit owner. Pass --agent <id>.`。先查看 agent ID：

```bash
openclaw agents list
```

然后指定本次认证所属的 agent，将 `AGENT_ID` 替换为列表中的实际 ID：

```bash
openclaw models auth login --agent AGENT_ID --provider cliproxyapi --method api-key
```

后续查看该 agent 的模型时，可使用 `openclaw models list --agent AGENT_ID --all --provider cliproxyapi`。

按提示输入：

1. CPA 端点，例如 `https://cpa.example.com/v1`。
2. CPA API key。

登录会查询模型目录以验证连接。合法的空目录也允许完成配置；网络错误、认证失败或无效响应会使配置失败。

成功后，凭据保存到 OpenClaw 标准 auth profile，端点写入 provider 配置，并加入 `cliproxyapi/*` 可选模型范围。自动发现的完整模型列表不会写入主配置，当前默认模型不会自动切换。

刷新并查看模型：

```bash
openclaw cpa sync
openclaw models list --all --provider cliproxyapi
```

从列表中选择一个模型，将下面的 `MODEL_ID` 替换为实际 ID：

```bash
openclaw models set cliproxyapi/MODEL_ID
openclaw gateway restart
```

重新运行登录命令可以更新连接信息。若同时配置了显式 API key 或环境变量，请一并检查，凭据选择遵循 OpenClaw 自身的认证规则。

## 非交互式配置

将以下内容合并到 OpenClaw 配置，保留已有 provider、插件和 agent 设置：

```json
{
  "models": {
    "providers": {
      "cliproxyapi": {
        "baseUrl": "https://cpa.example.com/v1",
        "apiKey": "${CPA_API_KEY}",
        "models": []
      }
    }
  },
  "agents": {
    "defaults": {
      "models": {
        "cliproxyapi/*": {}
      }
    }
  },
  "plugins": {
    "entries": {
      "openclaw-cliproxyapi-provider": {
        "enabled": true
      }
    }
  }
}
```

`CPA_API_KEY` 必须在运行 OpenClaw 的进程环境中可用。交互式 shell 的环境变量不一定会传递到 systemd、容器或其他服务管理器。也可使用 OpenClaw 支持的 SecretRef 或 auth profile。

`models: []` 用于启用动态目录，不需要手工填写每个模型。仅在需要覆盖能力或协议时添加显式模型配置。

### 端点格式

端点必须包含 `http://` 或 `https://`。远程连接建议使用 HTTPS。

| 输入 | 规范化后的 API 根地址 |
| --- | --- |
| `https://cpa.example.com` | `https://cpa.example.com/v1` |
| `https://cpa.example.com/v1/` | `https://cpa.example.com/v1` |
| `https://proxy.example.com/cpa` | `https://proxy.example.com/cpa/v1` |

支持反向代理路径前缀。不支持在 URL 中嵌入用户名、密码、查询参数或 fragment。请使用 CPA 的 OpenAI-compatible API 根地址，而不是 pi 插件使用的 `/backend-api` 地址。

## 命令

| 命令 | 用途 |
| --- | --- |
| `openclaw cpa catalog` | 查询模型能力、元数据来源和诊断信息，不输出认证凭据或端点地址 |
| `openclaw cpa sync` | 请求刷新并发布目录，返回同步结果；不修改主配置 |
| `openclaw models list --all --provider cliproxyapi` | 查看 OpenClaw 目录中的 CPA 模型 |

目录查询或同步失败时，先检查命令输出和 Gateway 日志。瞬时故障可能返回带 `stale` 标志的历史快照；同步命令不会将该快照作为新目录发布。

## 刷新与缓存

Gateway 服务启动时执行发现，之后默认每次同步结束后等待 60 秒再检查。请求前也会读取或刷新目录缓存。

| 设置 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- |
| `refreshSeconds` | `60` | 10–86400 | 目录缓存 TTL 和后台刷新间隔，单位秒 |
| `staleSeconds` | `300` | 0–86400 | TTL 之后允许临时沿用成功快照的时长，单位秒 |
| `timeoutMs` | `10000` | 100–60000 | 每个目录请求的超时，单位毫秒 |
| `useBundledMetadata` | `true` | 布尔值 | 使用随包 CPA 元数据补充或修正已知能力 |

配置位置：

```json
{
  "plugins": {
    "entries": {
      "openclaw-cliproxyapi-provider": {
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

缓存按端点和凭据隔离，仅保存在进程内；生成目录由 OpenClaw 持久化。同步操作串行执行，模型目录、端点或配置变化都会触发重新发布。

### 失败行为

- **未配置端点或凭据**：不发现模型，不发起模型目录网络请求。
- **网络、服务端或响应格式错误**：在限定时间内允许读取旧快照；超过时限后返回错误。
- **401/403**：立即废弃对应缓存，不回退到旧快照。
- **成功的空目录**：按空目录处理，不恢复之前的模型。
- **模型被移除**：目录更新后，请求前检查会拒绝继续调用该模型。缓存有效期内可能仍使用旧目录。
- **发布不完整或残留已删除模型**：报告失败并在后续同步重试；显式用户模型配置不被视为意外残留。

账号状态或配额变化可能使 CPA 暂时隐藏模型，插件将其视为目录可用性变化。插件不会管理 CPA 账号、重启 Gateway，或重试已经失败的模型推理请求。

## 模型能力与 reasoning

可用模型以 CPA 普通目录为准；丰富目录提供能力信息，随包元数据只作补充，不会增加端点未开放的模型。

| 能力 | 处理方式 |
| --- | --- |
| 上下文长度 | 使用 `context_window`；缺失时使用精确 ID 后备数据，再回退到 32768 |
| 输出限制 | 使用 `max_tokens`；缺失时使用后备数据，再回退到 4096；不超过上下文长度 |
| 输入模态 | 注册 text/image 输入能力 |
| Reasoning | 解析字符串或对象形式的档位，生成 OpenClaw thinking profile |
| 隐藏模型 | 排除 `visibility: hide` 和已知图像／视频生成模型 |
| 成本 | 默认 0 代表未知，不代表免费；可使用标准 cost 配置覆盖 |

`max_context_window` 仅保留作诊断，不自动启用更大的上下文。未知 alias 不按名称猜测其底层模型；元数据不完整时使用保守值并输出告警。

常规 reasoning 档位根据模型声明提供。`none` 对应 OpenClaw 的 `off`，`auto` 对应 `adaptive`。不支持关闭思考的模型不会宣告 `off`。已有会话的档位不再受支持时，请求适配会选用支持的较低档位或默认档位。

`ultra` 不作为常规 thinking 选项提供：部分 OpenClaw 版本赋予它独立的编排语义，部分 CPA 版本的目录声明与请求验证也可能不一致。需要精确透传且已确认端点支持时，可使用：

```json
{
  "agents": {
    "defaults": {
      "models": {
        "cliproxyapi/MODEL_ID": {
          "params": {
            "cpaReasoningEffort": "max"
          }
        }
      }
    }
  }
}
```

显式 effort 必须出现在该模型的能力声明中，但声明本身不保证上游一定接受。插件不会通过试发请求探测真实支持范围。

默认根据模型归属及已知类型选择 OpenAI Responses 或 Chat Completions。特殊端点可以使用标准 provider/model 的 `api` 字段覆盖；不建议无条件将整个 provider 固定为一种协议。

## 从静态 provider 迁移

1. 保留原配置，安装并配置本插件。
2. 使用 `cpa catalog` 和 `models list` 检查模型及能力。
3. 将需要迁移的默认模型或 agent 模型引用改为 `cliproxyapi/MODEL_ID`。
4. 验证调用后，再移除不再需要的旧配置。

插件不自动删除旧 provider 或重写会话。已有会话的上下文和压缩预算不保证在当前 turn 内重新计算。

## 故障排查

### 能发现模型，但选择器中没有显示

支持 `agents.defaults.modelPolicy.allow` 的 OpenClaw 版本会优先使用这份显式策略，而非旧字段 `agents.defaults.models`。从 0.1.1 起，登录也会将 `cliproxyapi/*` 合并到已有的默认策略，保留原有条目。从 0.1.0 升级后，请为目标 agent 重新运行登录，或将 `cliproxyapi/*` 合并到现有策略。如果 agent 自己设置了 `modelPolicy.allow`，该策略优先级更高，也需要允许 CPA 模型。反复重启 Gateway 不会改变模型可见性策略。

### sync 已输出成功，但进程不退出

在 OpenClaw `2026.8.1` / `2026.8.2` 上已复现 prepared 目录发布完成后宿主工作线程仍保持进程存活。需要正常退出的一次性同步命令时，建议使用已验证的 `2026.9.3`。详见 [兼容性复核](docs/COMPATIBILITY.zh-CN.md)。必须保留这两个旧版宿主时，可参考独立的 [宿主补丁与回滚说明](https://github.com/sagemoyi/openclaw-cliproxyapi-provider/tree/main/patches/openclaw)；插件升级不会自动应用该补丁。

### 找不到 provider 或登录入口

检查 `openclaw plugins list` 中插件是否已加载，并确认 `plugins.allow` 包含 `openclaw-cliproxyapi-provider`。安装或更新后，运行中的 Gateway 需要加载新插件代码。

如果登录在出现输入提示之前报告 CLI 与已安装 Gateway 使用不同的状态目录或配置路径，这是宿主拒绝向不一致的存储写入。请确认当前命令的状态目录和配置路径是否属于目标 Gateway；隔离测试应使用专用测试配置。不要把这类错误归为 CPA 密钥无效。

### 目录查询成功，但选择器仍显示旧模型

先运行 `openclaw cpa sync` 并检查结果。使用旧目录缓存实现的 OpenClaw 版本可能需要：

```bash
openclaw gateway restart
```

刷新接口的存在不代表所有版本、agent 和会话都支持无重启热更新。

### 认证失败或无法连接

确认地址包含协议、反向代理转发了模型接口，并检查 Gateway 的凭据来源和服务环境。不要将密钥放进 URL、问题报告或公开日志。

### Reasoning 或上下文与预期不符

查看 `cpa catalog` 的模型来源和告警。CPA 的丰富目录可能包含模板默认值，随包数据也可能落后于服务端。可更新插件、使用标准模型覆盖，或关闭 `useBundledMetadata` 后对照检查。

## 开发

参见 [测试与开发指南](docs/TESTING.md) 和 [架构与兼容性](docs/RESEARCH.md)。

## 相关项目与许可

模型发现和刷新设计参考了官方 [pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider)。本项目是独立的 OpenClaw 适配，不是官方 pi 插件的 fork，也不提供其 TUI、Fast、暂停或压缩功能。

本项目采用 [MIT License](LICENSE)。随包 CPA 元数据的来源及许可证见 [第三方声明](THIRD_PARTY_NOTICES.md)。
