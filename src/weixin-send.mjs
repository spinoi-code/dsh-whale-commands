/**
 * 微信主动推送模块 —— 供插件复用（插件内通知、外部脚本都可调）。
 *
 * 用官方 iLink bot sendmessage 接口，context_token 可选，因此无需入站消息即可推送。
 * 凭据从 ~/.dsh/.credentials.yaml 读取，每次调用重新读取，所以重登后自动用新 token。
 *
 * 安全：从不打印或返回 token / 完整凭据。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
const CRED_FILE = process.env.WEIXIN_CRED_FILE || join(DSH_HOME, ".credentials.yaml");
const CRED_KEY = "WEIXIN_ILINK_CREDENTIAL";

// ── 官方协议常量（与 deepseek-harness-weixin@0.2.5 一致） ──
const CHANNEL_VERSION = "0.2.5";
const BOT_AGENT = "DeepSeek-Harness/0.2.5";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const ITEM_TEXT = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const TIMEOUT_MS = 15000;

/** 从 .credentials.yaml 取出 iLink 凭据。不打印任何字段值。 */
export function loadCredential() {
  const text = readFileSync(CRED_FILE, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.trimStart().startsWith(CRED_KEY + ":"));
  if (!line) throw new Error(`凭据文件里没有 ${CRED_KEY}`);

  let value = line.slice(line.indexOf(":") + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }

  const parsed = JSON.parse(value);
  for (const k of ["token", "accountId", "baseUrl", "userId"]) {
    if (typeof parsed[k] !== "string" || parsed[k].trim() === "") {
      throw new Error(`凭据缺少字段 ${k}`);
    }
  }
  return parsed;
}

function headers(token) {
  const uin = randomBytes(4).readUInt32BE(0);
  return {
    "Content-Type": "application/json",
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": Buffer.from(String(uin)).toString("base64"),
  };
}

/** 主动推送一条文本。返回 { ok, httpStatus }，不抛异常。 */
export async function sendText(text, credential) {
  const cred = credential ?? loadCredential();
  const url = new URL(
    "ilink/bot/sendmessage",
    cred.baseUrl.replace(/\/+$/, "") + "/",
  ).toString();
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: cred.userId,
      client_id: `dsh-plugin:${Date.now()}-${randomBytes(4).toString("hex")}`,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text } }],
    },
    base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: headers(cred.token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await res.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* 非 JSON */
    }
    const code = data?.errcode ?? data?.ret ?? 0;
    return { ok: res.ok && code === 0, httpStatus: res.status, code };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
