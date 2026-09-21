# AGENTS.md — 插件开发规范（隔离开发流程）

本仓库是 OpenClaw provider 插件（`cliproxyapi`）。开发本插件的机器上可能同时运行着
**生产用途的 OpenClaw Gateway**（默认 profile，端口 18789，状态目录 `~/.openclaw`）。
本规范的目标：插件开发、调试、验证全程**零接触**生产实例，且在任何机器上可复现。

依据官方文档：

- [构建插件](https://docs.openclaw.ai/zh-CN/plugins/building-plugins)
- [多 Gateway 隔离](https://docs.openclaw.ai/gateway/multiple-gateways)
- [plugins install 行为](https://docs.openclaw.ai/cli/plugins/install)：
  **本机有 Gateway 运行时，`plugins install/enable/disable/uninstall` 默认作用于
  运行中的实例** —— 这是本规范存在的根本原因。

## 红线（任何情况下不得违反）

1. **禁止裸跑 `openclaw` 命令**做插件安装/启停/卸载/Gateway 操作。所有手动操作必须
   通过 `scripts/dev.sh`（强制 `--profile dev`）。
2. **生产实例（默认 profile）中的 cliproxyapi 只允许 `clawhub:` / npm 拷贝安装**，
   绝不使用 `--link` 指向开发仓库。
3. **禁止对默认 profile 执行** `plugins install --link`、`plugins disable`、
   `gateway stop/restart` 等任何变更操作。
4. 凭据（CPA key、Gateway token 等）不进仓库、不进文档、不进测试 fixture。

## 架构：双实例隔离

| | 生产（默认 profile） | 开发（`--profile dev`） |
| --- | --- | --- |
| 端口 | 18789 | **19001**（dev profile 固定，见下文说明） |
| 状态目录 | `~/.openclaw` | `~/.openclaw-dev` |
| systemd user 服务 | `openclaw-gateway.service`（常驻） | `openclaw-gateway-dev.service`（**默认停用，按需启动**） |
| 插件来源 | ClawHub 拷贝（只读） | `--link` 指向本仓库（实时） |

关于端口：`dev` 是 OpenClaw 保留的开发 profile，CLI 启动时会为其注入
`OPENCLAW_GATEWAY_PORT=19001`（该值优先于配置文件，因此**不要在 dev 配置里写
`gateway.port`**，写了也无效）。19001 与 18789 间隔 212 > 120，派生的浏览器控制
端口（base+2）与 CDP 端口段（base+11 … base+110）不会冲突，满足官方多 Gateway
隔离清单。`status`/`probe`/`gateway call` 等命令在 `--profile dev` 下自动对准 19001。

## 新机器初始化（异地开发照此复现）

前提：Node.js ≥ 22.16；全局 `openclaw` ≥ 2026.7.1-2（与本机生产同大版本最佳）。

```bash
git clone <repo> && cd openclaw-cliproxyapi-provider
scripts/dev.sh setup      # 初始化 dev profile（baseline 配置 + loopback+token + systemd 服务）
scripts/dev.sh install    # 以 --link 把本仓库装入 dev 实例
# 一次性验证（可选）：start → inspect 确认 "status": "loaded" → stop
scripts/dev.sh start && scripts/dev.sh inspect && scripts/dev.sh stop
```

即使新机器上没有生产实例，也使用同一套流程 —— 保证异地开发行为一致。

## 日常开发循环

```bash
# 1. 改代码
# 2. 纯逻辑与宿主集成验证（全部自带隔离，不需要 dev Gateway 运行）：
npm test && npm run check
npm run test:host && npm run test:gateway   # 各自拉起临时 Gateway 进程
# 3. 需要手动验证运行时行为时，才启动 dev Gateway：
scripts/dev.sh start
scripts/dev.sh restart                 # 改代码后重启加载（--link + ESM 缓存必须重启）
scripts/dev.sh inspect                 # 注册信息（providerIds 等）
scripts/dev.sh call models.list        # RPC 直连 dev Gateway
scripts/dev.sh logs                    # 跟踪日志
# 4. 验证完随手关停，保持平时零占用：
scripts/dev.sh stop
```

运行策略：**dev Gateway 平时不运行**（`dev.sh setup` 安装服务后会禁用开机自启），只在需要手动验证时 `start`，用完 `stop`。自动化测试套件（`npm test`、`test:host`、`test:gateway`）全部自带临时环境，不依赖 dev Gateway 是否在跑。`dev.sh stop` 直接调用 `systemctl --user stop openclaw-gateway-dev.service`——2026.9.3 的 `gateway stop` 误伤护栏不识别 profile，CLI 路径可能拦错目标。
注意：2026.9.3 没有 `plugins reload` 命令；`scripts/dev.sh reload` 是 `gateway restart` 的别名。`pack-verify` 会把安装形态变成 tarball 拷贝，继续开发前需重新 `scripts/dev.sh install && scripts/dev.sh restart` 恢复 link。

`plugins inspect` 中 `trust.reason: "origin-path"` 属正常：本地 link 安装不继承官方
信任（官方文档明确此边界），本插件不依赖受信任状态，无功能影响。

## 分支与发布（自动化）
- **dev 分支**：日常开发与测试。CI（单元 + host/gateway 多版本矩阵）在每次 push / PR 自动运行。
- **main 分支**：发布分支。推送（含合并 dev → main）触发 `.github/workflows/release.yml`：先跑完整 CI 门禁，再发版。**版本号即发布开关**：`package.json` 的 `version` 对应的 tag `v<version>` 已存在则只跑 CI 不发版；要发版，在合并的 PR 里 bump 版本号（semver）。
- **发版动作（全自动）**：创建 tag `v<version>` + GitHub Release（附 npm tarball、自动生成 changelog）→ 调用官方 ClawHub reusable workflow 发布（默认等待安全检查通过，最长 40 分钟）。
- **CLAWHUB_TOKEN**：发布凭据，已存入 GitHub repo secrets。轮换：本机 `clawhub login` 后执行 `clawhub token | gh secret set CLAWHUB_TOKEN`。
- **预览与恢复**：Actions → Release → Run workflow。`dry_run=true`（默认）只做 ClawHub 预览不发布；`dry_run=false` 用于失败后的补发（GitHub Release 已建好但 ClawHub 未发布时）。ClawHub 拒绝重复版本，重复发布会失败属预期护栏。
- **顺序约定**：ClawHub 发布在 GitHub Release 之后；若 ClawHub 成功而后续步骤失败，手工补 `git tag`/`gh release create` 即可，不要改版本号重发。
- （可选加固）GitHub repo 设置里给 main 加分支保护：要求 PR + CI 通过。也可按官方文档升级为 OIDC trusted publishing（`clawhub package trusted-publisher set`），去掉长期 token。
## 发布前验证（合并到 main 前的本地检查）

以下检查与 release pipeline 中的 CI 门禁一致，合并 dev → main 前应在本地跑过：

```bash
git diff --check
npm test && npm run check
npm run test:host && npm run test:gateway
scripts/dev.sh start            # pack-verify 的 inspect --runtime 需要 dev Gateway 在线
scripts/dev.sh pack-verify      # npm pack → npm-pack: 安装 → inspect --runtime --json
scripts/dev.sh install && scripts/dev.sh restart   # 恢复 link 开发形态
scripts/dev.sh stop             # 验证完毕关停
```

- `pack-verify` **不可省略也不能被 `npm pack --dry-run` 替代**：npm-pack 走 OpenClaw
  托管的每插件 npm 项目，能发现源码 checkout 掩盖的依赖错误。官方明确：不要用原始
  路径/归档安装作为最终验证。
- 运行时依赖必须在 `dependencies` / `optionalDependencies`；`devDependencies` 不会
  被托管安装。
- 需要确认真实 CPA 行为时再用 `npm run test:live`（消耗配额，注入 `CPA_API_KEY`，
  见 docs/DEVELOPMENT.md）。

## 版本矩阵

- 最低兼容基线：`2026.7.1-2`（`npm install --no-save --package-lock=false openclaw@2026.7.1-2`
  后跑集成套件）。
- dev 实例跟随本机生产宿主版本（当前 `2026.9.3`），保证开发验证贴近真实环境。
- 关注 [openclaw/openclaw releases](https://github.com/openclaw/openclaw/releases)
  的 beta tag（形如 `v2026.x.N-beta.1`），出现后尽快对 beta 验证 —— 距稳定版通常只有
  几小时。

## 自动化测试的隔离约定（维持不变）

`test/isolated-host-env.js` 在任何 host SDK 加载前注入临时
`OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH` 并清除环境里的 API key/token；
gateway 集成测试使用独立进程 + 系统分配的空闲端口 + mock CPA server。
这些套件**不依赖也不触碰** dev/prod 任何常驻实例，保持这一约定。
