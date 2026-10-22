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
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** [迁移] 跟随 DSH_HOME，避免影子读写生产目录 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
// 用与本模块相同的 ?v= 查询串导入，保证版本升级时依赖也一起重新加载
const __versionSearch = new URL(import.meta.url).search;
const { sendText: pushText } = await import(
  new URL(`./weixin-send.mjs${__versionSearch}`, import.meta.url).href
);
/**
 * 人设库：全部人设 prompt 都在 personas.mjs 里，本文件只负责「选谁」和「注入」。
 * 同样带 ?v= 查询串，保证改人设时随版本号一起重新加载。
 */
const { PERSONAS, WHALE_ID, resolvePersona, exitNote, defaultNotice, personaIds } = await import(
  new URL(`./personas.mjs${__versionSearch}`, import.meta.url).href
);

/**
 * 模型选择注入器：dsh-agent 的 installModelSelection 能让「某个 agent」的请求
 * 覆盖 provider/model/effort（Web UI 切模型走的就是这条机制）。
 * 动态导入并容错：拿不到就退化成「只改默认设置」，绝不让插件加载失败。
 */
let installModelSelection = null;
try {
  ({ installModelSelection } = await import("@deepseek-ai/dsh-agent"));
} catch (error) {
  installModelSelection = null;
}

export const name = "whale-persona-command";
export const inject = ["commands"];

const STATE_FILE = `${DSH_HOME}/.whale-mode`;
/** 早间问候风格设定文件，由 /style 命令写入，morning.sh 读取。 */
const STYLE_FILE = `${DSH_HOME}/.schedule/style.mode`;
/** 会话 id 前缀（微信通道默认 weixin-）. */
const SESSION_PREFIX = process.env.DSH_WHALE_SESSION_PREFIX?.trim() || "weixin-";
/** zstd 可执行文件（多帧日志必须用 CLI 解）. */
const ZSTD_BIN = process.env.DSH_WHALE_ZSTD?.trim() || "/usr/bin/zstd";
/** 余额查询接口. */
const BALANCE_URL = process.env.DSH_BALANCE_URL?.trim() || "https://api.deepseek.com/user/balance";
/** 会话根目录；测试时可用 WHALE_SESSIONS_ROOT 指向临时目录。 */
const SESSIONS_ROOT = process.env.WHALE_SESSIONS_ROOT || `${DSH_HOME}/sessions`;
/** 微信插件给每条入站消息前置的固定说明，做预览时要跳过。 */
const BOILERPLATE_PREFIX = "You are replying through Weixin.";
/** /load 最多载入多少条消息、多少字符。 */
const MAX_LOADED_MESSAGES = 16;
const MAX_LOADED_CHARS = 8000;
/** 真切换请求文件：由 /load 写入，微信通道插件读取后执行真实换绑。 */
const PENDING_SWITCH_FILE =
  (process.env.DSH_HOME || join(homedir(), ".dsh")) + "/.whale-commands/pending-switch.json";
/**
 * 「见过的会话」记录，用来区分「真新会话（/new）」和「旧会话被重新打开（resume / 重连）」。
 *
 * 为什么需要：agent/created 在三种情况下都会触发——
 *   1. 微信 /new 真的新建了会话；
 *   2. 旧会话被重新打开（Web 端打开、通道重连），会话日志里会追加 session/end-seed；
 *   3. 进程重启后恢复绑定。
 * 只有第 1 种才是「新会话」，另外两种把同样的话再说一遍就会让主人莫名其妙。
 */
const SEEN_FILE =
  process.env.WHALE_SEEN_FILE || `${DSH_HOME}/.whale-commands/seen-sessions.json`;
