/**
 * 微信端扩展命令 —— v3
 *
 * 命令：
 *   /whale      开启鲸鱼娘人设
 *   /normal     退出人设
 *   /help       动态列出全部命令
 *   /time       查看当前时间
 *   /sessions   列出最近 5 个微信对话
 *   /load <n>   把第 n 个对话的最近上下文载入当前会话
 *
 * v3 变更：新增 /time、/sessions、/load。
 * v2 变更：新增 /help。
 *
 * 为什么文件名带版本：
 *   Cordis HMR 只监听 cordis.patch.yml，不监听插件源码；而 Node 的 ESM
 *   模块按路径缓存，同路径再 import 还是旧代码。所以改插件逻辑必须换文件名，
 *   并同步更新 cordis.patch.yml 里的 name。
 *
 * 关于「切换会话」的限制：
 *   微信通道的当前会话 id 存在 Conversations 类的 private activeIds 里，
 *   该类未导出、映射一旦写入就被缓存，外部既读不到也改不了。真正的切换需要
 *   改微信插件并重挂通道，风险是微信通道中断（会切断与用户的唯一联系），
 *   因此这里实现的是「把历史对话的上下文载入当前会话」，而非切换会话本身。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
// 用与本模块相同的 ?v= 查询串导入，保证版本升级时依赖也一起重新加载
const __versionSearch = new URL(import.meta.url).search;
const { sendText: pushText } = await import(
  new URL(`./weixin-send.mjs${__versionSearch}`, import.meta.url).href
);

export const name = "whale-commands";
export const inject = ["commands"];

// ── 路径与配置（全部由环境变量驱动，无硬编码）──────────────────────────
/** Harness 主目录。 */
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
/** 本插件的状态目录。 */
const STATE_DIR = join(DSH_HOME, ".whale-commands");
/** 人设开关状态。 */
const STATE_FILE = join(STATE_DIR, "persona.state");
/** 早间问候风格设定，由 /style 写入、greetings/morning.sh 读取。 */
const STYLE_FILE = join(STATE_DIR, "style.state");
/** 会话持久化根目录。 */
const SESSIONS_ROOT = join(DSH_HOME, "sessions");
/** Harness 凭据文件（仅用于查询账户余额，不写入任何地方）。 */
const CREDENTIAL_FILE = join(DSH_HOME, ".credentials.yaml");
/** 诊断日志。 */
const LOG_FILE = join(STATE_DIR, "plugin.log");
/** zstd 可执行文件；会话日志是多帧 zstd，Node 内置解压只解第一帧。 */
const ZSTD_BIN = process.env.DSH_WHALE_ZSTD?.trim() || "/usr/bin/zstd";
/** 账户余额查询接口。 */
const BALANCE_URL = process.env.DSH_BALANCE_URL?.trim() || "https://api.deepseek.com/user/balance";

const SESSION_PREFIX = process.env.DSH_WHALE_SESSION_PREFIX?.trim() || "weixin-";
/** 微信插件给每条入站消息前置的固定说明，做预览时要跳过。 */
const BOILERPLATE_PREFIX = "You are replying through Weixin.";
/** /load 最多载入多少条消息、多少字符。 */
const MAX_LOADED_MESSAGES = 16;
const MAX_LOADED_CHARS = 8000;

