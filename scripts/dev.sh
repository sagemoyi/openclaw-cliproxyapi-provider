#!/usr/bin/env bash
# dev.sh — 插件开发隔离包装器
#
# 所有手动 OpenClaw 操作强制走 `--profile dev`（独立的配置、状态目录、
# workspace 和固定端口 19001），绝不触碰默认 profile 的生产 Gateway（18789）。
#
# 规范见仓库根目录 AGENTS.md。新机器首次使用：scripts/dev.sh setup
#
# 用法：
#   scripts/dev.sh setup                  初始化 dev profile（新机器只需一次）
#   scripts/dev.sh install                以 --link 方式把本仓库装入 dev 实例（开发循环）
#   scripts/dev.sh reload                 重载插件（2026.9.3 无 plugins reload，等价于 restart）
#   scripts/dev.sh restart                重启 dev Gateway（reload 不生效时用）
#   scripts/dev.sh inspect                查看插件运行时注册情况（--runtime --json）
#   scripts/dev.sh start|stop|status      按需启停 dev Gateway（默认不运行，测试时才启动）
#   scripts/dev.sh logs                   跟踪 dev Gateway 日志
#   scripts/dev.sh call <method> [args..] 调用 dev Gateway RPC（如 call models.list）
#   scripts/dev.sh pack-verify            发布前验证：npm pack + npm-pack: 安装 + inspect
#   scripts/dev.sh uninstall              从 dev 实例卸载本插件
set -euo pipefail

PROFILE="dev"
PLUGIN_ID="cliproxyapi"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 解析全局 openclaw CLI：跳过仓库内的 node_modules/.bin
# （npm run 会把它放到 PATH 最前，--link 安装时新版主机会报虚假的所有权冲突，
#   与 test/install-host-plugin.js 的 resolveHostCli 同理）
resolve_cli() {
  local dir cand real
  local IFS=':'
  for dir in ${PATH:-}; do
    [ -n "$dir" ] || continue
    cand="$dir/openclaw"
    [ -x "$cand" ] || continue
    real="$(readlink -f "$cand" 2>/dev/null || printf '%s' "$cand")"
    case "$real" in
      "$REPO_ROOT"|"$REPO_ROOT"/*) continue ;;
    esac
    printf '%s' "$cand"
    return 0
  done
  printf 'openclaw'
}

CLI="$(resolve_cli)"

# 所有命令统一注入 --profile dev；禁止调用方再覆盖 profile
oc() {
  for arg in "$@"; do
    case "$arg" in
      --profile|--profile=*|--dev)
        echo "dev.sh: 不允许自定义 profile（$arg），本脚本固定使用 --profile $PROFILE" >&2
        exit 2 ;;
    esac
  done
  "$CLI" --profile "$PROFILE" "$@"
}

need_plugin_linked_hint() {
  echo "hint: 先运行 scripts/dev.sh install 把仓库链接进 dev 实例" >&2
}

consent_flags() {
  # --force 是非交互确认本地来源；新版主机对 link/tarball 安装都要求显式能力同意
  local help
  help="$("$CLI" plugins install --help 2>&1 || true)"
  local extra=(--force)
  case "$help" in *"--accept-capabilities"*) extra+=(--accept-capabilities) ;; esac
  printf '%s\n' "${extra[@]}"
}

cmd_install() {
  # --link 不复制目录，改代码即时作用于 dev 实例（restart 后生效）
  local extra=()
  mapfile -t extra < <(consent_flags)
  oc plugins install --link "${extra[@]}" "$REPO_ROOT"
  echo
  echo "已链接安装到 dev 实例。改代码后运行 scripts/dev.sh restart 生效。"
}

cmd_pack_verify() {
  # 官方发布前验证：tarball 走托管 npm 项目安装，能发现源码 checkout 掩盖的依赖问题
  local dest tgz
  dest="$(mktemp -d)"
  (cd "$REPO_ROOT" && npm pack --pack-destination "$dest" >/dev/null)
  tgz="$(ls "$dest"/*.tgz | head -1)"
  echo "tarball: $tgz"
  local extra=()
  mapfile -t extra < <(consent_flags)
  oc plugins install "npm-pack:$tgz" "${extra[@]}"
  echo
  echo "--- 运行时验证 ---"
  oc plugins inspect "$PLUGIN_ID" --runtime --json
  echo
  echo "注意：pack-verify 后安装形态变为 tarball 拷贝；继续开发请重新 scripts/dev.sh install 恢复 --link。"
}

cmd_setup() {
  echo "初始化 dev profile（config/state/workspace 位于 ~/.openclaw-dev，端口固定 19001）..."
  oc setup --baseline
  # 保证 gateway 配置：loopback + token 认证；端口由 dev profile 固定为 19001，不写入配置
  node - <<'EOF'
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const p = `${os.homedir()}/.openclaw-dev/openclaw.json`;
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
cfg.gateway = cfg.gateway ?? {};
cfg.gateway.mode = cfg.gateway.mode ?? "local";
cfg.gateway.bind = cfg.gateway.bind ?? "loopback";
delete cfg.gateway.port; // dev profile 固定 19001（CLI 启动时注入），显式 port 反而被忽略
if (cfg.gateway.auth?.mode !== "token" || !cfg.gateway.auth?.token) {
  cfg.gateway.auth = { mode: "token", token: crypto.randomBytes(24).toString("hex") };
}
fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
console.log("gateway 配置：", JSON.stringify({ ...cfg.gateway, auth: { mode: "token", token: "<redacted>" } }));
EOF
  echo
  echo "安装 dev Gateway 服务（systemd user，独立于生产的 openclaw-gateway.service）..."
  oc gateway install --force
  systemctl --user disable openclaw-gateway-$PROFILE.service 2>/dev/null || true  # dev 实例不常驻：默认不开机自启，测试时才 start
  echo
  echo "setup 完成（服务已安装但默认不启动、不开机自启）。需要手动验证时：scripts/dev.sh install && scripts/dev.sh start，用完 scripts/dev.sh stop"
}

cmd="${1:-help}"
[ $# -gt 0 ] && shift
case "$cmd" in
  setup)       cmd_setup "$@" ;;
  install)     cmd_install "$@" ;;
  pack-verify) cmd_pack_verify "$@" ;;
  reload)      oc gateway restart "$@" ;;  # 本版本无 plugins reload；--link 代码改动需进程级重启（ESM 模块缓存）
  restart)     oc gateway restart "$@" ;;
  inspect)     oc plugins inspect "$PLUGIN_ID" --runtime --json "$@" ;;
  start)       oc gateway start "$@" ;;
  stop)        systemctl --user stop openclaw-gateway-$PROFILE.service ;;  # 直接走 systemd：gateway stop 的误伤护栏不识别 profile，可能拦错或停错
  status)      oc gateway status "$@" ; echo ; oc plugins list 2>/dev/null | grep -i "$PLUGIN_ID" || need_plugin_linked_hint ;;
  logs)        oc logs --follow "$@" ;;
  call)        oc gateway call "$@" ;;
  run)         oc gateway run "$@" ;;   # 前台调试模式
  uninstall)   oc plugins uninstall "$PLUGIN_ID" "$@" ;;
  help|--help|-h)
    sed -n '2,30p' "${BASH_SOURCE[0]}" ;;
  *)
    echo "dev.sh: 未知命令 '$cmd'（已自动限定 --profile $PROFILE）" >&2
    echo "运行 scripts/dev.sh help 查看用法" >&2
    exit 2 ;;
esac
