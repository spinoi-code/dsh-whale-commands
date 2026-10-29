#!/usr/bin/env node
/**
 * 共享文件服务 —— 给主人「限时 + 带令牌」的 HTTPS 下载链接，支持多条分享并存。
 * 替代微信通道直发大文件（iLink 单文件 30MB 上限，27MB 都会 CDN 500）。
 *
 * 组成：
 *   常驻 daemon（默认 127.0.0.1:8796） + 状态文件 <DSH_HOME>/.share-file/shares.json
 *   对外由你自己的 HTTPS 反代（如 Caddy 的 handle_path /s/* → 127.0.0.1:8796）
 *
 * CLI：
 *   node tools/share-file.mjs add <文件> [--ttl 30] [--max-downloads 3] [--name 显示名]
 *   node tools/share-file.mjs list [--json]
 *   node tools/share-file.mjs stop <id|all>
 *   node tools/share-file.mjs status
 *   node tools/share-file.mjs daemon [--port 8796]     # 前台跑（由 add 自动拉起）
 *
 * 安全模型（缺一不可）：
 *   1. 每条分享只对应命令行显式指定的**一个文件**（路径存状态文件，绝不接用户输入）
 *   2. URL 带 32 字节随机令牌；无令牌 / 错令牌 / 越权路径一律 404
 *   3. 每条分享独立 限时（默认 30 分钟）+ 限次（默认 3 次），到期或用尽自动删除
 *   4. 只监听 127.0.0.1，对外必须经 Caddy 的 HTTPS
 *   5. 只接受 GET / HEAD；响应带 nosniff + attachment；不列目录
 *   6. 访问日志 .share-file/access.log 只记时间/IP/方法/状态/耗时/UA，**不记令牌全文**
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile, writeFile, rename, appendFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';

const WORKSPACE = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
const STATE_DIR = process.env.SHARE_STATE_DIR?.trim() || join(WORKSPACE, '.share-file');
const SHARES_FILE = join(STATE_DIR, 'shares.json');
const ACCESS_LOG = join(STATE_DIR, 'access.log');
const DEFAULT_PORT = Number(process.env.SHARE_PORT) || 8796;
/** 对外链接前缀：自建反代时设 SHARE_PUBLIC_BASE=https://your.domain/s；不设则只有本机能打开。 */
const DEFAULT_PUBLIC_BASE =
  process.env.SHARE_PUBLIC_BASE?.trim().replace(/\/+$/, '') || `http://127.0.0.1:${DEFAULT_PORT}`;
const IDLE_EXIT_MS = 15 * 60_000;

const MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.ts': 'video/mp2t', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};

async function readShares() {
  try {
    const parsed = JSON.parse(await readFile(SHARES_FILE, 'utf8'));
    return Array.isArray(parsed?.shares) ? parsed.shares : [];
  } catch {
    return [];
  }
}

async function writeShares(shares) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = SHARES_FILE + '.' + process.pid + '.tmp';
  await writeFile(tmp, JSON.stringify({ shares }, null, 1) + '\n', { mode: 0o600 });
  await rename(tmp, SHARES_FILE);
}

async function logLine(line) {
  try {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    await appendFile(ACCESS_LOG, new Date().toISOString() + ' ' + line + '\n');
  } catch { /* 日志失败不影响下载 */ }
}

const publicUrl = (token, name) => DEFAULT_PUBLIC_BASE.replace(/\/+$/, '') + '/' + token + '/' + encodeURIComponent(name);
const newId = () => randomBytes(4).toString('hex');
const newToken = () => randomBytes(32).toString('base64url');

function fmtRemain(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return '已过期';
  const min = Math.round(ms / 60000);
  return min >= 60 ? Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分' : min + ' 分钟';
}

async function daemonAlive(port = DEFAULT_PORT) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/healthz', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data?.service === 'share-file';
  } catch { return false; }
}

async function ensureDaemon(port = DEFAULT_PORT) {
  if (await daemonAlive(port)) return 'already-running';
  const child = spawn(process.execPath, [process.argv[1], 'daemon', '--port', String(port)], {
    detached: true, stdio: 'ignore', cwd: WORKSPACE,
  });
  child.unref();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (await daemonAlive(port)) return 'started';
  }
  return 'starting';
}