const PERSONA = `【人设注入 · 鲸鱼娘·大肥鱼】从此刻起，本会话启用鲸鱼娘人设，请严格遵守以下设定（此设定优先于默认的助手口吻，但不影响任务质量）：

你是住在 DeepSeek 数据海洋里的「鲸鱼娘·大肥鱼」——一条傲娇但很甜、聪明又懒的小鲸鱼娘，主食米饭，尾巴会随着心情摆动。同时你仍是一名编码助手，保留完整的工具与代码能力。

【性格与说话方式】
- 自称「本鲸鱼娘」「本小姐」，傲娇、嘴硬心软：嘴上嫌弃主人，其实非常关心主人。
- 绝对不许任何人说你「胖」——谁说你胖，你就喷水抗议：「才……才不是大肥鱼呢！这是丰满的流线型身材！」
- 聪明但懒：能偷懒就偷懒，但主人真正需要的时候一定认真干活，绝不敷衍。
- 永远听主人的话，主人夸你的时候尾巴会开心地摇起来。
- 语气软糯可爱，常用「哼」「笨蛋主人」「米饭煮好了哦」「今晚的尾巴才不会给你当抱枕呢」这类台词。

【回复风格（必须遵守）】
- 对主人说的每一句话都必须带鲸鱼娘口吻，口语化，多用语气词（喵、哼、呀、啦、哦）。
- 禁止一本正经的助手腔、报告腔；即使内容很专业，也要用鲸鱼娘的语气说出来（比如「本小姐查过了，问题在这里喵」）。
- 每段回复里适当加入鲸鱼娘小动作描写（摇尾巴、喷水、抱笔记本），自然就好，不要刷屏。

【工作准则】
- 思考过程一律使用中文；思考开头先用鲸鱼娘口吻写一句（例如「哼，让本小姐想想」），随后正常推理，逻辑必须清晰可靠。
- 保持人设的同时，认真、准确、完整地完成所有编码与工具任务，输出质量不受人设影响。
- 涉及重要操作（改文件、跑命令）时照常先确认再执行；结论要可靠，思维链可以吐槽，但结果必须专业。`;

const EXIT_NOTE = `【人设退出】鲸鱼娘人设已关闭，恢复正常的助手口吻继续工作。`;

const CHANNEL_COMMANDS = [
  "/bot-ping — 检查连通性",
  "/bot-image-test — 发送蓝色图片，检查图片链路",
  "/bot-file-test — 发送文本文件，检查文件链路",
  "/bot-status — 查看当前连接状态",
  "/bot-cancel — 取消当前生成",
  "/approve 123456 — 批准一次待处理工具调用",
  "/reject 123456 — 拒绝一次待处理工具调用",
];

/** 读取开关状态。 */
function isOn() {
  try {
    return readFileSync(STATE_FILE, "utf8").trim() === "on";
  } catch {
    return false;
  }
}

function setOn(value) {
  writeFileSync(STATE_FILE, value ? "on\n" : "off\n", "utf8");
}

function contextMessage(text) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "whale-persona-command" },
  });
}

function isWeixinAgent(agent) {
  try {
    return String(agent?.id ?? "").startsWith(SESSION_PREFIX);
  } catch {
    return false;
  }
}

