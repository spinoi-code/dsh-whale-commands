#!/bin/bash
# dsh-whale-commands 安装脚本
#
# 做五件事：
#   1. 把插件复制到 DSH 的 web profile（热挂载，不需重启 dsh web）
#   2. 在 cordis.patch.yml 追加挂载行，版本号带内容指纹（改代码必重载）
#   3. 安装定时问候脚本到 $DSH_HOME/.whale-commands/greetings/
#   4. 自检（语法 / 依赖解析）
#   5. 提示后续操作
#
# 定时任务本身不自动装（涉及 crontab 权限），用 --with-cron 显式开启。
#
# 用法:
#   ./install.sh                 安装插件 + 问候脚本
#   ./install.sh --with-cron     额外安装每天 7:00 的 crontab
#   DSH_HOME=/path ./install.sh  指定 Harness 主目录
set -eu

WITH_CRON=0
for arg in "$@"; do
  case "$arg" in
    --with-cron) WITH_CRON=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/web"
PLUGIN_DIR="$PROFILE/plugins/whale-commands"
PATCH_FILE="$PROFILE/cordis.patch.yml"
STATE_DIR="$DSH_HOME/.whale-commands"
GREET_DIR="$STATE_DIR/greetings"
PLUGIN_ID="whale-commands"

say() { printf '%s\n' "$*"; }
fail() { printf '❌ %s\n' "$*" >&2; exit 1; }

say "═══ dsh-whale-commands 安装 ═══"
say "Harness 主目录: $DSH_HOME"

[ -d "$PROFILE" ] || fail "找不到 web profile: $PROFILE（先跑一次 dsh web 让它初始化）"

# ── 1. 复制插件 ──
mkdir -p "$PLUGIN_DIR" "$STATE_DIR" "$GREET_DIR"
cp "$SELF_DIR/src/index.mjs"       "$PLUGIN_DIR/index.mjs"
cp "$SELF_DIR/src/impl.mjs"        "$PLUGIN_DIR/impl.mjs"
cp "$SELF_DIR/src/weixin-send.mjs" "$PLUGIN_DIR/weixin-send.mjs"
cp "$SELF_DIR/scripts/sync-version.sh" "$PLUGIN_DIR/sync-version.sh"
chmod +x "$PLUGIN_DIR/sync-version.sh"
say "✅ 插件已复制到 $PLUGIN_DIR"

# ── 2. 语法自检 ──
NODE_BIN="${NODE:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || fail "找不到 node，请先安装 Node.js >= 22"
for f in index.mjs impl.mjs weixin-send.mjs; do
  "$NODE_BIN" --check "$PLUGIN_DIR/$f" || fail "语法检查失败: $f"
done
say "✅ 语法检查通过"

# ── 3. 内容指纹 → 版本号 ──
HASH=$(cat "$PLUGIN_DIR"/*.mjs | sha256sum | cut -c1-8)
VERSION="1.0.0+$HASH"
say "✅ 内容指纹: $HASH → version: $VERSION"

# ── 4. 挂载 ──
touch "$PATCH_FILE"
if grep -q "plugins/whale-commands/index.mjs" "$PATCH_FILE" 2>/dev/null; then
  say "✅ 挂载行已存在，跳过"
else
  cp "$PATCH_FILE" "$STATE_DIR/cordis.patch.yml.bak"
  cat >> "$PATCH_FILE" <<EOF

# dsh-whale-commands: begin
# 微信端扩展命令（/whale /normal /help /time /sessions /load /style /token）。
# 本文件被 Cordis HMR 监听，改完自动生效，无需重启 dsh web。
# version 里的 +hash 是内容指纹：改代码后跑 plugins/whale-commands/sync-version.sh
# 会自动更新它，从而保证一定重载。
- insert:
    - id: $PLUGIN_ID
      name: './plugins/whale-commands/index.mjs'
      config:
        version: '$VERSION'
# dsh-whale-commands: end
EOF
  say "✅ 已追加挂载行（原文件备份在 $STATE_DIR/cordis.patch.yml.bak）"
fi

# ── 5. 问候脚本 ──
cp "$SELF_DIR/greetings/morning.sh" "$GREET_DIR/morning.sh"
cp "$SELF_DIR/greetings/push.mjs"   "$GREET_DIR/push.mjs"
cp "$SELF_DIR/src/weixin-send.mjs"  "$GREET_DIR/weixin-send.mjs"
chmod +x "$GREET_DIR/morning.sh"
say "✅ 问候脚本已安装到 $GREET_DIR"

# ── 6. 可选 crontab ──
CRON_LINE="0 7 * * * /bin/bash $GREET_DIR/morning.sh"
if [ "$WITH_CRON" = "1" ]; then
  if ! command -v crontab >/dev/null 2>&1; then
    say "⚠️  找不到 crontab，跳过定时任务"
  elif crontab -l 2>/dev/null | grep -Fq "$GREET_DIR/morning.sh"; then
    say "✅ crontab 条目已存在，跳过"
  else
    { crontab -l 2>/dev/null || true; echo "$CRON_LINE"; } | crontab - \
      && say "✅ 已安装每天 07:00 的定时任务" \
      || say "⚠️  crontab 写入失败，请手动添加：$CRON_LINE"
  fi
else
  say "ℹ️  未安装定时任务。需要的话：$0 --with-cron"
  say "   或手动加到 crontab：$CRON_LINE"
fi

# ── 7. 依赖解析自检 ──
if ( cd "$PLUGIN_DIR" && "$NODE_BIN" --input-type=module -e 'import { createUserMessage } from "@deepseek-ai/dsh-llm";' >/dev/null 2>&1 ); then
  say "✅ 依赖 @deepseek-ai/dsh-llm 可解析"
else
  say "⚠️  依赖解析失败——插件会降级为「无命令」，但不会导致服务起不来"
fi

say ""
say "═══ 安装完成 ═══"
say ""
say "在微信里发命令（插件由 Cordis HMR 热挂载，通常几秒内生效）："
say "  /help    /whale    /token    /style"
say ""
say "确认挂载：grep 'apply done' $STATE_DIR/plugin.log | tail -1   # 应为 ok=8"
say "改代码后：$PLUGIN_DIR/sync-version.sh"
say "卸载：    $SELF_DIR/uninstall.sh"