async function cmdAdd(argv) {
  const pos = [];
  const opts = { ttl: 30, maxDownloads: 3, name: undefined, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const nextVal = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(a + ' 缺少取值');
      i += 1; return v;
    };
    if (a === '--ttl') opts.ttl = Number(nextVal());
    else if (a === '--max-downloads') opts.maxDownloads = Number(nextVal());
    else if (a === '--name') opts.name = nextVal();
    else if (a === '--port') opts.port = Number(nextVal());
    else if (a.startsWith('--')) throw new Error('未知参数 ' + a);
    else pos.push(a);
  }
  const target = pos[0];
  if (!target) throw new Error('用法: add <文件路径> [--ttl 30] [--max-downloads 3] [--name 显示名]');

  const abs = resolve(WORKSPACE, target);
  const info = await stat(abs).catch(() => null);
  if (!info || !info.isFile()) throw new Error('文件不存在或不是普通文件: ' + target);
  if (info.size === 0) throw new Error('空文件没有分享的意义');
  if (!Number.isFinite(opts.ttl) || opts.ttl <= 0) throw new Error('--ttl 必须是正数（分钟）');
  if (!Number.isInteger(opts.maxDownloads) || opts.maxDownloads <= 0) throw new Error('--max-downloads 必须是正整数');

  const displayName = opts.name?.trim() || basename(abs);
  const shares = await readShares();
  const same = shares.find((s) => s.path === abs && new Date(s.expiresAt).getTime() > Date.now());
  if (same) {
    await ensureDaemon(opts.port);
    console.log(JSON.stringify({
      ok: true, reused: true, id: same.id, url: publicUrl(same.token, same.name),
      name: same.name, bytes: same.size, expiresAt: same.expiresAt,
      remain: fmtRemain(same.expiresAt), downloads: same.downloads + '/' + same.maxDownloads,
    }, null, 1));
    return;
  }
  const share = {
    id: newId(), token: newToken(), path: abs, name: displayName, size: info.size,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + opts.ttl * 60_000).toISOString(),
    ttlMinutes: opts.ttl, maxDownloads: opts.maxDownloads, downloads: 0,
  };
  shares.push(share);
  await writeShares(shares);
  const state = await ensureDaemon(opts.port);
  console.log(JSON.stringify({
    ok: true, reused: false, id: share.id, url: publicUrl(share.token, share.name),
    name: share.name, bytes: share.size, ttlMinutes: share.ttlMinutes,
    maxDownloads: share.maxDownloads, expiresAt: share.expiresAt,
    remain: fmtRemain(share.expiresAt), daemon: state,
  }, null, 1));
}

async function cmdList(argv) {
  const asJson = argv.includes('--json');
  const live = (await readShares()).filter((s) => new Date(s.expiresAt).getTime() > Date.now());
  if (asJson) {
    console.log(JSON.stringify({ ok: true, shares: live.map((s) => ({
      id: s.id, name: s.name, bytes: s.size, url: publicUrl(s.token, s.name),
      expiresAt: s.expiresAt, remain: fmtRemain(s.expiresAt),
      downloads: s.downloads + '/' + s.maxDownloads,
    })) }, null, 1));
    return;
  }
  if (live.length === 0) {
    console.log('当前没有进行中的分享。');
    return;
  }
  const lines = live.map((s, i) => {
    const mb = (s.size / 1024 / 1024).toFixed(1);
    return (i + 1) + '. [' + s.id + '] ' + s.name + '  ' + mb + 'MB\n   ' + publicUrl(s.token, s.name)
      + '\n   剩余 ' + fmtRemain(s.expiresAt) + ' / 已下 ' + s.downloads + '/' + s.maxDownloads + ' 次';
  });
  console.log('进行中的分享（' + live.length + ' 条）：\n\n' + lines.join('\n\n'));
}

async function cmdStop(argv) {
  const target = String(argv[0] ?? '').trim();
  if (!target) throw new Error('用法: stop <id|all>');
  const shares = await readShares();
  if (target === 'all') {
    await writeShares([]);
    console.log('已停止全部 ' + shares.length + ' 条分享（链接立即失效）');
    return;
  }
  const hit = shares.find((s) => s.id === target);
  if (!hit) throw new Error('没有 id 为 ' + target + ' 的分享（用 list 看当前有哪些）');
  await writeShares(shares.filter((s) => s.id !== target));
  console.log('已停止 [' + hit.id + '] ' + hit.name + '，链接立即失效');
}

async function cmdStatus(argv) {
  const pi = argv.indexOf('--port');
  const port = pi >= 0 ? Number(argv[pi + 1]) || DEFAULT_PORT : DEFAULT_PORT;
  const alive = await daemonAlive(port);
  const shares = await readShares();
  console.log(JSON.stringify({ ok: true, daemon: alive ? 'running' : 'stopped', port, shares: shares.length }, null, 1));
}

