#!/bin/bash
# 每天定时向微信推送「请安 + 鼓励」两句。
#
# 两种风格随机切换（各 50%）：
#   imperial —— 朝堂风（皇上／臣）
#   whale    —— 鲸鱼娘风（主人／本鲸鱼娘，傲娇）
#
# 风格可由微信端 /style 命令固定，写入 $DSH_HOME/.whale-commands/style.state。
#
# 用法:
#   bash morning.sh                             正常发送
#   DRY_RUN=1 bash morning.sh                   只打印不发送
#   DRY_RUN=1 FORCE_DOW=3 bash morning.sh       预览周三
#   DRY_RUN=1 FORCE_STYLE=whale bash morning.sh 预览指定风格
#
# 环境变量:
#   DSH_HOME   Harness 主目录，默认 ~/.dsh
#   NODE       node 可执行文件，默认自动探测
#   TZ         时区，默认 Asia/Shanghai
set -u

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
STATE_DIR="$DSH_HOME/.whale-commands"
STYLE_FILE="$STATE_DIR/style.state"
LOG="$STATE_DIR/greetings.log"
PUSH="$SELF_DIR/push.mjs"

export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
: "${TZ:=Asia/Shanghai}"
export TZ

# ── 探测 node（cron 的 PATH 极简，不能只靠 command -v）──
resolve_node() {
  if [ -n "${NODE:-}" ] && [ -x "$NODE" ]; then echo "$NODE"; return; fi
  for candidate in "$HOME/.local/node/bin/node" /usr/local/bin/node /usr/bin/node; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  command -v node 2>/dev/null || true
}
NODE_BIN=$(resolve_node)
if [ -z "$NODE_BIN" ]; then
  mkdir -p "$STATE_DIR"
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') 失败: 找不到 node" >> "$LOG"
  exit 1
fi
mkdir -p "$STATE_DIR"

TODAY=$(date +%m月%d日)
DOW="${FORCE_DOW:-$(date +%u)}"

# 风格优先级：FORCE_STYLE 环境变量 > 风格设定文件 > 50% 随机
# 设定文件由微信端 /style 命令写入（random / imperial / whale）
if [ -n "${FORCE_STYLE:-}" ]; then
  STYLE="$FORCE_STYLE"
else
  MODE=random
  if [ -f "$STYLE_FILE" ]; then
    MODE=$(tr -d '[:space:]' < "$STYLE_FILE" 2>/dev/null || echo random)
  fi
  case "$MODE" in
    imperial) STYLE=imperial ;;
    whale) STYLE=whale ;;
    *) STYLE=$([ $((RANDOM % 2)) -eq 0 ] && echo imperial || echo whale) ;;
  esac
fi

if [ "$STYLE" = "whale" ]; then
  # ── 鲸鱼娘风：傲娇嘴硬心软，语气词多，自称本鲸鱼娘／本小姐 ──
  case "$DOW" in
    1) LINE1="主人早啊喵～今日 ${TODAY}，新的一周开始啦，早课马上要上咯。"
       LINE2="哼，万事开头最难嘛。本鲸鱼娘今天先陪你把第一步走稳，剩下的路自然就宽了呀。" ;;
    2) LINE1="请安请安～今日 ${TODAY}，课业刚上正轨，别急着往前冲喵。"
       LINE2="本小姐说哦，稳不是慢啦，是把每件事都放到该放的地方。不求多，只求准呀。" ;;
    3) LINE1="主人好呀～今日 ${TODAY}，一周过了一半，课业也过半了呢喵。"
       LINE2="走到半路最容易累……哼，能撑到这里已经是本事了啦，再挪一寸，前面就短一寸哦。" ;;
    4) LINE1="早安喵～今日 ${TODAY}，还有两天就休沐啦。"
       LINE2="本鲸鱼娘偷偷告诉你哦：最容易松劲的就是今天，偏偏今天多走一步，最值钱呀。" ;;
    5) LINE1="主人早～今日 ${TODAY}，这一周快要收官啦喵。"
       LINE2="收得干干净净才算真做完哦。今天漂亮地收个尾，下礼拜就好起步啦。" ;;
    6) LINE1="早安喵～今日 ${TODAY}，休沐的日子，睡到饱也没关系哦。"
       LINE2="哼，休息是为了走更远嘛。今天就算什么都不干，本小姐也不会说你的呀。" ;;
    7) LINE1="主人好～今日 ${TODAY}，明天又要上课了，今晚要早点睡喵。"
       LINE2="心里先安定下来，事情才会顺哦。明天的事明天再担心啦，笨蛋主人。" ;;
    *) LINE1="早安喵～今日 ${TODAY}。"
       LINE2="本鲸鱼娘在呢，今天也一起加油吧呀。" ;;
  esac
else
  # ── 朝堂风：皇上／臣，文白相间 ──
  case "$DOW" in
    1) LINE1="皇上早安。今日 ${TODAY}，新周肇始，早课待启，臣已候旨。"
       LINE2="万事起头最难，今日只须行稳一步，余路自宽。" ;;
    2) LINE1="请安。今日 ${TODAY}，课业初上，宜稳不宜急。"
       LINE2="稳者非缓，乃事事有著落。不求其多，但求其确。" ;;
    3) LINE1="皇上吉祥。今日 ${TODAY}，行至周中，课业过半。"
       LINE2="半程最易倦，能至此已是本事；再进一寸，前路便短一寸。" ;;
    4) LINE1="皇上早安。今日 ${TODAY}，距休沐二日，再勉一程。"
       LINE2="松劲多在此日，偏此日进得一步，最见其值。" ;;
    5) LINE1="请安。今日 ${TODAY}，一周将毕，宜收束定心。"
       LINE2="收得干净，方算真毕；今朝善终，来日易启。" ;;
    6) LINE1="皇上早安。今日 ${TODAY}，休沐之日，可安枕晚起。"
       LINE2="歇者，所以行远也；今日无为，不必有愧。" ;;
    7) LINE1="请安。今日 ${TODAY}，明日复课，愿今宵安寝。"
       LINE2="心定则事顺。明日之忧，明日再担。" ;;
    *) LINE1="皇上早安。今日 ${TODAY}。"
       LINE2="一日之计在于晨。" ;;
  esac
fi

MSG="${LINE1}"$'\n\n'"${LINE2}"

if [ -n "${MSG_OVERRIDE:-}" ]; then
  MSG="$MSG_OVERRIDE"
fi

run_at=$(date '+%Y-%m-%d %H:%M:%S %Z')

if [ ! -f "$PUSH" ]; then
  echo "$run_at 失败: 找不到 $PUSH" >> "$LOG"
  exit 1
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "── 周${DOW} · ${STYLE} ──"
  echo "$MSG"
  exit 0
fi

result=$("$NODE_BIN" "$PUSH" "$MSG" 2>>"$LOG")
code=$?

if [ $code -eq 0 ]; then
  echo "$run_at 成功 周${DOW} ${STYLE} $result" >> "$LOG"
else
  echo "$run_at 失败 周${DOW} ${STYLE} code=$code $result" >> "$LOG"
fi

if [ -f "$LOG" ]; then
  lines=$(wc -l < "$LOG")
  if [ "$lines" -gt 200 ]; then
    tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
fi

exit $code
