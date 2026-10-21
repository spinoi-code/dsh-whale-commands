#!/bin/bash
# dsh-whale-commands 卸载脚本
#
# 默认卸载：
#   - cordis.patch.yml 里的挂载段（热卸载，不需重启）
#   - 插件目录、问候脚本
#   - 每天 7:00 的 crontab 条目（如果存在）
#
# 状态文件（人设开关、问候风格、日志）默认保留，加 --purge 一并删除。
#
# 用法:
#   ./uninstall.sh
#   ./uninstall.sh --purge
set -eu

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/web"
PLUGIN_DIR="$PROFILE/plugins/whale-commands"
PATCH_FILE="$PROFILE/cordis.patch.yml"
STATE_DIR="$DSH_HOME/.whale-commands"
GREET_DIR="$STATE_DIR/greetings"

say() { printf '%s\n' "$*"; }

say "═══ dsh-whale-commands 卸载 ═══"

# ── 1. 移除挂载段 ──
if [ -f "$PATCH_FILE" ] && grep -q "dsh-whale-commands: begin" "$PATCH_FILE"; then
  cp "$PATCH_FILE" "$STATE_DIR/cordis.patch.yml.bak.uninstall" 2>/dev/null || true
  awk '
    /# dsh-whale-commands: begin/ { skip = 1; next }
    /# dsh-whale-commands: end/   { skip = 0; next }
    !skip { print }
  ' "$PATCH_FILE" > "$PATCH_FILE.tmp"
  mv "$PATCH_FILE.tmp" "$PATCH_FILE"
  say "✅ 已从 cordis.patch.yml 移除挂载段（插件会被热卸载）"
else
  say "ℹ️  cordis.patch.yml 里没有本插件的挂载段"
fi

# ── 2. 删除插件目录 ──
if [ -d "$PLUGIN_DIR" ]; then
  rm -rf "$PLUGIN_DIR"
  say "✅ 已删除插件目录"
fi

# ── 3. 移除 crontab 条目 ──
if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -Fq "$GREET_DIR/morning.sh"; then
  crontab -l 2>/dev/null | grep -Fv "$GREET_DIR/morning.sh" | crontab - \
    && say "✅ 已移除定时任务" \
    || say "⚠️  移除失败，请手动检查 crontab -l"
fi

# ── 4. 问候脚本与状态 ──
[ -d "$GREET_DIR" ] && rm -rf "$GREET_DIR" && say "✅ 已删除问候脚本"

if [ "$PURGE" = "1" ] && [ -d "$STATE_DIR" ]; then
  rm -rf "$STATE_DIR"
  say "✅ 已清除状态与日志"
else
  say "ℹ️  状态文件保留在 $STATE_DIR（加 --purge 可一并删除）"
fi

say ""
say "═══ 卸载完成 ═══"
say "当前会话里已注入的人设只存在于那段对话历史中；想清干净就 /new 开个新会话。"