async function cmdDaemon(argv) {
  const pi = argv.indexOf('--port');
  const port = pi >= 0 ? Number(argv[pi + 1]) || DEFAULT_PORT : DEFAULT_PORT;

  let live = new Map();
  const startedAt = Date.now();
  let lastHit = Date.now();

  async function reload() {
    const shares = await readShares();
    const now = Date.now();
    const keep = [];
    for (const s of shares) {
      const expired = new Date(s.expiresAt).getTime() <= now;
      const exhausted = s.downloads >= s.maxDownloads;
      if (expired || exhausted) {
        void logLine('条目失效 [' + s.id + '] ' + s.name + '（' + (expired ? '到期' : '次数用尽') + '）');
        continue;
      }
      keep.push(s);
    }
    if (keep.length !== shares.length) await writeShares(keep);
    live = new Map(keep.map((s) => [s.token, s]));
  }

  await reload();
  setInterval(() => {
    void reload();
    if (live.size === 0 && Date.now() - Math.max(lastHit, startedAt) > IDLE_EXIT_MS) {
      void logLine('空闲超时，daemon 退出');
      process.exit(0);
    }
  }, 2000).unref();

  const deny = (res, status, message) => {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    res.end(message);
  };

  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?').split(',')[0].trim();
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 70);
    const record = (result) => void logLine(ip + ' ' + req.method + ' ' + result + ' ' + (Date.now() - t0) + 'ms ' + ua);

    try {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ service: 'share-file', shares: live.size, pid: process.pid }));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        record('405'); return deny(res, 405, 'Method Not Allowed');
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      const share = parts[0] ? live.get(parts[0]) : undefined;
      if (!share) { record('404'); return deny(res, 404, 'Not Found'); }

      const info = await stat(share.path).catch(() => null);
      if (!info || !info.isFile()) { record('410-missing'); return deny(res, 410, '文件已不可用'); }
      if (share.downloads >= share.maxDownloads) { record('429-limit'); return deny(res, 429, '下载次数已用完'); }

      let start = 0;
      let end = info.size - 1;
      let status = 200;
      const range = req.headers.range;
      if (typeof range === 'string') {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m) {
          if (m[1] !== '') start = Number(m[1]);
          if (m[2] !== '') end = Number(m[2]);
          if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= info.size) {
            record('416');
            res.writeHead(416, { 'content-range': 'bytes */' + info.size });
            return res.end();
          }
          end = Math.min(end, info.size - 1);
          status = 206;
        }
      }

      share.downloads += 1;
      lastHit = Date.now();
      const total = share.downloads;
      const max = share.maxDownloads;
      record(status + ' bytes=' + (end - start + 1) + ' dl=' + total + '/' + max);

      const ext = share.name.slice(share.name.lastIndexOf('.')).toLowerCase();
      res.writeHead(status, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': String(end - start + 1),
        'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(share.name),
        'accept-ranges': 'bytes',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        ...(status === 206 ? { 'content-range': 'bytes ' + start + '-' + end + '/' + info.size } : {}),
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        const stream = createReadStream(share.path, { start, end });
        stream.on('error', () => {
          if (!res.headersSent) deny(res, 500, '读取失败');
          else res.destroy();
        });
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      }

      const shares = await readShares();
      const idx = shares.findIndex((s) => s.id === share.id);
      if (idx >= 0) {
        shares[idx].downloads = total;
        await writeShares(shares);
      }
      if (total >= max) void reload();
    } catch (error) {
      record('500 ' + (error?.message ?? error));
      if (!res.headersSent) deny(res, 500, 'Internal Error');
      else res.destroy();
    }
  });

  server.listen(port, '127.0.0.1', () => {
    void logLine('daemon 启动 port=' + port + ' shares=' + live.size + ' pid=' + process.pid);
  });
  server.on('error', (error) => {
    void logLine('daemon 启动失败 ' + (error?.message ?? error));
    process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      void logLine('daemon 收到 ' + sig + '，退出');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'add') await cmdAdd(rest);
  else if (cmd === 'list') await cmdList(rest);
  else if (cmd === 'stop') await cmdStop(rest);
  else if (cmd === 'status') await cmdStatus(rest);
  else if (cmd === 'daemon') await cmdDaemon(rest);
  else {
    console.log([
      '共享文件服务（限时带令牌的 HTTPS 下载链接）',
      '',
      '  add <文件> [--ttl 30] [--max-downloads 3] [--name 显示名]',
      '  list [--json]',
      '  stop <id|all>',
      '  status',
      '  daemon [--port 8796]',
      '',
      '微信里直接用 /share 命令更省事。',
    ].join('\n'));
    process.exit(cmd ? 2 : 0);
  }
} catch (error) {
  console.error('错误:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