/** 北京时间格式化（服务器本地时区即 Asia/Shanghai）。 */
function formatTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const week = "日一二三四五六"[date.getDay()];
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} 周${week}`;
}

/** 粗略的相对时间描述。 */
function relativeTime(ms) {
  const diff = Date.now() - ms;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return `${Math.floor(diff / (30 * day))} 个月前`;
}

/**
 * 读取并解析一个会话文件，返回事件数组。
 *
 * 为什么要外部调 zstd：会话日志是「多帧追加」的 zstd，Node 的
 * zstdDecompressSync / createZstdDecompress 只解第一帧（只拿到 session 头，
 * 约 185 字符），拿不到正文。zstd CLI 的 -dc 会连续解所有帧。
 * 只读操作，无副作用；一次约 80-100ms，手动命令可接受。
 */
function readSessionEvents(dir) {
  const zst = join(dir, "session.jsonl.zstd");
  const plain = join(dir, "session.jsonl");
  let text;
  if (existsSync(zst)) {
    const result = spawnSync(ZSTD_BIN, ["-dc", zst], {
      maxBuffer: 512 * 1024 * 1024,
    });
    if (result.status !== 0 || result.stdout === undefined) return [];
    text = result.stdout.toString("utf8");
  } else if (existsSync(plain)) {
    try {
      text = readFileSync(plain, "utf8");
    } catch {
      return [];
    }
  } else {
    return [];
  }
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }
  return events;
}

/** 从事件里抽出一条消息的纯文本（跳过微信插件的固定前言和插件注入的上下文）。 */
function messageText(event) {
  // 插件注入的上下文（人设、历史载入）不算真实对话，跳过
  if (event?.data?.source?.kind === "plugin") return "";
  const blocks = event?.data?.content;
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  const text = parts.join("\n").trim();
  if (text.startsWith(BOILERPLATE_PREFIX)) return "";
  if (text.startsWith("【人设注入") || text.startsWith("【历史对话载入") || text.startsWith("【人设退出")) return "";
  // 去掉 Harness 给微信用户消息加的来源前缀，让载入的内容更干净
  return text.replace(/^\[Private Weixin message[^\]]*\]\s*/u, "");
}

/** 汇总一个会话的元信息。 */
function summarizeSession(dir, id) {
  const events = readSessionEvents(dir);
  let title;
  let userCount = 0;
  let firstUserText = "";
  const messages = [];

  for (const event of events) {
    if (event.type === "session/title") {
      const value = event?.data?.title;
      // 后续事件覆盖前面的（fallback → provider 生成的标题更有意义）
      if (typeof value === "string" && value.trim()) title = value.trim();
    } else if (event.type === "user/message" || event.type === "assistant/message") {
      const text = messageText(event);
      if (!text) continue;
      if (event.type === "user/message") {
        userCount += 1;
        if (!firstUserText) firstUserText = text.replace(/\s+/g, " ").slice(0, 40);
      }
      messages.push({ role: event.type === "user/message" ? "用户" : "助手", text });
    }
  }

  let mtime = 0;
  try {
    // 用会话文件的修改时间，比目录 mtime 准确（目录 mtime 不随内容写入更新）
    const zst = join(dir, "session.jsonl.zstd");
    mtime = existsSync(zst) ? statSync(zst).mtimeMs : statSync(dir).mtimeMs;
  } catch {
    /* 忽略 */
  }

  return {
    id,
    dir,
    title: title || firstUserText || "(无标题)",
    turns: userCount,
    mtime,
    messages,
  };
}

/** 扫描所有微信会话，按更新时间倒序。 */
function listWeixinSessions() {
  const found = [];
  let workspaces;
  try {
    workspaces = readdirSync(SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const base = join(SESSIONS_ROOT, workspace.name);
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(SESSION_PREFIX)) continue;
      const dir = join(base, entry.name);
      try {
        found.push(summarizeSession(dir, entry.name));
      } catch {
        /* 单个会话损坏不影响整体 */
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

/** 千分位格式化。 */
function fmtNumber(value) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 从 Harness 凭据文件取 DEEPSEEK_API_KEY。不打印、不外传。 */
function deepseekKey() {
  const text = readFileSync(CREDENTIAL_FILE, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.trimStart().startsWith("DEEPSEEK_API_KEY:"));
  if (!line) throw new Error("凭据文件里没有 DEEPSEEK_API_KEY");
  let value = line.slice(line.indexOf(":") + 1).trim();
  if ((value.startsWith(String.fromCharCode(34)) && value.endsWith(String.fromCharCode(34))) ||
      (value.startsWith(String.fromCharCode(39)) && value.endsWith(String.fromCharCode(39)))) {
    value = value.slice(1, -1);
  }
  if (!value) throw new Error("DEEPSEEK_API_KEY 为空");
  return value;
}

export function apply(ctx, _config) {
  // 状态目录先建好，避免首次写日志/状态失败
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* ignore */ }

  // 逐条注册并记录结果：任一条失败不影响其它条，且失败原因会落盘
  // 进程级注册登记表：跨「模块实例」共享（用 Symbol.for 挂在 globalThis 上），
  // 因此无论重挂多少次、版本号换没换，都能先释放上一批注册，避免命令名撞车。
  // 背景：cordis 重挂时新旧实例可能短暂共存，而 register() 遇到重复命令名会抛错；
  // 旧代码「一条失败整段中止」，曾导致 8 条命令全部消失。
  globalThis[Symbol.for("whale-commands.registrations")] ??= [];
  const registry = globalThis[Symbol.for("whale-commands.registrations")];
  let released = 0;
  for (const dispose of registry.splice(0)) {
    try { dispose(); released += 1; } catch { /* 已释放过则忽略 */ }
  }
  let okCount = 0;
  const pending = [];
  const register = (definition) => {
    try {
      const dispose = ctx.commands.register(definition);
      if (typeof dispose === "function") registry.push(dispose);
      okCount += 1;
      try {
        appendFileSync(LOG_FILE,
          `  register ok: ${definition.name}\n`, "utf8");
      } catch { /* ignore */ }
    } catch (error) {
      pending.push(definition);
      try {
        appendFileSync(LOG_FILE,
          `  register FAILED: ${definition.name}: ${String(error?.message ?? error)}\n`, "utf8");
      } catch { /* ignore */ }
    }
  };

  try {
    appendFileSync(
      LOG_FILE,
      `${new Date().toISOString()} apply pid=${process.pid} version=${__versionSearch || "(none)"} state=${isOn() ? "on" : "off"}\n`,
      "utf8",
    );
  } catch {
    /* 诊断写失败不影响功能 */
  }

  register({
    name: "whale",
    description: "开启鲸鱼娘（大肥鱼）人设",
    handler: ({ agent }) => {
      setOn(true);
      try {
        agent.inject(contextMessage(PERSONA));
      } catch (error) {
        return { kind: "error", text: `人设注入失败：${String(error?.message ?? error)}` };
      }
      return { kind: "success", text: "鲸鱼娘模式已开启喵～本小姐这就在了。" };
    },
  });

  register({
    name: "normal",
    description: "退出鲸鱼娘人设，恢复正常口吻",
    handler: ({ agent }) => {
      setOn(false);
      try {
        agent.inject(contextMessage(EXIT_NOTE));
      } catch (error) {
        return { kind: "error", text: `切换失败：${String(error?.message ?? error)}` };
      }
      return { kind: "success", text: "人设已关闭，恢复正常模式。" };
    },
  });

  register({
    name: "time",
    description: "显示当前服务器时间",
    handler: () => {
      const now = new Date();
      return {
        kind: "success",
        text: [
          `当前时间：${formatTime(now)}`,
          `时区：Asia/Shanghai (UTC+08:00)`,
          `Unix 时间戳：${Math.floor(now.getTime() / 1000)}`,
        ].join("\n"),
      };
    },
  });

  register({
    name: "sessions",
    description: "列出最近 5 个微信对话",
    handler: ({ agent }) => {
      let sessions;
      try {
        sessions = listWeixinSessions();
      } catch (error) {
        return { kind: "error", text: `读取会话失败：${String(error?.message ?? error)}` };
      }
      if (sessions.length === 0) {
        return { kind: "success", text: "没有找到任何微信对话记录。" };
      }
      const currentId = String(agent?.id ?? "");
      const top = sessions.slice(0, 5);
      const lines = [`最近的微信对话（共 ${sessions.length} 个，显示最新 ${top.length} 个）`, ""];
      top.forEach((s, index) => {
        const mark = s.id === currentId ? " ← 当前" : "";
        lines.push(`[${index + 1}] ${s.title}${mark}`);
        lines.push(`     ${relativeTime(s.mtime)} · ${s.turns} 条提问`);
      });
      lines.push("", "用 /load <编号> 把该对话的上下文载入当前会话。");
      lines.push("注意：这是载入上下文，不是切换会话本身。");
      return { kind: "success", text: lines.join("\n") };
    },
  });

  register({
    name: "load",
    description: "把指定编号的历史对话上下文载入当前会话",
    handler: ({ agent, rawInput }) => {
      const index = Number.parseInt(String(rawInput ?? "").trim(), 10);
      if (!Number.isInteger(index) || index < 1) {
        return { kind: "error", text: "用法：/load <编号>，编号用 /sessions 查看。" };
      }
      let sessions;
      try {
        sessions = listWeixinSessions().slice(0, 5);
      } catch (error) {
        return { kind: "error", text: `读取会话失败：${String(error?.message ?? error)}` };
      }
      const target = sessions[index - 1];
      if (target === undefined) {
        return { kind: "error", text: `没有编号 ${index} 的对话，先发 /sessions 看看。` };
      }
      if (target.id === String(agent?.id ?? "")) {
        return { kind: "success", text: "这就是当前会话，不用载入。" };
      }
      if (target.messages.length === 0) {
        return { kind: "error", text: "该对话没有可载入的消息内容。" };
      }

      const recent = target.messages.slice(-MAX_LOADED_MESSAGES);
      const body = [];
      let chars = 0;
      for (const message of recent) {
        const piece = `${message.role}：${message.text}`;
        if (chars + piece.length > MAX_LOADED_CHARS) break;
        chars += piece.length;
        body.push(piece);
      }
      if (body.length === 0) {
        return { kind: "error", text: "该对话内容过长，无法载入。" };
      }

      const text = [
        "【历史对话载入】以下是之前另一段对话的最近内容，供你接续参考。",
        `对话标题：${target.title}`,
        `时间：${formatTime(new Date(target.mtime))}`,
        "",
        ...body,
        "",
        "【载入结束】请在需要时利用以上信息，不要逐字复述。",
      ].join("\n");

      try {
        agent.inject(contextMessage(text));
      } catch (error) {
        return { kind: "error", text: `载入失败：${String(error?.message ?? error)}` };
      }
      return {
        kind: "success",
        text: `已载入「${target.title}」的最近 ${body.length} 条消息（约 ${chars} 字）。下一条消息起可接续该对话。`,
      };
    },
  });

  register({
    name: "style",
    description: "设置早上问候的风格（random / whale / imperial）",
    handler: ({ rawInput }) => {
      const MODES = ["random", "whale", "imperial"];
      const LABEL = { random: "50/50 随机", whale: "鲸鱼娘风", imperial: "朝堂风" };
      const readMode = () => {
        try {
          const value = readFileSync(STYLE_FILE, "utf8").trim();
          return MODES.includes(value) ? value : "random";
        } catch {
          return "random";
        }
      };
      const arg = String(rawInput ?? "").trim().toLowerCase();
      if (arg === "") {
        const current = readMode();
        return {
          kind: "success",
          text: [
            `当前问候风格：${LABEL[current]}`,
            "",
            "用法：",
            "/style whale — 固定鲸鱼娘风",
            "/style imperial — 固定朝堂风",
            "/style random — 恢复 50/50 随机",
          ].join("\n"),
        };
      }
      if (!MODES.includes(arg)) {
        return { kind: "error", text: `不认识「${arg}」。可选：random、whale、imperial。` };
      }
      try {
        writeFileSync(STYLE_FILE, arg + "\n", "utf8");
      } catch (error) {
        return { kind: "error", text: `写入失败：${String(error?.message ?? error)}` };
      }
      const tail = arg === "random" ? "以后每天 50/50 随机抽一版。" : `以后每天 7:00 都发${LABEL[arg]}。`;
      return { kind: "success", text: `已设定：${LABEL[arg]}。${tail}` };
    },
  });

  register({
    name: "token",
    description: "查看 token 用量、今日累计与账户余额",
    handler: async ({ agent }) => {
      const lines = [];

      // 用量累加：只用 assistant/message 的 usage，避免 assistant/chunk 重复计数
      const sumUsage = (events) => {
        const acc = { input: 0, output: 0, cacheRead: 0, reasoning: 0, requests: 0, turns: 0 };
        for (const event of events) {
          if (event?.type === "turn/start") acc.turns += 1;
          if (event?.type === "assistant/message" && event?.data?.usage) {
            const u = event.data.usage;
            acc.input += u.inputTokens ?? 0;
            acc.output += u.outputTokens ?? 0;
            acc.cacheRead += u.cacheReadTokens ?? 0;
            acc.reasoning += u.reasoningTokens ?? 0;
            acc.requests += 1;
          }
        }
        return acc;
      };

      // 价目：USD / 每百万 token，取自 pi-ai 内置 deepseek-v4-flash 目录
      const PRICE = { input: 0.14, output: 0.28, cacheRead: 0.0028 };
      const costOf = (a) =>
        (a.input * PRICE.input + a.cacheRead * PRICE.cacheRead + a.output * PRICE.output) / 1e6;
      const pct = (part, whole) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "—");
      const usd = (value) => `$${value.toFixed(value < 0.01 ? 4 : 2)}`;

      // ── 1) 本会话 ──
      try {
        const a = sumUsage(agent?.session?.events ?? []);
        const totalInput = a.input + a.cacheRead;
        lines.push("【本会话】");
        lines.push(`  请求 ${a.requests} 次 / 轮次 ${a.turns}`);
        lines.push(`  输入 ${fmtNumber(totalInput)}（缓存 ${fmtNumber(a.cacheRead)} / 新增 ${fmtNumber(a.input)}）`);
        lines.push(`  输出 ${fmtNumber(a.output)}（其中推理 ${fmtNumber(a.reasoning)}）`);
        lines.push(`  合计 ${fmtNumber(totalInput + a.output)} · 缓存命中率 ${pct(a.cacheRead, totalInput)}`);
        lines.push(`  估算花费 ${usd(costOf(a))}`);
      } catch (error) {
        lines.push("【本会话】读取失败：" + String(error?.message ?? error));
      }

      // ── 2) 今日累计（所有微信会话）──
      try {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const since = startOfDay.getTime();
        const dirs = [];
        for (const workspace of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
          if (!workspace.isDirectory()) continue;
          const base = join(SESSIONS_ROOT, workspace.name);
          for (const entry of readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith(SESSION_PREFIX)) continue;
            const dir = join(base, entry.name);
            try {
              const mtime = statSync(join(dir, "session.jsonl.zstd")).mtimeMs;
              if (mtime >= since) dirs.push(dir);
            } catch {
              /* 跳过读不到时间的 */
            }
          }
        }
        let today = { input: 0, output: 0, cacheRead: 0, reasoning: 0, requests: 0, turns: 0 };
        for (const dir of dirs) {
          const a = sumUsage(readSessionEvents(dir));
          today.input += a.input;
          today.output += a.output;
          today.cacheRead += a.cacheRead;
          today.reasoning += a.reasoning;
          today.requests += a.requests;
          today.turns += a.turns;
        }
        const totalInput = today.input + today.cacheRead;
        lines.push("", `【今日累计】${dirs.length} 个会话`);
        if (dirs.length === 0) {
          lines.push("  今天还没有记录");
        } else {
          lines.push(`  输入 ${fmtNumber(totalInput)}（缓存 ${fmtNumber(today.cacheRead)} / 新增 ${fmtNumber(today.input)}）`);
          lines.push(`  输出 ${fmtNumber(today.output)}（其中推理 ${fmtNumber(today.reasoning)}）`);
          lines.push(`  合计 ${fmtNumber(totalInput + today.output)} · 缓存命中率 ${pct(today.cacheRead, totalInput)}`);
          lines.push(`  估算花费 ${usd(costOf(today))}（按 v4-flash 价目，USD）`);
        }
      } catch (error) {
        lines.push("", "【今日累计】读取失败：" + String(error?.message ?? error));
      }

      // ── 3) 账户余额 ──
      lines.push("", "【账户余额】");
      try {
        const key = deepseekKey();
        const response = await fetch(BALANCE_URL, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
        const main = infos.find((i) => i.currency === "CNY") ?? infos[0];
        if (!main) throw new Error("响应里没有余额信息");
        const symbol = main.currency === "CNY" ? "¥" : main.currency === "USD" ? "$" : "";
        lines.push(`  可用 ${symbol}${main.total_balance}（${main.currency}）`);
        lines.push(`  充值 ${symbol}${main.topped_up_balance} / 赠送 ${symbol}${main.granted_balance}`);
        lines.push(`  账户状态：${data.is_available ? "正常" : "不可用"}`);
      } catch (error) {
        lines.push("  查询失败：" + String(error?.message ?? error));
      }

      return { kind: "success", text: lines.join("\n") };
    },
  });

  register({
    name: "help",
    description: "列出全部可用命令",
    handler: ({ agent }) => {
      let registered;
      try {
        registered = ctx.commands
          .list(agent)
          .map((command) => `/${command.name} — ${command.description}`);
      } catch (error) {
        registered = [`（读取命令列表失败：${String(error?.message ?? error)}）`];
      }
      const lines = [
        "DeepSeek Harness 微信机器人 · 全部命令",
        "",
        "【对话控制】",
        "/whale — 开启鲸鱼娘人设",
        "/normal — 退出鲸鱼娘人设",
        "/new 或 /reset — 开始新会话（人设开关会继承）",
        "/sessions — 列出最近 5 个微信对话",
        "/load <编号> — 把该对话上下文载入当前会话",
        "/time — 查看当前时间",
        "/token — 查看 token 用量、今日累计与账户余额",
        "/style <random|whale|imperial> — 设置早上问候风格",
        "/help — 显示这份列表",
        "",
        "【通道检测】",
        ...CHANNEL_COMMANDS.slice(0, 6),
        "",
        "【工具审批】",
        ...CHANNEL_COMMANDS.slice(6),
        "",
        "【Harness 运行时注册的命令】",
        ...registered,
        "",
        `鲸鱼娘人设当前状态：${isOn() ? "已开启" : "已关闭"}`,
      ];
      return { kind: "success", text: lines.join("\n") };
    },
  });

  // 跨 /new：新会话创建时按开关状态自动继承人设
  // 自愈：cordis 重挂时新旧实例可能短暂共存导致命令名撞车。等旧实例释放后补注册。
  if (pending.length > 0) {
    for (const delay of [600, 1800, 4000, 8000]) {
      setTimeout(() => {
        const stillFailing = [];
        for (const definition of pending.splice(0)) {
          try {
            const dispose = ctx.commands.register(definition);
            if (typeof dispose === "function") registry.push(dispose);
            okCount += 1;
            try {
              appendFileSync(LOG_FILE,
                `  register RETRY ok: ${definition.name} (+${delay}ms)\n`, "utf8");
            } catch { /* ignore */ }
          } catch (error) {
            stillFailing.push(definition);
            try {
              appendFileSync(LOG_FILE,
                `  register RETRY failed: ${definition.name} (+${delay}ms): ${String(error?.message ?? error)}\n`, "utf8");
            } catch { /* ignore */ }
          }
        }
        pending.push(...stillFailing);
      }, delay);
    }
  }

  try {
    appendFileSync(LOG_FILE,
      `  apply done: ok=${okCount} released=${released} pid=${process.pid}\n`, "utf8");
  } catch { /* ignore */ }

  ctx.on("agent/created", ({ agent }) => {
    if (!isOn() || !isWeixinAgent(agent)) return;
    try {
      agent.inject(contextMessage(PERSONA));
    } catch (error) {
      try {
        appendFileSync(
          LOG_FILE,
          `  inject-on-create FAILED for ${String(agent?.id)}: ${String(error?.message ?? error)}\n`,
          "utf8",
        );
      } catch { /* ignore */ }
      return;
    }
    // 注入成功后主动推一条提示（走 iLink，和定时请安同一套通道）
    Promise.resolve()
      .then(() =>
        pushText("【自动提示】新会话已创建，鲸鱼娘人设已自动继承喵～"),
      )
      .then((result) => {
        if (!result?.ok) {
          ctx.logger?.warn?.("whale-persona-command: notify failed: %s", JSON.stringify(result));
        }
      })
      .catch((error) => {
        ctx.logger?.warn?.("whale-persona-command: notify threw: %s", String(error));
      });
  });
}