/** 提示语（新会话 / 重连）随人设走，定义在 personas.mjs 的 noticeNew / noticeBack 里。 */
/** 模型选择状态：全局默认 + 每个会话的覆盖（都为空表示「不干预」）。 */
/** 菜单隐藏名单：一行一个命令名（`#` 注释）。只影响 /help 展示，不影响命令可用。 */
const HIDDEN_FILE = `${DSH_HOME}/.whale-commands/hidden.commands`;
/** 读菜单隐藏名单；读不到当空集。 */
function hiddenCommands() {
  try {
    return new Set(
      readFileSync(HIDDEN_FILE, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#")),
    );
  } catch {
    return new Set();
  }
}

const MODEL_STATE_FILE =
  process.env.WHALE_MODEL_STATE || `${DSH_HOME}/.whale-commands/model-select.json`;
const MODEL_PROVIDER = "deepseek-official";
/** settings.yaml 读不到时的兜底模型表。 */
const FALLBACK_MODELS = [
  { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
];
const EFFORTS = ["low", "high", "max", "off"];

/**
 * 人设提示词与退出语全部迁到 personas.mjs（多个人设以后只维护那一个文件）。
 * 这里只保留「取哪条提示语」的逻辑。
 */

/** 按判定结果取当前人设对应的提示语；人设没写就退回中性文案。 */
function noticeFor(kind, persona) {
  const list = kind === "new" ? persona?.noticeNew : persona?.noticeBack;
  if (Array.isArray(list) && list.length > 0) return randomOf(list);
  return defaultNotice(kind, persona);
}

const CHANNEL_COMMANDS = [
  "/bot-ping — 检查连通性",
  "/bot-image-test — 发送蓝色图片，检查图片链路",
  "/bot-file-test — 发送文本文件，检查文件链路",
  "/bot-status — 查看当前连接状态",
  "/bot-cancel — 取消当前生成",
  "/approve 123456 — 批准一次待处理工具调用",
  "/reject 123456 — 拒绝一次待处理工具调用",
];

/**
 * 读取当前启用的人设，返回人设对象；关闭或无有效值时返回 null。
 *
 * 状态文件兼容三种历史形态，读到就自动认：
 *   on        —— 老版本（只有鲸鱼娘一个开关）→ 视为原版鲸鱼娘
 *   off / 空  —— 关闭
 *   <id>      —— 当前启用的人设 id（whale / maid / cold …）
 * 老值不动，只在新写入时改用 id，升级不丢状态。
 */
function activePersona() {
  let raw = "";
  try {
    raw = readFileSync(STATE_FILE, "utf8").trim();
  } catch {
    return null;
  }
  if (!raw || raw === "off") return null;
  if (raw === "on") return resolvePersona(WHALE_ID) ?? null;
  return resolvePersona(raw);
}

/** 写入当前人设；传 null / 空表示关闭。 */
function setPersona(id) {
  writeFileSync(STATE_FILE, id ? `${id}\n` : "off\n", "utf8");
}

function contextMessage(text) {
  return createUserMessage({
    content: [{ type: "text", text }],
    // [迁移] 0.2 的 v4 会话格式禁止 kind="plugin"，改用生产者名
    source: { kind: "whale-persona-command", plugin: "whale-commands" },
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

/** 插件诊断日志（写失败绝不影响主流程）。 */
function pluginNote(line) {
  try {
    appendFileSync(`${DSH_HOME}/.playground/whale-plugin.log`, `  ${line}\n`, "utf8");
  } catch {
    /* 日志不可写就放弃 */
  }
}

function randomOf(list) {
  return list[Math.floor(Math.random() * list.length)] ?? list[0];
}

/** weixin-...-new-7 → 7；base 会话没有后代编号，记为 0。 */
function generationOf(id) {
  const match = /-new-(\d+)$/.exec(String(id ?? ""));
  return match ? Number(match[1]) : 0;
}

function loadSeenState() {
  try {
    const parsed = JSON.parse(readFileSync(SEEN_FILE, "utf8"));
    const ids = parsed && typeof parsed.ids === "object" && parsed.ids !== null ? parsed.ids : {};
    const maxGeneration = Number.isFinite(parsed?.maxGeneration) ? parsed.maxGeneration : 0;
    return { maxGeneration, ids };
  } catch {
    return { maxGeneration: 0, ids: {} };
  }
}

function saveSeenState(state) {
  try {
    state.updatedAt = new Date().toISOString();
    writeFileSync(SEEN_FILE, JSON.stringify(state, null, 1), "utf8");
  } catch (error) {
    pluginNote(`seen-state SAVE FAILED: ${String(error?.message ?? error)}`);
  }
}

/** 在 sessions/<workspace>/<id> 里找会话目录（只用于判断目录年龄，不读内容）。 */
function findSessionDir(id) {
  try {
    for (const workspace of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const dir = join(SESSIONS_ROOT, workspace.name, String(id));
      if (existsSync(dir)) return dir;
    }
  } catch {
    /* 读不到就当没有 */
  }
  return undefined;
}

/**
 * 判定一次 agent/created 是「真新会话」还是「旧会话被重开」。
 *
 * 判据（从强到弱）：
 *   1. 这个 id 以前见过 → 一定是重开（revisit）；
 *   2. 没见过的 id：后代编号严格大于历史最大编号，且会话目录是最近才创建的 → 新会话（new）；
 *   3. 其余（编号不涨、或目录早已存在，例如状态文件被清掉后遇到老会话）→ 重开（revisit）。
 *
 * 返回 { verdict, generation, maxGeneration, known, dirAgeMs }。
 */
export function judgeAgentCreate(id, now = Date.now()) {
  const state = loadSeenState();
  const generation = generationOf(id);
  const known = Object.prototype.hasOwnProperty.call(state.ids, String(id));

  let dirAgeMs = null;
  const dir = findSessionDir(id);
  if (dir !== undefined) {
    try {
      const st = statSync(dir);
      const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
      if (Number.isFinite(born) && born > 0) dirAgeMs = Math.max(0, now - born);
    } catch {
      /* 忽略 */
    }
  }

  const newerGeneration = generation > state.maxGeneration;
  const freshDir = dirAgeMs === null ? true : dirAgeMs < 120_000;
  const verdict = !known && newerGeneration && freshDir ? "new" : "revisit";

  state.ids[String(id)] = now;
  if (generation > state.maxGeneration) state.maxGeneration = generation;
  saveSeenState(state);

  return { verdict, generation, maxGeneration: state.maxGeneration, known, dirAgeMs };
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
  const text = readFileSync(`${DSH_HOME}/.credentials.yaml`, "utf8");
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

/** 探测微信通道插件是否打了「真切换」补丁（存在 switchConversation 方法）。 */
function channelSupportsHardSwitch() {
  const candidates = [
    join(DSH_HOME, "profiles/web/node_modules/deepseek-harness-weixin/dist/index.js"),
    join(DSH_HOME, "profiles/web/plugins/weixin-020/dist/index.js"),
    join(DSH_HOME, "profiles/web/plugins/weixin/dist/index.js"),
  ];
  for (const file of candidates) {
    try {
      if (readFileSync(file, "utf8").includes("switchConversation")) return true;
    } catch {
      /* 换下一个候选 */
    }
  }
  return false;
}

/** 从凭据文件读任意键（自动去引号）；读不到返回空串，不抛错。环境变量可临时覆盖（便于测试）。 */
function credentialValue(key) {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const text = readFileSync(`${DSH_HOME}/.credentials.yaml`, "utf8");
    const line = text.split(/\r?\n/).find((l) => l.trimStart().startsWith(key + ":"));
    if (!line) return "";
    let value = line.slice(line.indexOf(":") + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  } catch {
    return "";
  }
}

const PLATFORM_BASE = "https://platform.deepseek.com/api/v0";

/**
 * 调 platform 网页使用的私有用量接口。
 *
 * 认证只能用登录态 userToken（API Key 会得到 code 40003），token 会过期；
 * 任何失败都抛错，由调用方决定是否回退到本地统计。
 */
async function platformGet(path, token, timeoutMs = 12_000) {
  const res = await fetch(PLATFORM_BASE + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "x-client-platform": "web",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("返回不是 JSON");
  }
  if (json?.code !== 0) {
    throw new Error(`平台错误 ${json?.code ?? "?"} ${json?.msg ?? ""}`.trim());
  }
  const biz = json?.data;
  if (!biz || biz.biz_code !== 0) {
    throw new Error(`业务错误 ${biz?.biz_code ?? "?"} ${biz?.biz_msg ?? ""}`.trim());
  }
  return biz.biz_data;
}

/** 本地日期 YYYY-MM-DD。 */
function isoDay(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 官方默认单价兜底（元 / 百万 token），拟合失败或样本不足时使用。 */
const DEFAULT_UNIT_PRICES = {
  "deepseek-flash": { hit: 0.02, miss: 1, out: 4 },
  "deepseek-v4-pro": { hit: 0.15, miss: 4.5, out: 13.5 },
};
const FALLBACK_PRICE = { hit: 0.02, miss: 1, out: 4 };

/** 官方单价缓存：token 过期时仍能按最近一次官方单价估算本地花费。 */
const PRICE_CACHE_FILE = `${DSH_HOME}/.whale-commands/usage-prices.json`;

function readPriceCache() {
  try {
    const parsed = JSON.parse(readFileSync(PRICE_CACHE_FILE, "utf8"));
    return parsed && typeof parsed.prices === "object" && parsed.prices !== null ? parsed.prices : null;
  } catch {
    return null;
  }
}

function savePriceCache(prices) {
  try {
    writeFileSync(
      PRICE_CACHE_FILE,
      JSON.stringify({ prices, updatedAt: new Date().toISOString() }, null, 1),
      "utf8",
    );
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/** 高斯消元解 3×3 线性方程组；奇异/病态返回 null。 */
function solveLinear3(matrix, vector) {
  const m = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      if (!Number.isFinite(factor) || factor === 0) continue;
      for (let k = col; k < 4; k += 1) m[row][k] -= factor * m[col][k];
    }
  }
  const solved = [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  if (solved.some((x) => !Number.isFinite(x) || x < 0)) return null;
  return { hit: solved[0], miss: solved[1], out: solved[2] };
}

/**
 * 用每天的「缓存命中 / 未命中 / 输出(tokens) + 当日花费(元)」反推官方单价。
 * 超过 3 个样本时用最小二乘（正规方程），恰好 3 个样本时等价于直接解方程。
 * 返回 { hit, miss, out }（元 / 百万 token），无解返回 null。
 */
export function fitUnitPrices(samples) {
  const rows = (samples ?? []).filter(
    (row) => row && row.cny > 0 && (row.hit + row.miss + row.out) > 0,
  );
  if (rows.length < 3) return null;

  const ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const atb = [0, 0, 0];
  for (const row of rows) {
    const x = [row.hit / 1e6, row.miss / 1e6, row.out / 1e6];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) ata[i][j] += x[i] * x[j];
      atb[i] += x[i] * row.cny;
    }
  }
  return solveLinear3(ata, atb);
}

/**
 * 官方近 N 天用量与花费（platform 私有接口，按月接口拼出日期窗口）。
 *
 * 月度接口只给自然月，所以取「本月 + 上月」两个月的数据，再按 [startDay, endDay] 过滤。
 * 同时返回：
 *   - today：窗口末尾那一天的明细（用于「官方近 1 天」）
 *   - prices：从真实账单反推的官方单价（元/百万 token，按模型）
 * 任何接口失败直接抛错（调用方回退本地统计）。
 */
export async function officialUsageWindow(token, days = 30, now = new Date()) {
  const endMs = now.getTime();
  const startMs = endMs - (days - 1) * 86_400_000;
  const startDay = isoDay(new Date(startMs));
  const endDay = isoDay(now);

  const months = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 0; i < 2; i += 1) {
    months.push({ year: cursor.getFullYear(), month: cursor.getMonth() + 1 });
    cursor.setMonth(cursor.getMonth() - 1);
  }

  const emptyBucket = () => ({ hit: 0, miss: 0, promptOnly: 0, out: 0, req: 0, cny: 0, usd: 0 });
  const daily = new Map(); // date -> bucket（所有模型合计）
  const perModel = new Map(); // model -> Map<date, bucket>

  const bucketOf = (map, key) => {
    let value = map.get(key);
    if (value === undefined) {
      value = emptyBucket();
      map.set(key, value);
    }
    return value;
  };
  const modelBucket = (model, date) => {
    let byDate = perModel.get(model);
    if (byDate === undefined) {
      byDate = new Map();
      perModel.set(model, byDate);
    }
    return bucketOf(byDate, date);
  };

  const inWindow = (date) => Boolean(date) && date >= startDay && date <= endDay;

  for (const { year, month } of months) {
    const amount = await platformGet(`/usage/amount?month=${month}&year=${year}`, token);
    for (const day of amount?.days ?? []) {
      const date = String(day?.date ?? "");
      if (!inWindow(date)) continue;
      const total = bucketOf(daily, date);
      for (const entry of day?.data ?? []) {
        const model = String(entry?.model ?? "unknown");
        const modelTotal = modelBucket(model, date);
        for (const item of entry?.usage ?? []) {
          const value = Number(item?.amount ?? 0);
          if (!Number.isFinite(value)) continue;
          for (const bucket of [total, modelTotal]) {
            switch (item?.type) {
              case "PROMPT_CACHE_HIT_TOKEN":
                bucket.hit += value;
                break;
              case "PROMPT_CACHE_MISS_TOKEN":
                bucket.miss += value;
                break;
              case "PROMPT_TOKEN":
                bucket.promptOnly += value;
                break;
              case "RESPONSE_TOKEN":
                bucket.out += value;
                break;
              case "REQUEST":
                bucket.req += value;
                break;
              default:
                break;
            }
          }
        }
      }
    }

    const cost = await platformGet(`/usage/cost?month=${month}&year=${year}`, token);
    for (const entry of Array.isArray(cost) ? cost : []) {
      const currency = String(entry?.currency ?? "");
      if (currency !== "CNY" && currency !== "USD") continue;
      for (const day of entry?.days ?? []) {
        const date = String(day?.date ?? "");
        if (!inWindow(date)) continue;
        const total = bucketOf(daily, date);
        for (const modelEntry of day?.data ?? []) {
          const model = String(modelEntry?.model ?? "unknown");
          const modelTotal = modelBucket(model, date);
          let sum = 0;
          for (const item of modelEntry?.usage ?? []) {
            const value = Number(item?.amount ?? 0);
            if (Number.isFinite(value)) sum += value;
          }
          if (currency === "CNY") {
            total.cny += sum;
            modelTotal.cny += sum;
          } else {
            total.usd += sum;
            modelTotal.usd += sum;
          }
        }
      }
    }
  }

  let hit = 0;
  let miss = 0;
  let out = 0;
  let req = 0;
  let cny = 0;
  let usd = 0;
  let usedDays = 0;
  const dailyList = [];
  for (const [date, bucket] of daily) {
    // 老接口只给 PROMPT_TOKEN 总数时，把它当「未命中输入」，避免少算
    const hasSplit = bucket.hit > 0 || bucket.miss > 0;
    const missTotal = bucket.miss + (hasSplit ? 0 : bucket.promptOnly);
    const row = { date, hit: bucket.hit, miss: missTotal, out: bucket.out, req: bucket.req, cny: bucket.cny };
    dailyList.push(row);
    hit += bucket.hit;
    miss += missTotal;
    out += bucket.out;
    req += bucket.req;
    cny += bucket.cny;
    usd += bucket.usd;
    if (bucket.req > 0 || bucket.hit > 0 || bucket.miss > 0 || bucket.out > 0) usedDays += 1;
  }
  dailyList.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 用真实账单反推每个模型的官方单价（元/百万 token）
  const prices = {};
  for (const [model, byDate] of perModel) {
    const samples = [...byDate.values()]
      .map((bucket) => {
        const hasSplit = bucket.hit > 0 || bucket.miss > 0;
        return {
          hit: bucket.hit,
          miss: bucket.miss + (hasSplit ? 0 : bucket.promptOnly),
          out: bucket.out,
          cny: bucket.cny,
        };
      })
      .filter((row) => row.cny > 0 && row.hit + row.miss + row.out > 0);
    prices[model] = fitUnitPrices(samples) ?? DEFAULT_UNIT_PRICES[model] ?? FALLBACK_PRICE;
  }

  const todayKey = isoDay(now);
  const today = dailyList.find((row) => row.date === todayKey) ?? {
    date: todayKey,
    hit: 0,
    miss: 0,
    out: 0,
    req: 0,
    cny: 0,
  };

  return { startDay, endDay, hit, miss, out, req, cny, usd, usedDays, days: daily.size, daily: dailyList, today, prices };
}

/** 读取模型选择状态 { default, sessions }。 */
function loadModelState() {
  try {
    const parsed = JSON.parse(readFileSync(MODEL_STATE_FILE, "utf8"));
    return {
      default: parsed?.default && typeof parsed.default === "object" ? parsed.default : null,
      sessions:
        parsed?.sessions && typeof parsed.sessions === "object" && parsed.sessions !== null
          ? parsed.sessions
          : {},
    };
  } catch {
    return { default: null, sessions: {} };
  }
}

function saveModelState(state) {
  try {
    writeFileSync(
      MODEL_STATE_FILE,
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 1),
      "utf8",
    );
  } catch (error) {
    pluginNote(`model-state SAVE FAILED: ${String(error?.message ?? error)}`);
  }
}

/** 模型目录：优先读 settings.yaml 的 llm-deepseek.models，读不到用兜底表。 */
export function modelCatalog(settingsPath = `${DSH_HOME}/settings.yaml`) {
  try {
    const text = readFileSync(settingsPath, "utf8");
    const models = [];
    const re = /-\s+id:\s*([\w.\-]+)\s*\n\s+name:\s*([^\n]+)/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      models.push({ id: match[1].trim(), name: match[2].trim() });
    }
    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

/** 把用户输入（id / 名字片段）解析成模型。 */
function resolveModel(token) {
  const wanted = String(token ?? "").trim().toLowerCase();
  if (!wanted) return undefined;
  const catalog = modelCatalog();
  return (
    catalog.find((m) => m.id.toLowerCase() === wanted) ??
    catalog.find((m) => m.id.toLowerCase().includes(wanted)) ??
    catalog.find((m) => m.name.toLowerCase().includes(wanted))
  );
}

/** 人类可读的选择描述。 */
function describeSelection(selection) {
  if (!selection || !selection.model) return "默认（不干预）";
  const effort = selection.reasoningEffort ? ` · effort=${selection.reasoningEffort}` : "";
  return `${selection.model}${effort}`;
}

/**
 * 给一个 agent 装「可运行期修改」的模型选择。
 * Web UI 切模型走的是同一机制；这里让微信会话也能被 /model 即时切换。
 * 任何失败都返回 null（该会话退回「跟随宿主持有者」）。
 */
function installAgentModelSelection(agent, selections) {
  if (installModelSelection === null) return null;
  if (agent === undefined || typeof agent?.ctx?.on !== "function") return null;
  const state = loadModelState();
  const initial = state.sessions[String(agent.id)] ?? state.default ?? undefined;
  const selection = { current: initial };
  try {
    installModelSelection(agent.ctx, selection);
  } catch (error) {
    pluginNote(`model-selection INSTALL FAILED for ${String(agent?.id)}: ${String(error?.message ?? error)}`);
    return null;
  }
  selections.set(String(agent.id), selection);
  return selection;
}

export function apply(ctx, _config) {
  /** 会话提示节流表：id → 上次推送时间。 */
  const lastNoticeAt = new Map();
  /** 每个微信会话的模型选择句柄：id → { current }（供 /model 即时切换）。 */
  const agentSelections = new Map();
  /**
   * 跨实例的「最近一次提示」窗口。
   *
   * 为什么需要：/new 不只建新会话，还会把旧会话一起重新唤醒——审计日志实测
   * gen=11 的新会话提示推完 2.8 秒后，旧会话（gen=10）又触发一次 agent/created
   * 并被判成 revisit，于是主人一次 /new 收到两条提示
   * （「新会话开好啦」+「连接抖了一下，我还在呢」），后者纯属噪音。
   *
   * 规则：刚推过「新会话」的 120 秒内，后续 revisit 一律静默。
   * 挂在 globalThis（Symbol.for）上：热挂载换实例时窗口不丢，
   * 否则重挂瞬间正好赶上的那条又会漏出去。
   */
  const noticeWindow = (globalThis[Symbol.for("whale-commands.notice-window")] ??= {
    at: 0,
    verdict: "",
  });
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
        appendFileSync(`${DSH_HOME}/.playground/whale-plugin.log`,
          `  register ok: ${definition.name}\n`, "utf8");
      } catch { /* ignore */ }
    } catch (error) {
      pending.push(definition);
      try {
        appendFileSync(`${DSH_HOME}/.playground/whale-plugin.log`,
          `  register FAILED: ${definition.name}: ${String(error?.message ?? error)}\n`, "utf8");
      } catch { /* ignore */ }
    }
  };

  try {
    const active = activePersona();
    appendFileSync(
      `${DSH_HOME}/.playground/whale-plugin.log`,
      `${new Date().toISOString()} apply pid=${process.pid} version=${__versionSearch || "(none)"} persona=${active ? active.id : "off"}\n`,
      "utf8",
    );
  } catch {
    /* 诊断写失败不影响功能 */
  }

  /**
   * 注入人设。从人设 A 切到 B 时，前面必须先声明 A 作废 —
   * 否则上下文里两条设定并存，模型会演成缝合怪（一半鲸鱼娘一半女仆）。
   */
  function injectPersona(agent, persona) {
    const previous = activePersona();
    const header =
      previous && previous.id !== persona.id
        ? `【人设切换】「${previous.name}」人设已作废，从此刻起改用「${persona.name}」人设：旧人设的自称、口癖、口头禅与动作描写全部停止使用。\n\n`
        : "";
    agent.inject(contextMessage(`${header}${persona.prompt}`));
  }

  /** 关闭人设：写回 off，并注入带人设名的退出语。 */
  function closePersona(agent) {
    const current = activePersona();
    agent.inject(contextMessage(exitNote(current?.name)));
    setPersona(null);
    return current;
  }

  register({
    name: "whale",
    description: "切回原版鲸鱼娘（大肥鱼）人设 —— 纪念版本，设定一字未改",
    handler: ({ agent }) => {
      const persona = resolvePersona(WHALE_ID);
      if (!persona) {
        return { kind: "error", text: "人设库里找不到原版鲸鱼娘，请检查 personas.mjs。" };
      }
      try {
        injectPersona(agent, persona);
      } catch (error) {
        return { kind: "error", text: `人设注入失败：${String(error?.message ?? error)}` };
      }
      setPersona(persona.id);
      return { kind: "success", text: persona.switched };
    },
  });

  register({
    name: "normal",
    description: "关闭当前人设，恢复正常助手口吻（同 /persona off）",
    handler: ({ agent }) => {
      let closed;
      try {
        closed = closePersona(agent);
      } catch (error) {
        return { kind: "error", text: `切换失败：${String(error?.message ?? error)}` };
      }
      return {
        kind: "success",
        text: closed ? `「${closed.name}」人设已关闭，恢复正常模式。` : "当前没有人设，已经是正常模式啦。",
      };
    },
  });

  register({
    name: "persona",
    description: "人设库：/persona 列表 ｜ /persona <编号|id> 切换 ｜ /persona off 关闭",
    handler: ({ agent, rawInput }) => {
      const arg = String(rawInput ?? "").trim();
      const lower = arg.toLowerCase();
      const current = activePersona();

      // 无参数 / list：列出全部人设，并标出当前在用哪个
      if (!arg || lower === "list" || lower === "ls" || lower === "?") {
        const lines = [
          `🎭 人设库（${PERSONAS.length}）· 当前：${current ? `${current.emoji} ${current.name}` : "无（默认助手口吻）"}`,
          "",
        ];
        PERSONAS.forEach((p, i) => {
          const mark = current && current.id === p.id ? "▸" : " ";
          lines.push(`${mark}${String(i + 1).padStart(2)}. ${p.emoji} ${p.name}`);
          lines.push(`      ${p.id} · ${p.tagline}`);
        });
        lines.push("", "切换：/persona <编号|id> ｜ 关闭：/persona off ｜ 原版鲸鱼娘：/whale");
        return { kind: "success", text: lines.join("\n") };
      }

      if (lower === "off" || lower === "none" || lower === "normal") {
        let closed;
        try {
          closed = closePersona(agent);
        } catch (error) {
          return { kind: "error", text: `关闭失败：${String(error?.message ?? error)}` };
        }
        return {
          kind: "success",
          text: closed ? `「${closed.name}」人设已关闭，恢复正常模式。` : "本来就是正常模式，没开人设哦。",
        };
      }

      const target = resolvePersona(arg);
      if (!target) {
        return {
          kind: "error",
          text: `认不出「${arg}」。发 /persona 看全部 ${PERSONAS.length} 个人设和对应编号。`,
        };
      }
      try {
        injectPersona(agent, target);
      } catch (error) {
        return { kind: "error", text: `切换失败：${String(error?.message ?? error)}` };
      }
      setPersona(target.id);
      return { kind: "success", text: target.switched };
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
    description: "载入指定编号对话：默认注入上下文（各版本通用），加 --hard 走真切换（需通道补丁）",
    handler: ({ agent, rawInput }) => {
      const raw = String(rawInput ?? "").trim();
      const hard = /(^|\s)--hard(\s|$)/.test(raw);
      const index = Number.parseInt(raw.replace(/--hard/g, "").trim(), 10);
      if (!Number.isInteger(index) || index < 1) {
        return { kind: "error", text: "用法：/load <编号> [--hard]；编号用 /sessions 查看。" };
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

      // —— 真切换：写请求文件，由通道插件在命令结束后执行换绑 ——
      if (hard) {
        if (!channelSupportsHardSwitch()) {
          return {
            kind: "error",
            text: [
              "当前微信通道插件没有「真切换」补丁，无法切会话。",
              "可改用 /load <编号>（注入上下文），或给通道打补丁后再试。",
            ].join("\n"),
          };
        }
        try {
          mkdirSync(dirname(PENDING_SWITCH_FILE), { recursive: true });
          writeFileSync(
            PENDING_SWITCH_FILE,
            JSON.stringify({ targetId: target.id, requestAt: new Date().toISOString(), by: "load" }),
            { mode: 0o600 }
          );
        } catch (error) {
          return { kind: "error", text: `写入切换请求失败：${String(error?.message ?? error)}` };
        }
        return { kind: "success", text: `正在真切换到「${target.title}」…下一条消息起就在那个会话里了。` };
      }

      // —— 默认：把目标会话的最近上下文注入当前会话（0.1/0.2 都可用） ——
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
        text: `已载入「${target.title}」的最近 ${body.length} 条消息（约 ${chars} 字）。真要切换会话用 /load ${index} --hard。`,
      };
    },
  });

  register({
    name: "version",
    description: "查看插件版本、会话根目录与通道补丁状态（自诊断）",
    handler: () => {
      const hard = channelSupportsHardSwitch();
      const lines = [
        `🐋 whale-commands${__versionSearch ? " " + __versionSearch.slice(1) : ""}`,
        "",
        `人物设状态：${activePersona() ? activePersona().name : "off"}`,
        `会话目录：${SESSIONS_ROOT}`,
        `真切换（/load --hard）：${hard ? "✅ 通道已打补丁" : "❌ 通道未打补丁（用默认 /load 注入上下文）"}`,
      ];
      return { kind: "success", text: lines.join("\n") };
    },
  });

  register({
    name: "style",
    description: "早间问候风格：auto 跟随人设 ｜ random 全员随机 ｜ imperial 朝堂风 ｜ <人设id> 固定",
    handler: ({ rawInput }) => {
      const FIXED = ["auto", "random", "imperial"];
      const ALL = [...FIXED, ...personaIds()];
      const labelOf = (mode) => {
        if (mode === "auto") return "auto（跟随当前人设；没开人设则全员随机）";
        if (mode === "random") return `全员随机（${PERSONAS.length} 个人设每天换一个）`;
        if (mode === "imperial") return "朝堂风（皇上／臣）";
        const p = resolvePersona(mode);
        return p ? `${p.emoji} ${p.name}` : mode;
      };
      const readMode = () => {
        try {
          const value = readFileSync(STYLE_FILE, "utf8").trim().toLowerCase();
          return ALL.includes(value) ? value : "auto";
        } catch {
          return "auto";
        }
      };
      const arg = String(rawInput ?? "").trim().toLowerCase();
      if (arg === "") {
        const current = readMode();
        const active = activePersona();
        return {
          kind: "success",
          text: [
            `当前问候风格：${labelOf(current)}`,
            `当前人设：${active ? `${active.emoji} ${active.name}（${active.id}）` : "无（默认口吻）"}`,
            "",
            "用法：",
            "/style auto — 跟随当前人设（人设关着就全员随机）",
            `/style random — ${PERSONAS.length} 个人设全员随机`,
            "/style imperial — 朝堂风（皇上／臣）",
            `/style <人设id> — 固定某个人设，如 /style maid（也可用编号 /style 2）`,
            "全部人设：/persona",
          ].join("\n"),
        };
      }
      // 数字编号也认：/style 3 → 第 3 个人设
      const resolved = FIXED.includes(arg) ? arg : resolvePersona(arg)?.id ?? "";
      if (!resolved) {
        return {
          kind: "error",
          text: `不认识「${arg}」。可选：auto、random、imperial，或人设 id（发 /persona 看全部 ${PERSONAS.length} 个）。`,
        };
      }
      try {
        writeFileSync(STYLE_FILE, resolved + "\n", "utf8");
      } catch (error) {
        return { kind: "error", text: `写入失败：${String(error?.message ?? error)}` };
      }
      const tail =
        resolved === "auto"
          ? "以后每天 7:00 跟着当前人设走。"
          : resolved === "random"
            ? `以后每天 7:00 从 ${PERSONAS.length} 个人设里随机抽一位。`
            : "以后每天 7:00 都用这个口吻。";
      return { kind: "success", text: `已设定：${labelOf(resolved)}。${tail}` };
    },
  });

  register({
    name: "token",
    description: "查看 token 用量、官方近 1 天 / 近 30 天花费与账户余额（接口异常自动回退本地统计）",
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
      const pct = (part, whole) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "—");

      // ── 0) 先查官方用量：成功则用它的单价，失败则回退本地统计 ──
      let official = null;
      let officialNote = "";
      const userToken = credentialValue("DEEPSEEK_USER_TOKEN");
      if (!userToken) {
        officialNote = "未配置 DEEPSEEK_USER_TOKEN，仅显示本地统计";
      } else {
        try {
          official = await officialUsageWindow(userToken, 30);
          if (!(official.cny > 0 || official.hit + official.miss + official.out > 0)) {
            officialNote = "官方接口可用，但近 30 天没有用量记录";
            official = null;
          } else {
            savePriceCache(official.prices);
          }
        } catch (error) {
          officialNote = `官方接口不可用（${String(error?.message ?? error)}），可能 userToken 已过期；已回退本地统计`;
          official = null;
        }
      }

      // 官方单价（元 / 百万 token）：优先本次实时拟合，其次上次缓存，最后内置默认
      const cachedPrices = readPriceCache();
      const flashPrice =
        official?.prices?.["deepseek-flash"] ??
        cachedPrices?.["deepseek-flash"] ??
        DEFAULT_UNIT_PRICES["deepseek-flash"];
      const yuan = (value) => `¥${value.toFixed(value < 0.01 ? 4 : 2)}`;
      /** 本地 usage（新增/缓存/输出）按官方 flash 单价折算成人民币。 */
      const cnyOfLocal = (usage) =>
        (usage.cacheRead * flashPrice.hit + usage.input * flashPrice.miss + usage.output * flashPrice.out) / 1e6;

      // ── 1) 本会话 ──
      try {
        const a = sumUsage(agent?.session?.events ?? []);
        const totalInput = a.input + a.cacheRead;
        lines.push("【本会话】");
        lines.push(`  请求 ${a.requests} 次 / 轮次 ${a.turns}`);
        lines.push(`  输入 ${fmtNumber(totalInput)}（缓存 ${fmtNumber(a.cacheRead)} / 新增 ${fmtNumber(a.input)}）`);
        lines.push(`  输出 ${fmtNumber(a.output)}（其中推理 ${fmtNumber(a.reasoning)}）`);
        lines.push(`  合计 ${fmtNumber(totalInput + a.output)} · 缓存命中率 ${pct(a.cacheRead, totalInput)}`);
        lines.push(`  估算花费 ${yuan(cnyOfLocal(a))}（官方 flash 单价）`);
      } catch (error) {
        lines.push("【本会话】读取失败：" + String(error?.message ?? error));
      }

      // ── 2) 官方数据（近 1 天 / 近 30 天）；拿不到就回退本地今日累计 ──
      if (official) {
        const t = official.today;
        lines.push("", `【官方近 1 天】${t.date}`);
        if (t.req > 0 || t.hit + t.miss + t.out > 0) {
          lines.push(
            `  请求 ${fmtNumber(t.req)} 次 · 输入 ${fmtNumber(t.hit + t.miss)}（缓存 ${fmtNumber(t.hit)} / 新增 ${fmtNumber(t.miss)}）`,
          );
          lines.push(`  输出 ${fmtNumber(t.out)} · 合计 ${fmtNumber(t.hit + t.miss + t.out)}`);
          lines.push(`  花费 ¥${t.cny.toFixed(2)}（官方账单）`);
        } else {
          lines.push("  今天还没有官方用量记录");
        }

        const totalInput = official.hit + official.miss;
        lines.push("", `【官方近 30 天】${official.startDay} ~ ${official.endDay}（${official.usedDays} 天有量）`);
        lines.push(`  请求 ${fmtNumber(official.req)} 次 · 缓存命中率 ${pct(official.hit, totalInput)}`);
        lines.push(`  输入 ${fmtNumber(totalInput)}（缓存 ${fmtNumber(official.hit)} / 新增 ${fmtNumber(official.miss)}）`);
        lines.push(`  输出 ${fmtNumber(official.out)} · 合计 ${fmtNumber(totalInput + official.out)}`);
        lines.push(`  花费 ¥${official.cny.toFixed(2)}（官方账单）`);
        lines.push(
          `  官方单价：缓存 ¥${flashPrice.hit}/M · 新增 ¥${flashPrice.miss}/M · 输出 ¥${flashPrice.out}/M`,
        );
      } else {
        // 回退：本地「今日累计」（所有微信会话），花费按官方单价估算
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
          lines.push("", `【今日累计】${dirs.length} 个会话（本地）`);
          if (dirs.length === 0) {
            lines.push("  今天还没有记录");
          } else {
            lines.push(`  输入 ${fmtNumber(totalInput)}（缓存 ${fmtNumber(today.cacheRead)} / 新增 ${fmtNumber(today.input)}）`);
            lines.push(`  输出 ${fmtNumber(today.output)}（其中推理 ${fmtNumber(today.reasoning)}）`);
            lines.push(`  合计 ${fmtNumber(totalInput + today.output)} · 缓存命中率 ${pct(today.cacheRead, totalInput)}`);
            lines.push(`  估算花费 ${yuan(cnyOfLocal(today))}（官方 flash 单价）`);
          }
        } catch (error) {
          lines.push("", "【今日累计】读取失败：" + String(error?.message ?? error));
        }
        if (officialNote) lines.push(`  （${officialNote}）`);
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
    name: "model",
    description: "查看 / 切换模型与思考强度：/model <模型>、/model effort <强度>、/model default <模型>",
    handler: ({ agent, rawInput }) => {
      const arg = String(rawInput ?? "").trim();
      const state = loadModelState();
      const agentId = String(agent?.id ?? "");
      const catalog = modelCatalog();

      /** 把选择同步给「本会话已经装好的切换器」（下一轮请求即生效）。 */
      const applyToAgent = (selection) => {
        const live = agentSelections.get(agentId);
        if (live !== undefined) live.current = selection ?? undefined;
        return live !== undefined;
      };
      const liveNote = (live) => (live ? "，下一轮请求生效喵" : "（本会话没装上切换器，新会话才生效）");

      const show = () => {
        const current = state.sessions[agentId] ?? state.default ?? null;
        return [
          "🐋 模型设置",
          `  本会话：${describeSelection(current)}`,
          `  /new 默认：${describeSelection(state.default)}`,
          "",
          "  可选模型：",
          ...catalog.map((m) => `    ${m.id} — ${m.name}`),
          `  思考强度：${EFFORTS.join(" / ")}`,
          "",
          "用法：",
          "  /model <模型>                 本会话立即切换",
          "  /model effort <强度>          本会话思考强度",
          "  /model default <模型>         /new 新会话默认模型",
          "  /model default effort <强度>  /new 默认思考强度",
          "  /model reset                  本会话恢复默认",
          "  /model reset default          清空 /new 默认",
        ].join("\n");
      };

      if (!arg) return { kind: "success", text: show() };

      const parts = arg.split(/\s+/);
      const head = parts[0].toLowerCase();
      const fallbackModel = catalog[0]?.id ?? "deepseek-flash";

      if (head === "reset") {
        if (parts[1]?.toLowerCase() === "default") {
          state.default = null;
          saveModelState(state);
          return { kind: "success", text: "已清空 /new 默认模型，之后新会话跟随宿主设置喵。" };
        }
        delete state.sessions[agentId];
        saveModelState(state);
        const live = applyToAgent(null);
        return { kind: "success", text: `已清除本会话的模型覆盖${liveNote(live)}。` };
      }

      if (head === "default") {
        const rest = parts.slice(1);
        if (rest.length === 0) {
          return {
            kind: "success",
            text: `当前 /new 默认：${describeSelection(state.default)}\n用 /model default <模型> 或 /model default effort <强度> 设置。`,
          };
        }
        const current = state.default ?? {};
        if (rest[0].toLowerCase() === "effort") {
          const effort = rest[1]?.toLowerCase();
          if (!EFFORTS.includes(effort)) {
            return { kind: "error", text: `思考强度只能是：${EFFORTS.join(" / ")}` };
          }
          state.default = {
            provider: current.provider ?? MODEL_PROVIDER,
            model: current.model ?? fallbackModel,
            reasoningEffort: effort,
          };
        } else {
          const model = resolveModel(rest[0]);
          if (model === undefined) {
            return { kind: "error", text: `不认识模型「${rest[0]}」。可选：${catalog.map((m) => m.id).join(" / ")}` };
          }
          state.default = {
            provider: MODEL_PROVIDER,
            model: model.id,
            ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}),
          };
        }
        saveModelState(state);
        return {
          kind: "success",
          text: `已设置 /new 默认：${describeSelection(state.default)}\n之后新建的会话都按它走；本会话要换请用 /model <模型>。`,
        };
      }

      if (head === "effort") {
        const effort = parts[1]?.toLowerCase();
        if (!EFFORTS.includes(effort)) {
          return { kind: "error", text: `思考强度只能是：${EFFORTS.join(" / ")}` };
        }
        const base = state.sessions[agentId] ?? state.default ?? { provider: MODEL_PROVIDER, model: fallbackModel };
        const next = { ...base, reasoningEffort: effort };
        state.sessions[agentId] = next;
        saveModelState(state);
        const live = applyToAgent(next);
        return { kind: "success", text: `本会话思考强度已设为 ${effort}${liveNote(live)}。` };
      }

      const model = resolveModel(head);
      if (model === undefined) {
        return {
          kind: "error",
          text: `不认识「${arg}」。可选：${catalog.map((m) => m.id).join(" / ")}；发 /model 看用法。`,
        };
      }
      const prev = state.sessions[agentId] ?? state.default ?? {};
      const next = {
        provider: MODEL_PROVIDER,
        model: model.id,
        ...(prev.reasoningEffort ? { reasoningEffort: prev.reasoningEffort } : {}),
      };
      state.sessions[agentId] = next;
      saveModelState(state);
      const live = applyToAgent(next);
      return { kind: "success", text: `本会话模型已切到 ${describeSelection(next)}${liveNote(live)}。` };
    },
  });

  register({
    name: "help",
    description: "命令菜单：/help 目录 · /help <group> 子菜单 · /help all 全部",
    handler: ({ agent, rawInput }) => {
      let list = [];
      try {
        list = ctx.commands.list(agent) ?? [];
      } catch {
        list = [];
      }
      const hidden = hiddenCommands();
      if (hidden.size > 0) list = list.filter((c) => !hidden.has(c.name));
      const names = list.map((c) => c.name);
      const desc = new Map(list.map((c) => [c.name, c.description]));
      const nowPersona = activePersona();
      const personaLabel = nowPersona ? `${nowPersona.emoji} ${nowPersona.name}（${nowPersona.id}）` : "off";

      const CHAT = ["new", "reset", "sessions", "load", "time", "token", "model", "style", "version", "help"];
      // 宿主自帶的命令（不是本插件註冊的），單獨一組，免得混進「扩展命令」
      const HARNESS = ["compact", "export", "feedback", "goal", "permission", "plan", "weixin-login", "weixin-logout"];
      const groups = [
        {
          key: "talk",
          title: "对话控制",
          items: CHAT.filter((n) => n !== "model")
            .filter((n) => n === "new" || n === "reset" || names.includes(n))
            .map((n) => ({
            name: n,
            desc:
              {
                new: "开始新会话（沿用当前人设）",
                reset: "同 /new",
                sessions: "列出最近 5 个微信对话",
                load: "载入该对话上下文（/load <编号>；加 --hard 真切换，需通道补丁）",
                time: "查看当前时间",
                token: "查看 token 用量、官方近 1 天 / 近 30 天花费与账户余额",
                model: "切换本会话模型 / 设置 /new 默认模型",
                style: "早间问候风格（auto 跟随人设 / random 全员随机 / imperial / <人设id>）",
                version: "插件版本与通道补丁自诊断",
                help: "本菜单",
              }[n] ?? "",
          })),
        },
        {
          key: "model",
          title: "模型",
          items: names
            .filter((n) => n === "model")
            .map((n) => ({ name: n, desc: desc.get(n) ?? "" })),
        },
        {
          key: "role",
          title: "人设",
          items: names
            .filter((n) => n === "persona" || n === "whale" || n === "normal")
            .map((n) => ({ name: n, desc: desc.get(n) ?? "" })),
        },
        {
          key: "ping",
          title: "通道检测",
          items: names.filter((n) => n.startsWith("bot-")).map((n) => ({ name: n, desc: desc.get(n) ?? "" })),
        },
        {
          key: "appr",
          title: "工具审批",
          items: names.filter((n) => n === "approve" || n === "reject").map((n) => ({ name: n, desc: desc.get(n) ?? "" })),
        },
        {
          key: "ext",
          title: "扩展命令",
          items: names
            .filter(
              (n) =>
                !CHAT.includes(n) &&
                n !== "whale" &&
                n !== "normal" &&
                n !== "persona" &&
                !n.startsWith("bot-") &&
                n !== "approve" &&
                n !== "reject" &&
                !HARNESS.includes(n) &&
                !n.startsWith("weixin-"),
            )
            .map((n) => ({ name: n, desc: desc.get(n) ?? "" })),
        },
        {
          key: "harness",
          title: "Harness 内置",
          items: names
            .filter((n) => HARNESS.includes(n) || n.startsWith("weixin-"))
            .map((n) => ({ name: n, desc: desc.get(n) ?? "" })),
        },
      ].filter((g) => g.items.length > 0);

      // 一條命令可以帶多行說明（description 內含 \n），第二行起縮排顯示
      const pushItem = (arr, item) => {
        const [head, ...more] = String(item.desc ?? "").split("\n");
        arr.push(`/${item.name}${head ? ` — ${head}` : ""}`);
        for (const line of more) if (line.trim()) arr.push(`    ${line}`);
      };

      const arg = String(rawInput ?? "").trim().toLowerCase();

      // /help all：全部命令逐条列出
      if (arg === "all" || arg === "full") {
        const lines = ["📖 all commands", ""];
        for (const g of groups) {
          lines.push(`【${g.title}】（/help ${g.key}）`);
          for (const item of g.items) pushItem(lines, item);
          lines.push("");
        }
        lines.push(`persona: ${personaLabel}`);
        return { kind: "success", text: lines.join("\n") };
      }

      // /help <group>：子菜单（支持首字母简写，如 /help t）
      if (arg) {
        const group =
          groups.find((g) => g.key === arg) ?? groups.find((g) => g.key[0] === arg) ??
          groups.find((g) => g.title === arg);
        if (group) {
          const lines = [`📂 ${group.title} · /help ${group.key}`, ""];
          for (const item of group.items) pushItem(lines, item);
          lines.push("", "回目录 /help ｜ 全部 /help all");
          return { kind: "success", text: lines.join("\n") };
        }
        const keys = groups.map((g) => g.key).join(" / ");
        return { kind: "error", text: `没有「${arg}」这组。可用：${keys}（或首字母）` };
      }

      // 默认：目录
      const lines = [`🤖 help · ${names.length} cmds · ${groups.length} groups`, ""];
      for (const g of groups) {
        lines.push(`/help ${g.key.padEnd(5)} ${g.title}（${g.items.length}）`);
      }
      lines.push("", `/help all 一次看全部 ｜ persona: ${personaLabel}`);
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
              appendFileSync(`${DSH_HOME}/.playground/whale-plugin.log`,
                `  register RETRY ok: ${definition.name} (+${delay}ms)\n`, "utf8");
            } catch { /* ignore */ }
          } catch (error) {
            stillFailing.push(definition);
            try {
              appendFileSync(`${DSH_HOME}/.playground/whale-plugin.log`,
                `  register RETRY failed: ${definition.name} (+${delay}ms): ${String(error?.message ?? error)}\n`, "utf8");
            } catch { /* ignore */ }
          }
        }
        pending.push(...stillFailing);
      }, delay);
    }
  }

  try {
    appendFileSync(`${DSH_HOME}/.playground/whale-plugin.log`,
      `  apply done: ok=${okCount} released=${released} pid=${process.pid}\n`, "utf8");
  } catch { /* ignore */ }

  ctx.on("agent/created", ({ agent }) => {
    if (!isWeixinAgent(agent)) return;
    // 模型切换器：独立于人设开关，人设关掉也要能用 /model
    installAgentModelSelection(agent, agentSelections);
    // 人设：新会话继承「当前启用的人设」，不再固定注入鲸鱼娘
    const persona = activePersona();
    if (!persona) return;
    const agentId = String(agent?.id ?? "");

    try {
      injectPersona(agent, persona);
    } catch (error) {
      pluginNote(`inject-on-create FAILED for ${agentId}: ${String(error?.message ?? error)}`);
      return;
    }

    // 注入后按「真新会话 / 旧会话重开」推一条不同口气的提示，并留审计痕迹。
    let judged;
    try {
      judged = judgeAgentCreate(agentId);
    } catch (error) {
      pluginNote(`judge-on-create FAILED for ${agentId}: ${String(error?.message ?? error)}`);
      judged = { verdict: "revisit", generation: generationOf(agentId), maxGeneration: -1, known: false, dirAgeMs: null };
    }

    const text = noticeFor(judged.verdict === "new" ? "new" : "back", persona);
    // 审计日志：id / 后代编号 / 判定 / 目录年龄，下次出问题直接看这条
    pluginNote(
      `notice ${new Date().toISOString()} id=${agentId} persona=${persona.id} gen=${judged.generation} max=${judged.maxGeneration} ` +
        `verdict=${judged.verdict} known=${judged.known} dirAgeMs=${judged.dirAgeMs ?? "?"}`,
    );

    // 节流 1：同一个会话 60 秒内最多推一条，避免重连抖动时刷屏（人设注入不受影响）
    const now = Date.now();
    const last = lastNoticeAt.get(agentId) ?? 0;
    if (now - last < 60_000) {
      pluginNote(`notice SKIP(60s throttle) id=${agentId}`);
      return;
    }

    // 节流 2：/new 会把旧会话一起唤醒，别在「新会话开好啦」之后再补一条「连接抖了一下」。
    // 120 秒窗口内，revisit 判定一律静默（真重连不会紧跟 /new 发生，不会误伤）。
    if (judged.verdict === "revisit" && noticeWindow.verdict === "new" && now - noticeWindow.at < 120_000) {
      pluginNote(
        `notice SKIP(quiet-after-new ${Math.round((now - noticeWindow.at) / 1000)}s) ` +
          `id=${agentId} gen=${judged.generation}`,
      );
      return;
    }

    lastNoticeAt.set(agentId, now);
    noticeWindow.at = now;
    noticeWindow.verdict = judged.verdict;

    Promise.resolve()
      .then(() => pushText(text))
      .then((result) => {
        if (!result?.ok) {
          pluginNote(`notice SEND FAILED id=${agentId}: ${JSON.stringify(result)}`);
          ctx.logger?.warn?.("whale-persona-command: notify failed: %s", JSON.stringify(result));
        }
      })
      .catch((error) => {
        pluginNote(`notice SEND THREW id=${agentId}: ${String(error?.message ?? error)}`);
        ctx.logger?.warn?.("whale-persona-command: notify threw: %s", String(error));
      });
  });
}
