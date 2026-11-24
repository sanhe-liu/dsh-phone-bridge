// DSH 手机桥 —— 把只监听 127.0.0.1 的 DSH 桌面 Web GUI 安全地开放给局域网/手机。
//
// 用法：
//   node bridge.mjs                       # 默认 8090，口令自动读/生成 bridge.pass.txt
//   node bridge.mjs --port 8090 --bind 0.0.0.0 --dsh-port auto
//
// 可选参数：
//   --pass <口令>      访问口令；省略时读取同目录 bridge.pass.txt（不存在则生成）
//   --port <端口>      监听端口，默认 8090
//   --bind <地址>      监听地址，默认 0.0.0.0；只给局域网用可写本机 IP
//   --dsh-port <n>     上游 DSH 端口，默认 auto（自动探测正在运行的桌面实例）
//
// 原理：DSH 的会话 cookie 是 HMAC 签名的，密钥持久化在 $DSH_HOME/.credentials.yaml，
//       因此本桥可以离线签出合法 cookie 注入上游，不需要 DSH 启动 token。
// 安全：只放行内网 / Tailscale / Cloudflare 隧道来源；?k= 口令换 cookie，错 5 次锁 15 分钟。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createGzip, gzipSync } from 'node:zlib';

// ---------- 参数 ----------
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const PASS_FILE = path.join(SCRIPT_DIR, 'bridge.pass.txt');
function resolvePass() {
  const fromArg = opt('pass', '');
  if (fromArg) return fromArg;
  try {
    const saved = fs.readFileSync(PASS_FILE, 'utf8').trim();
    if (saved.length >= 6) return saved;
  } catch {
    // 文件不存在，下面生成
  }
  const generated = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(PASS_FILE, generated + '\r\n', 'utf8');
  console.log(`已生成访问口令并保存到 ${PASS_FILE}`);
  return generated;
}
const PASS = resolvePass();
const LISTEN_PORT = Number(opt('port', '8090'));
const BIND = opt('bind', '0.0.0.0');
const DSH_PORT_ARG = opt('dsh-port', 'auto');

if (!PASS || PASS.length < 6) {
  console.error('错误：口令太短（至少 6 位），否则桥等于对局域网完全敞开。');
  process.exit(2);
}

// ---------- 1. 探测 DSH 端口 ----------
function netstatListeners() {
  const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ addr: m[1], port: Number(m[2]), pid: Number(m[3]) });
  }
  return rows;
}

function probeDsh(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 400) body += c; });
        res.on('end', () =>
          resolve(res.statusCode === 401 && /dsh web authentication required/.test(body)),
        );
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function scanForDsh() {
  // netstat 不可用（受限环境禁止 spawn 子进程）时的兜底：并发探测本机回环端口。
  const candidates = [];
  for (let p = 49152; p <= 65535; p++) candidates.push(p);
  for (let p = 3000; p <= 3100; p++) candidates.push(p);
  const CONCURRENCY = 600;
  let found = 0;
  for (let i = 0; i < candidates.length && !found; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const hits = await Promise.all(batch.map(async (p) => ((await probeDsh(p, 250)) ? p : 0)));
    found = hits.find((p) => p > 0) ?? 0;
  }
  return found;
}

async function detectDshPort() {
  if (DSH_PORT_ARG !== 'auto') return Number(DSH_PORT_ARG);
  try {
    const rows = netstatListeners().filter(
      (r) => r.addr === '127.0.0.1' || r.addr === '0.0.0.0' || r.addr === '[::1]',
    );
    const ports = [...new Set(rows.map((r) => r.port))];
    for (const p of ports) {
      if (await probeDsh(p)) return p;
    }
  } catch {
    // 忽略，走端口扫描
  }
  return scanForDsh();
}

