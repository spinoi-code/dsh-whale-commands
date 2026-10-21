#!/bin/bash
# 版本同步脚本（B 方案：内容哈希与版本号强绑定）
#
# 解决的问题
#   插件的重载依赖 cordis.patch.yml 里的 config.version —— 一旦改了代码忘了升版本，
#   Cordis 就不会重挂，等于改了不生效（且不会报错）。纯手工计数器不可靠。
#
# 做法
#   把「代码内容哈希」作为语义化版本的 build 元数据写进 config.version：
#
#       version: '1.2.2+a1b2c3d4'
#                └──┬──┘ └────┬───┘
#                 手工语义版本   内容指纹（改一个字节就变）
#
#   因此：改完代码跑一次本脚本，版本号必然变化 → Cordis 必然重挂 → 必然加载新代码。
#   「忘记升版本」这件事从流程上被消除，不再依赖人的记忆。
#
# 用法
#   ./sync-version.sh            同步版本号并输出结果
#   ./sync-version.sh --check    只检查是否已同步（不一致则退出码 1，适合放进 CI / 提交前检查）
#   ./sync-version.sh --bump minor|patch|major
#                                先手升语义版本基线，再同步哈希
#
# 注意
#   语义版本基线（+ 之前的部分）仍需人判断升哪一档：
#     major —— 破坏性变更（配置结构变了、命令被移除）
#     minor —— 新增功能（新命令、新参数）
#     patch —— 修 bug，不改接口
#   哈希只负责「一定重载」，不负责人判断「该叫什么号」。两者分工明确。
set -u

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/web"
PLUGIN_DIR="$PROFILE/plugins/whale-commands"
PATCH_FILE="$PROFILE/cordis.patch.yml"
PLUGIN_ID="whale-commands"

info() { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; }

[ -d "$PLUGIN_DIR" ] || { bad "插件目录不存在: $PLUGIN_DIR"; exit 2; }
[ -f "$PATCH_FILE" ] || { bad "找不到 $PATCH_FILE"; exit 2; }

# ── 当前内容指纹：所有 .mjs 文件的字节流哈希（与文件名无关）──
content_hash() {
  cat "$PLUGIN_DIR"/*.mjs 2>/dev/null | sha256sum | cut -c1-8
}

# ── 从 patch 文件读取当前 version 字符串 ──
current_version() {
  awk -v id="$PLUGIN_ID" '
    $0 ~ ("id: " id) { inblock = 1; next }
    inblock && /version:/ {
      line = $0
      sub(/^[ \t]*version:[ \t]*/, "", line)
      gsub(/^[\047"]|[\047"]$/, "", line)
      print line
      exit
    }
  ' "$PATCH_FILE"
}

# ── 写回 version（只改这一行的引号内内容，保留文件其余格式与注释）──
write_version() {
  local new="$1" old="$2"
  if [ -z "$old" ]; then
    bad "无法读取当前版本号"
    return 1
  fi
  # 用 awk 精确替换：只在 whale-commands 块内、只替换 version 行
  awk -v id="$PLUGIN_ID" -v newver="$new" '
    $0 ~ ("id: " id) { inblock = 1 }
    inblock && /version:/ && !done {
      sub(/version:[ \t]*["\047][^"\047]*["\047]/, "version: " "\047" newver "\047")
      done = 1
    }
    { print }
  ' "$PATCH_FILE" > "$PATCH_FILE.tmp" && mv "$PATCH_FILE.tmp" "$PATCH_FILE"
}

mode="${1:-sync}"
bump="${2:-}"

hash=$(content_hash)
[ -n "$hash" ] || { bad "无法计算内容哈希"; exit 2; }

cur=$(current_version)
[ -n "$cur" ] || { bad "patch 里找不到 $PLUGIN_ID 的 version"; exit 2; }

base="${cur%%+*}"

# 可选：先手升语义版本
if [ "$mode" = "--bump" ] && [ -n "$bump" ]; then
  major=$(printf '%s' "$base" | cut -d. -f1)
  minor=$(printf '%s' "$base" | cut -d. -f2)
  patchv=$(printf '%s' "$base" | cut -d. -f3)
  major=${major:-0}; minor=${minor:-0}; patchv=${patchv:-0}
  case "$bump" in
    major) major=$((major+1)); minor=0; patchv=0 ;;
    minor) minor=$((minor+1)); patchv=0 ;;
    patch) patchv=$((patchv+1)) ;;
    *) bad "未知档位: $bump（可用 major|minor|patch）"; exit 2 ;;
  esac
  base="$major.$minor.$patchv"
fi

want="$base+$hash"

if [ "$mode" = "--check" ]; then
  if [ "$cur" = "$want" ]; then
    ok "版本号与内容一致：$cur"
    exit 0
  fi
  bad "版本号与内容不一致"
  info "    当前: $cur"
  info "    应为: $want"
  info "    处理: ./sync-version.sh"
  exit 1
fi

if [ "$cur" = "$want" ]; then
  ok "已是最新，无需改动：$cur"
  exit 0
fi

write_version "$want" "$cur" || exit 2

# 写完回读确认
after=$(current_version)
if [ "$after" = "$want" ]; then
  ok "版本已同步：$cur → $want"
  info "    内容指纹: $hash"
  info "    Cordis 会自动重挂；确认注册结果："
  info "      grep 'apply done' $DSH_HOME/.playground/whale-plugin.log | tail -1"
  info "    （应为 ok=8）"
else
  bad "写入失败，回读到 $after"
  exit 2
fi
