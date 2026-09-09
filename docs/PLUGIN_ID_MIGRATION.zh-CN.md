# 插件 ID 迁移（0.2.0）

0.2.0 将插件 ID 从 `cliproxyapi` 改为 `openclaw-cliproxyapi-provider`。0.1.2 及更早版本使用旧 ID，需要按下文迁移。

| 用途 | 0.1.2 及更早 | 0.2.0 |
| --- | --- | --- |
| 插件 ID、`plugins.entries` 的键、`plugins.allow` 成员 | `cliproxyapi` | `openclaw-cliproxyapi-provider` |
| 安装包名 | `@sagemoyi/openclaw-cliproxyapi-provider` | 不变 |
| 模型 provider、`--provider` 参数 | `cliproxyapi` | 不变 |
| 模型引用、认证 profile | `cliproxyapi/MODEL_ID`、`cliproxyapi:default` | 不变 |

## 为什么需要一次性迁移

OpenClaw 2026.9.3 的社区插件更新流程会校验安装记录中的旧 ID 与新包 manifest ID 一致。直接更新改名包会被拒绝：

```text
plugin id mismatch: expected cliproxyapi, got openclaw-cliproxyapi-provider
```

`legacyPluginIds` 不能绕过这条更新校验。不要只改 `plugins.installs` 的键，也不要同时加载新旧两个插件：它们注册的是同一个模型 provider 和 `cpa` 命令。

## 已有安装

1. 在原来安装插件的同一 OpenClaw 配置、profile 和状态目录下操作。备份实际使用的配置文件和认证状态，保留 `plugins.entries.cliproxyapi` 的完整内容（包括 `enabled` 和 `config`），以及原来的 `plugins.allow`、`plugins.deny`（如有）。不要将含凭据的备份提交到 Git。
2. 先准备好新版本安装源。当前可以在本仓库运行 `npm pack`，得到 `sagemoyi-openclaw-cliproxyapi-provider-0.2.0.tgz`。确认新包 manifest 的 ID 是 `openclaw-cliproxyapi-provider`。如果从 ClawHub 安装，请确认所选版本为 0.2.0 或更高。
3. 停止 Gateway，预览卸载旧插件，再执行卸载：

   ```bash
   openclaw gateway stop
   openclaw plugins uninstall cliproxyapi --dry-run
   openclaw plugins uninstall cliproxyapi
   ```

   卸载会删除旧插件的安装记录、插件设置和相应允许列表项，因此需要第 1 步的备份。
4. 安装新包；按宿主提示确认本地来源所需授权：

   ```bash
   openclaw plugins install ./sagemoyi-openclaw-cliproxyapi-provider-0.2.0.tgz
   ```

   也可以改为从 ClawHub 安装，以便后续使用 `plugins update`：

   ```bash
   openclaw plugins install clawhub:@sagemoyi/openclaw-cliproxyapi-provider
   ```

   源码链接安装则在新的检出目录运行 `openclaw plugins install --link .`。
5. 将备份中的旧插件条目恢复到 `plugins.entries["openclaw-cliproxyapi-provider"]`，保留原来的 `enabled` 和整个 `config`。如果原先设置了允许/拒绝列表，将其中的旧插件 ID 替换成新 ID，并保留其他成员。不要保留旧 `plugins.entries.cliproxyapi`，不要覆盖新安装生成的安装记录，也不要恢复旧 `plugins.load.paths` 中的插件来源。保持 `models.providers.cliproxyapi`、`cliproxyapi/*` 模型策略、默认模型和认证 profile 原样。
6. 验证配置和加载结果，再启动 Gateway：

   ```bash
   openclaw config validate
   openclaw plugins list
   openclaw gateway start
   openclaw models list --all --provider cliproxyapi
   ```

   插件列表应显示新 ID；模型仍以 `cliproxyapi/` 开头。如果插件原本禁用，迁移后继续保留禁用状态。

迁移失败时，保留 Gateway 停止状态，卸载新 ID，重新安装原来的 0.1.2 安装源，并恢复备份中的旧插件配置及列表项。确认旧 ID 加载后再启动 Gateway。

## 后续升级

从 ClawHub 安装新 ID 后：

```bash
openclaw plugins update openclaw-cliproxyapi-provider --dry-run
openclaw plugins update openclaw-cliproxyapi-provider
openclaw gateway restart
```

本地 `.tgz` 安装应安装新包文件；`--link` 安装应更新对应源码目录。这两种来源不会因 ID 改名而自动变成 ClawHub 更新来源。