// 开机自启时 DSH 桌面版可能还没起来：等它一会儿，而不是直接退出。
async function waitForDsh(timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let told = false;
  for (;;) {
    const p = await detectDshPort();
    if (p) return p;
    if (!told) {
      console.log('暂时没探测到 DSH Web 服务，先等着；桌面版启动后会自动接管（最多等 15 分钟）。');
      told = true;
    }
    if (Date.now() > deadline) return 0;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

let DSH_PORT = await waitForDsh();
if (!DSH_PORT) {
  console.error('错误：15 分钟内没找到运行中的 DSH Web 服务（请先打开 DeepSeek Harness 桌面版）。');
  process.exit(3);
}

// ---------- 2. 读取持久化密钥，签出 DSH 会话 cookie ----------
function readSecret() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(home, '.credentials.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const m = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{20,})/.exec(text);
  if (!m) throw new Error(`在 ${file} 里找不到 client-connection/browser-session 的 secret`);
  return Buffer.from(m[1], 'base64url');
}
const DSH_SECRET = readSecret();

const b64u = (b) => Buffer.from(b).toString('base64url');
function dshCookie(authority, days = 30) {
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + days * 86400_000 };
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', DSH_SECRET).update(body).digest();
  const name = 'dsh-auth-' + b64u(crypto.createHash('sha256').update(authority).digest());
  return `${name}=v1.${body}.${b64u(mac)}`;
}
let AUTHORITY = `127.0.0.1:${DSH_PORT}`;
let UPSTREAM_COOKIE = dshCookie(AUTHORITY);

// DSH 桌面版重启后端口可能变化：上游不可达时重新探测一次，并重签对应 authority 的 cookie。
let refreshing = null;
async function refreshUpstream() {
  if (!refreshing) {
    refreshing = (async () => {
      const p = await detectDshPort();
      if (p && p !== DSH_PORT) {
        DSH_PORT = p;
        AUTHORITY = `127.0.0.1:${p}`;
        UPSTREAM_COOKIE = dshCookie(AUTHORITY);
        console.log(`上游端口已更新为 ${p}`);
      }
      return Boolean(p);
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

// ---------- 3. 桥自己的口令 cookie ----------
const BRIDGE_COOKIE = 'dsh-bridge';
const TOKEN = crypto.createHmac('sha256', PASS).update('dsh-bridge-v2').digest('base64url');
function tokenOk(v) {
  if (!v) return false;
  const a = Buffer.from(v);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------- 3.2 公网暴露时的护栏 ----------
// (a) 只认两种来源：局域网/本机直连，或经 Cloudflare 隧道进来的请求。
//     即使哪天路由器被错配了端口映射，公网直接打 8090 也会被拒。
// (b) ?k= 口令错误连续 5 次 → 该 IP 锁 15 分钟，并记进 bridge-auth.log。
const AUTH_LOG = path.join(SCRIPT_DIR, 'bridge-auth.log');
const PASS_HASH = crypto.createHash('sha256').update(PASS).digest();
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 10 * 60_000;
const LOCK_MS = 15 * 60_000;
const attempts = new Map(); // ip -> { count, first, until }

function passOk(v) {
  const a = crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(a, PASS_HASH);
}

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf);
  const ra = String(req.socket.remoteAddress || '');
  return ra.replace(/^::ffff:/, '');
}

function isPrivateIp(ip) {
  return (
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith('169.254.') ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || // Tailscale CGNAT 100.64.0.0/10
    /^fd7a:115c:a1e0/i.test(ip) || // Tailscale IPv6 fd7a:115c:a1e0::/48
    /^(fc|fd|fe80)/i.test(ip)
  );
}

function viaTunnel(req) {
  return Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

// 直连（socket 对端）不是内网地址、也没有 Cloudflare 头 → 拒绝
function peerAllowed(req) {
  const ra = String(req.socket.remoteAddress || '');
  if (viaTunnel(req)) return true;
  return isPrivateIp(ra.replace(/^::ffff:/, ''));
}

function authLog(line) {
  try {
    fs.appendFileSync(AUTH_LOG, `${new Date().toISOString()} ${line}\r\n`, 'utf8');
  } catch {
    // 忽略
  }
}

function lockLeft(ip) {
  const rec = attempts.get(ip);
  if (!rec || !rec.until) return 0;
  const left = rec.until - Date.now();
  return left > 0 ? left : 0;
}

function noteFailure(ip) {
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || now - rec.first > FAIL_WINDOW_MS) rec = { count: 0, first: now, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILS) {
    rec.until = now + LOCK_MS;
    authLog(`${ip} LOCKED after ${rec.count} wrong-pass attempts`);
    rec.count = 0;
    rec.first = now;
  } else {
    authLog(`${ip} wrong-pass (${rec.count}/${MAX_FAILS})`);
  }
  attempts.set(ip, rec);
}

function noteSuccess(ip) {
  const rec = attempts.get(ip);
  if (rec) {
    attempts.delete(ip);
    if (rec.count > 0) authLog(`${ip} authenticated`);
  }
}

// ---------- 3.5 手机窄屏增强：往 HTML 里塞一段样式表 ----------
const MOBILE_CSS_FILE = path.join(SCRIPT_DIR, 'mobile.css');
// 手机端补三件事：
// 1) viewport 加 interactive-widget=resizes-content：键盘弹出时布局视口跟着缩，
//    否则 composer 停在屏幕底部、被键盘盖住，看起来就是“底下空一大片”；
// 2) 我们的样式表（改样式要同步改版本号，避免手机用缓存里的旧样式）；
// 3) visualViewport 兜底：老浏览器不认 interactive-widget 时，
//    把 --dsh-mobile-vh 设成可视高度，mobile.css 里会让外框跟着缩。
const MOBILE_TAG = [
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">',
  '<link rel="stylesheet" href="/__mobile.css?v=3">',
  '<script>(function(){var v=window.visualViewport;if(!v)return;var s=document.documentElement.style,t=0;function a(){t=0;s.setProperty("--dsh-mobile-vh",Math.round(v.height)+"px")}function q(){if(!t)t=setTimeout(a,50)}v.addEventListener("resize",q);v.addEventListener("scroll",q);a()})();</script>',
].join('');
const MOBILE_OFF_COOKIE = 'dshm';

function readMobileCss() {
  try {
    return fs.readFileSync(MOBILE_CSS_FILE);
  } catch {
    return null;
  }
}

// 把上游 HTML 里的 </head> 前插入我们的 <link>；顺便把 lang 改成 zh-CN
// （前端写的是 lang="en"，手机浏览器会以为这是英文页面而弹翻译条）
function injectMobile(html, on) {
  if (!on) return html;
  let out = html.replace(/<html([^>]*?)\slang="en"/i, '<html$1 lang="zh-CN"');
  if (!readMobileCss()) return out;
  const i = out.search(/<\/head\s*>/i);
  if (i < 0) return MOBILE_TAG + out;
  return out.slice(0, i) + MOBILE_TAG + out.slice(i);
}

// 手机样式默认开；访问过一次 ?m=0 后该浏览器不再注入（cookie 记住），?m=1 恢复
function mobileEnabled(req) {
  return parseCookies(req.headers.cookie)[MOBILE_OFF_COOKIE] !== '1';
}

// ---------- 4. 转发 ----------
// 上游（DSH 自己的 http 服务）不压缩正文，也不给 /assets 长缓存。
// 手机走 4G 时首屏要拉 ~1.8MB 未压缩 JS，这是"要等两秒"的主因，这里补齐。
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|xml|manifest)|image\/svg)/i;

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}

function upstreamHeaders(req) {
  const headers = { ...req.headers };
  headers.host = AUTHORITY;
  headers.cookie = UPSTREAM_COOKIE;
  // 不转发压缩协商：HTML 要改写，必须是明文，否则还要解压一遍
  delete headers['accept-encoding'];
  if (headers.origin) headers.origin = `http://${AUTHORITY}`;
  if (headers.referer) headers.referer = `http://${AUTHORITY}/`;
  for (const k of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded']) {
    delete headers[k];
  }
  return headers;
}

function sendUpstream(req, res, retried = false) {
  const up = http.request(
    { host: '127.0.0.1', port: DSH_PORT, path: req.url, method: req.method, headers: upstreamHeaders(req) },
    (upRes) => {
      const type = String(upRes.headers['content-type'] || '');
      const status = upRes.statusCode || 502;
      const plainHtml =
        req.method === 'GET' && type.includes('text/html') && !upRes.headers['content-encoding'];
      const headers = { ...upRes.headers };
      // Vite 产物 /assets/* 文件名带内容哈希，可以放心长缓存，省掉每次打开的回源校验往返
      if (String(req.url || '').split('?')[0].startsWith('/assets/')) {
        headers['cache-control'] = 'public, max-age=31536000, immutable';
      }
      const canZip =
        req.method !== 'HEAD' &&
        status !== 304 &&
        !upRes.headers['content-encoding'] &&
        acceptsGzip(req) &&
        COMPRESSIBLE.test(type);
      if (!plainHtml) {
        if (canZip) {
          delete headers['content-length'];
          headers['content-encoding'] = 'gzip';
          headers['vary'] = 'Accept-Encoding';
          res.writeHead(status, headers);
          const gz = createGzip({ level: 6 });
          upRes.on('error', () => res.destroy());
          gz.on('error', () => res.destroy());
          upRes.pipe(gz).pipe(res);
        } else {
          res.writeHead(status, headers);
          upRes.pipe(res);
        }
        return;
      }
      // HTML：收全 → 插入手机样式表 → 重算 length
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        try {
          const html = injectMobile(Buffer.concat(chunks).toString('utf8'), mobileEnabled(req));
          const body = Buffer.from(html, 'utf8');
          const h2 = { ...upRes.headers };
          delete h2['transfer-encoding'];
          delete h2['content-encoding'];
          h2['cache-control'] = 'no-store';
          let out = body;
          if (acceptsGzip(req)) {
            out = gzipSync(body);
            h2['content-encoding'] = 'gzip';
            h2['vary'] = 'Accept-Encoding';
          }
          h2['content-length'] = String(out.length);
          res.writeHead(status, h2);
          res.end(out);
        } catch {
          res.destroy();
        }
      });
      upRes.on('error', () => res.destroy());
    },
  );
  up.on('error', async (e) => {
    if (!retried && e.code === 'ECONNREFUSED' && (await refreshUpstream())) {
      sendUpstream(req, res, true);
      return;
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`上游 DSH 不可达：${e.message}\n`);
    } else res.destroy();
  });
  req.pipe(up);
}

