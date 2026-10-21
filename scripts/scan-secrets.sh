#!/bin/bash
# 提交前的「密钥 / 本机路径 / 不该进仓的文件」自检。
# 只含通用规则，不写死任何用户名、主机名或业务词 —— 这个脚本本身可以公开。
#
# 用法：
#   ./scripts/scan-secrets.sh            # 扫已跟踪文件 + git 历史
#   ./scripts/scan-secrets.sh --worktree # 只扫工作树（更快）
#
# 有命中则退出码 1。建议装成 pre-commit / pre-push 钩子。
set -u

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "不在 git 仓库里" >&2; exit 2; }

# ── 规则 ──
# 1) 密钥 / 凭据形态
SECRETS='sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[0-9a-f]{32,}|Bearer[[:space:]]+[A-Za-z0-9._-]{24,}'
# 2) 本机绝对路径（只匹配"某个用户的 home"，不写死具体用户名）
ABSPATH='/home/[a-z][a-z0-9_-]*/|/Users/[A-Za-z][A-Za-z0-9_-]*/|[A-Za-z]:\\\\Users\\\\'
# 3) 不该被跟踪的文件名
BADNAME='credential|(^|/)\.env($|\.)|\.pem$|\.key$|\.p12$'

fail=0
ok()  { printf '  ✅ %s\n' "$*"; }
bad() { printf '  ❌ %s\n' "$*"; fail=1; }

show() { printf '%s\n' "$1" | head -20 | sed 's/^/      /'; }

# ── 1. 文件名 ──
badnames=$(git ls-files | grep -nE "$BADNAME" || true)
if [ -n "$badnames" ]; then bad "被跟踪的可疑文件名（凭据/私钥）:"; show "$badnames"; else ok "没有凭据/私钥类文件被跟踪"; fi

# ── 2. 工作树内容 ──
hits_secret=$(git ls-files -z | xargs -0 -r grep -nIE -- "$SECRETS" 2>/dev/null || true)
hits_path=$(git ls-files -z | xargs -0 -r grep -nIE -- "$ABSPATH" 2>/dev/null || true)

if [ -n "$hits_secret" ]; then bad "文件内容里出现密钥形态：" ; show "$hits_secret"; else ok "文件内容无密钥形态"; fi
if [ -n "$hits_path" ]; then bad "文件内容里出现本机绝对路径：" ; show "$hits_path"; else ok "文件内容无本机绝对路径"; fi

# ── 3. git 历史（提交过又删掉的，push 后照样可见）──
if [ "${1:-}" != "--worktree" ]; then
  # 先滤掉 diff 头（commit/index 行里本来就有 40 位 hash，会误报）
  hist=$(git log -p --all 2>/dev/null | grep -vE '^(commit [0-9a-f]{7,40}$|index [0-9a-f]+\.\.[0-9a-f]+)')
  h_secret=$(printf '%s\n' "$hist" | grep -nIE -- "$SECRETS" || true)
  h_path=$(printf '%s\n' "$hist" | grep -nIE -- "$ABSPATH" || true)
  if [ -n "$h_secret" ] || [ -n "$h_path" ]; then
    bad "git 历史里出现过密钥形态或本机绝对路径："
    show "$(printf '%s\n%s\n' "$h_secret" "$h_path" | head -10)"
    printf '      → 历史里的东西删文件也去不掉；要么改写历史，要么先确认它不敏感\n'
  else
    ok "git 历史干净（$(git rev-list --all --count) 个提交）"
  fi
fi

echo
[ "$fail" -eq 0 ] && echo "结论：通过" || echo "结论：有命中，先处理再提交"
exit "$fail"