const server = http.createServer((req, res) => {
  const ip = clientIp(req);

  // 护栏 1：公网直连（既不是内网、也没有 Cloudflare 隧道头）一律拒
  if (!peerAllowed(req)) {
    authLog(`${ip} BLOCKED non-tunnel external peer ${req.socket.remoteAddress}`);
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('403 只允许局域网或 Cloudflare 隧道访问\n');
    return;
  }

  // 护栏 2：口令爆破锁定
  const left = lockLeft(ip);
  if (left > 0) {
    res.writeHead(429, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(Math.ceil(left / 1000)),
    });
    res.end(`429 尝试太多次，${Math.ceil(left / 60000)} 分钟后再试。\n`);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const provided = url.searchParams.get('k');

  // ?k=口令 → 换成 cookie 并跳回干净地址
  if (provided !== null) {
    if (!passOk(provided)) {
      noteFailure(ip);
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('401 口令不对\n');
      return;
    }
    noteSuccess(ip);
    url.searchParams.delete('k');
    const clean = url.pathname + (url.search ? url.search : '');
    res.writeHead(303, {
      location: clean || '/',
      'set-cookie': `${BRIDGE_COOKIE}=${TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }

  if (!tokenOk(parseCookies(req.headers.cookie)[BRIDGE_COOKIE])) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('DSH 手机桥：需要口令。请用带 ?k=<口令> 的完整地址打开一次。\n');
    return;
  }

  // 给手机传安装包：GET /apk/<name>.apk，只认本目录 apk/ 里已存在的包
  if (url.pathname.startsWith('/apk/')) {
    const name = url.pathname.slice('/apk/'.length);
    const dir = path.join(SCRIPT_DIR, 'apk');
    const file = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(file); } catch { /* 不存在 */ }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/i.test(name) || !st || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('404\n');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': String(st.size),
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // 手机样式表本体（改 mobile.css 存盘即生效）
  if (url.pathname === '/__mobile.css') {
    const css = readMobileCss();
    if (!css) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('mobile.css 不存在\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
    res.end(css);
    return;
  }

  // ?m=0 关掉手机样式，?m=1 打开（cookie 记住，方便对比）
  const m = url.searchParams.get('m');
  if (m === '0' || m === '1') {
    url.searchParams.delete('m');
    const clean = url.pathname + (url.search ? url.search : '');
    res.writeHead(303, {
      location: clean || '/',
      'set-cookie':
        m === '0'
          ? `${MOBILE_OFF_COOKIE}=1; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`
          : `${MOBILE_OFF_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }

  sendUpstream(req, res);
});

// WebSocket / 其它 Upgrade：原始 socket 双通
function connectUpstream(req, socket, head, retried = false) {
  const up = net.connect(DSH_PORT, '127.0.0.1', () => {
    const headers = upstreamHeaders(req);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade || 'websocket';
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      raw += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
    }
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', async (e) => {
    if (!retried && e.code === 'ECONNREFUSED' && (await refreshUpstream())) {
      connectUpstream(req, socket, head, true);
      return;
    }
    socket.destroy();
  });
  socket.on('error', () => up.destroy());
}

server.on('upgrade', (req, socket, head) => {
  if (!peerAllowed(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  if (lockLeft(clientIp(req)) > 0) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  if (!tokenOk(parseCookies(req.headers.cookie)[BRIDGE_COOKIE])) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  connectUpstream(req, socket, head);
});

server.listen(LISTEN_PORT, BIND, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) lan.push(n.address);
    }
  }
  const urls = lan.map((ip) => `http://${ip}:${LISTEN_PORT}/?k=${encodeURIComponent(PASS)}`);
  const lines = [];
  lines.push('==================================================');
  lines.push(` DSH 手机桥运行中：上游 127.0.0.1:${DSH_PORT} → 监听 ${BIND}:${LISTEN_PORT}`);
  lines.push(' 保持这个窗口开着；关闭窗口 = 停止手机访问。');
  if (urls.length === 0) {
    lines.push(' 本机当前没有局域网 IPv4 地址，手机暂时连不上。');
  } else {
    lines.push(' 手机浏览器打开下面地址（只需第一次带 ?k=）：');
    for (const u of urls) lines.push(`   ${u}`);
    lines.push(' 打开后建议用浏览器菜单「添加到主屏幕」，以后点图标直达。');
  }
  lines.push('==================================================');
  console.log('');
  for (const l of lines) console.log(l);
  console.log('');
  // 记下自己的 PID，方便停止脚本定位（隐藏启动时看不到窗口）
  try {
    fs.writeFileSync(path.join(SCRIPT_DIR, 'bridge.pid'), `${process.pid}\r\n`, 'utf8');
  } catch {
    // 忽略
  }
  // 同时落一份地址到文件，方便在电脑上复制后发到手机
  try {
    const addrFile = path.join(SCRIPT_DIR, '手机地址.txt');
    fs.writeFileSync(addrFile, `${lines.join('\r\n')}\r\n\r\n口令：${PASS}\r\n`, 'utf8');
    // ASCII 文件名版本：给 .cmd 启动器读取，避免 cmd.exe 处理中文文件名的编码坑
    fs.writeFileSync(path.join(SCRIPT_DIR, 'phone-url.txt'), `${urls.join('\r\n')}\r\n`, 'utf8');
    console.log(`（地址已写入 ${addrFile}，可复制发给手机）`);
    console.log('');
  } catch {
    // 写不进去就算了
  }
});
