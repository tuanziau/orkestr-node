#!/usr/bin/env node
'use strict';
/**
 * 单文件 Node VLESS + WebSocket 节点，零第三方依赖。
 * - 前台是以前的博客小站“半山小记”（/、/posts/*、/about），普通访问只看到博客。
 * - VLESS 藏在一条 UUID 派生的秘密路径上，路径 + UUID 双重校验。
 * - 手写 RFC 6455 WebSocket（握手 / 分帧 / ping-pong / close），支持 Xray early data。
 * - VLESS：TCP + UDP，IPv4 / 域名 / IPv6；TCP 空闲 120 秒断开，UDP 空闲 30 秒断开，
 *   握手 10 秒内收不到 VLESS 头断开。
 *
 * 用法（本地）：
 *   UUID=031c341d-cea7-4b4e-a2ab-3c207ba55e70 PORT=8080 node server.js
 * 部署到 Orkestr 只能走 Projects（长跑容器），Functions 是纯 handler、跑不了 WS，
 * 详见同目录 README.md。平台负责 TLS，节点本身只听明文 $PORT。
 */
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');

const UUID = (process.env.UUID || '031c341d-cea7-4b4e-a2ab-3c207ba55e70').trim().toLowerCase();
if (!/^[0-9a-f-]{36}$/.test(UUID)) {
  console.error('UUID is not configured');
  process.exit(1);
}
const UUID_BUF = Buffer.from(UUID.replace(/-/g, ''), 'hex');
const PORT = Number(process.env.PORT) || 8080;
const WS_PATH = process.env.WSPATH || process.env.WS_PATH ||
  '/' + UUID.replace(/-/g, '') + '-vl';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 16 * 1024 * 1024;
const TCP_IDLE_MS = 120000;

/* ---------------- 博客小站（半山小记，前台伪装） ---------------- */

const CSS = 'body{font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;max-width:720px;margin:0 auto;padding:24px 16px 64px;color:#24292f;line-height:1.75;background:#fff}header{border-bottom:1px solid #eaecef;padding-bottom:12px;margin-bottom:28px}header a{color:#24292f;text-decoration:none}nav a{margin-right:16px;color:#57606a;font-size:14px}.post{margin-bottom:34px}.post h2{margin:0 0 6px;font-size:21px}.post h2 a{color:#0969da;text-decoration:none}.meta{color:#57606a;font-size:13px;margin-bottom:8px}footer{border-top:1px solid #eaecef;margin-top:48px;padding-top:14px;color:#57606a;font-size:13px}pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}';

function layout(title, body) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + ' · 半山小记</title><style>' + CSS + '</style></head><body>' +
    '<header><div style="font-size:22px;font-weight:600"><a href="/">半山小记</a></div>' +
    '<nav><a href="/">首页</a><a href="/about">关于</a></nav></header>' +
    body +
    '<footer>© 2026 半山小记 · 记录是为了不忘记</footer></body></html>';
}

const POSTS = {
  '/posts/hello-world': {
    title: '你好，世界',
    date: '2026-01-03',
    body: '<p>这个小站开了很多年，一直断断续续。最近把旧文章都整理了一遍，决定重新开始，慢慢写，不追求更新频率，只求每篇都对得起自己。</p><p>主要会记录三类东西：读书笔记、工作里的技术备忘、还有生活里的小事。欢迎路过。</p>',
  },
  '/posts/notes-on-javascript': {
    title: 'JavaScript 学习笔记：异步的几种写法',
    date: '2026-02-14',
    body: '<p>从回调到 Promise，再到 async/await，异步代码的可读性是一步步变好的。最近重构一个老项目，把嵌套了五层的回调改成顺序写法，删掉了三分之一的代码。</p><pre><code>const data = await fetchData();\nconst result = await process(data);\nconsole.log(result);</code></pre><p>心得就一条：异步代码写得像同步代码，维护的人会感谢你。</p>',
  },
  '/posts/walk-in-the-rain': {
    title: '雨天散步',
    date: '2026-03-08',
    body: '<p>下午下了一场不大的雨，沿着河边走了一圈。雨天的好处是人少，坏处是鞋湿。走到一半雨停了，云开得很快，天边有一点淡淡的晚霞。</p><p>回来煮了壶茶，把上周没读完的书翻了最后二十页。这样的日子不需要发生什么事，也算过得不错。</p>',
  },
};

function homePage() {
  let items = '';
  for (const [path, p] of Object.entries(POSTS)) {
    items += '<div class="post"><h2><a href="' + path + '">' + p.title + '</a></h2>' +
      '<div class="meta">' + p.date + '</div><p>' + p.body.replace(/<[^>]+>/g, '').slice(0, 90) + '……</p></div>';
  }
  return layout('首页', items);
}

function postPage(p) {
  return layout(p.title, '<div class="post"><h2>' + p.title + '</h2><div class="meta">' + p.date + '</div>' + p.body + '</div><p><a href="/">← 返回首页</a></p>');
}

const ABOUT = layout('关于', '<div class="post"><h2>关于</h2><p>一个普通人的个人博客，写字是为了整理思绪。不定期更新，谢绝转载。</p><p>联系邮箱：me@example.com</p></div>');
const NOT_FOUND = layout('页面不存在', '<div class="post"><h2>404</h2><p>你要找的页面不在这里，可能已经随着某次整理被删掉了。</p><p><a href="/">← 返回首页</a></p></div>');

/* ---------------------------- WebSocket 层 ---------------------------- */

function wsSend(socket, data, opcode = 2) {
  if (socket.destroyed || !socket.writable) return true;
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.allocUnsafe(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.allocUnsafe(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.allocUnsafe(10);
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  head[0] = 0x80 | opcode; // FIN + opcode
  socket.cork();
  socket.write(head);
  const ok = socket.write(data);
  socket.uncork();
  return ok;
}

// 增量帧解析。分片按字节流转发（VLESS 是流式协议，消息边界不重要）。
function createWsParser(socket, onPayload, onClose) {
  let buf = Buffer.alloc(0);
  let done = false;

  function fail() {
    done = true;
    onClose();
  }

  return function push(chunk) {
    if (done) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    while (!done) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) return fail();
        len = buf.readUInt32BE(6);
        off = 10;
      }
      if (len > MAX_FRAME || !masked) return fail(); // 客户端帧必须带掩码

      const total = off + 4 + len;
      if (buf.length < total) return;

      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, total)); // 拷贝后原地解掩码
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(total);

      switch (opcode) {
        case 0x0: // continuation
        case 0x1: // text
        case 0x2: // binary
          if (payload.length) onPayload(payload);
          break;
        case 0x8: // close
          done = true;
          return onClose();
        case 0x9: // ping -> pong
          wsSend(socket, payload, 0xa);
          break;
        default: // pong / 未知：忽略
      }
    }
  };
}

/* ------------------------------ VLESS 层 ------------------------------ */

// 未收全返回 null，非法直接抛错。
function parseVless(buf) {
  if (buf.length < 18) return null;
  const version = buf[0];
  if (!crypto.timingSafeEqual(buf.subarray(1, 17), UUID_BUF)) throw new Error('bad uuid');

  let p = 18 + buf[17]; // 跳过附加信息
  if (buf.length < p + 4) return null;
  const cmd = buf[p++]; // 1 = TCP，2 = UDP
  const port = buf.readUInt16BE(p);
  p += 2;
  const atype = buf[p++];

  let host;
  if (atype === 1) {
    if (buf.length < p + 4) return null;
    host = Array.from(buf.subarray(p, p + 4)).join('.');
    p += 4;
  } else if (atype === 2) {
    if (buf.length < p + 1) return null;
    const l = buf[p++];
    if (buf.length < p + l) return null;
    host = buf.toString('utf8', p, p + l);
    p += l;
  } else if (atype === 3) {
    if (buf.length < p + 16) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(p + i * 2).toString(16));
    host = parts.join(':');
    p += 16;
  } else {
    throw new Error('bad address type');
  }
  return { version, cmd, port, host, rest: buf.subarray(p) };
}

function createSession(ws) {
  let closed = false;
  let remote = null; // TCP socket
  let udp = null; // { sock, host, port, buf }
  let udpTimer = null;
  let idleTimer = null;
  let head = Buffer.alloc(0);
  let respHeader = null;
  const hsTimer = setTimeout(close, 10000); // 10 秒内必须发来 VLESS 头

  ws.on('error', close);
  ws.on('close', close);
  touchIdle();

  function touchIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(close, TCP_IDLE_MS);
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(hsTimer);
    clearTimeout(udpTimer);
    clearTimeout(idleTimer);
    if (remote) remote.destroy();
    if (udp) {
      try { udp.sock.close(); } catch (_) {}
    }
    if (!ws.destroyed) {
      try { ws.write(Buffer.from([0x88, 0x00])); } catch (_) {}
      ws.end();
      setTimeout(() => ws.destroy(), 1000).unref();
    }
  }

  function toClient(data) {
    if (closed) return true;
    touchIdle();
    if (respHeader) {
      data = Buffer.concat([respHeader, data]);
      respHeader = null;
    }
    return wsSend(ws, data);
  }

  function startTcp(h) {
    remote = net.connect({ host: h.host, port: h.port });
    remote.setNoDelay(true);
    remote.on('data', (d) => {
      if (!toClient(d)) {
        remote.pause();
        ws.once('drain', () => remote && remote.resume());
      }
    });
    remote.on('end', close);
    remote.on('close', close);
    remote.on('error', close);
    if (h.rest.length) writeRemote(h.rest);
  }

  function writeRemote(chunk) {
    touchIdle();
    if (!remote.write(chunk)) {
      ws.pause();
      remote.once('drain', () => ws.resume());
    }
  }

  function touchUdp() {
    clearTimeout(udpTimer);
    udpTimer = setTimeout(close, 30000);
  }

  function startUdp(h) {
    const sock = dgram.createSocket(h.host.includes(':') ? 'udp6' : 'udp4');
    udp = { sock, host: h.host, port: h.port, buf: Buffer.alloc(0) };
    sock.on('message', (msg) => {
      const len = Buffer.allocUnsafe(2);
      len.writeUInt16BE(msg.length);
      toClient(Buffer.concat([len, msg]));
      touchUdp();
    });
    sock.on('error', close);
    touchUdp();
    udpIn(h.rest);
  }

  // VLESS 里的 UDP 包按 [2 字节长度][数据] 打包
  function udpIn(chunk) {
    touchIdle();
    udp.buf = Buffer.concat([udp.buf, chunk]);
    while (udp.buf.length >= 2) {
      const l = udp.buf.readUInt16BE(0);
      if (udp.buf.length < 2 + l) break;
      const pkt = udp.buf.subarray(2, 2 + l);
      udp.buf = udp.buf.subarray(2 + l);
      udp.sock.send(pkt, udp.port, udp.host, (err) => err && close());
    }
    touchUdp();
  }

  function onData(chunk) {
    if (closed) return;
    if (remote) return writeRemote(chunk);
    if (udp) return udpIn(chunk);

    head = Buffer.concat([head, chunk]);
    let h;
    try {
      h = parseVless(head);
    } catch (_) {
      return close();
    }
    if (!h) {
      if (head.length > 4096) close();
      return;
    }
    clearTimeout(hsTimer);
    head = Buffer.alloc(0);
    respHeader = Buffer.from([h.version, 0]);

    if (h.cmd === 1) startTcp(h);
    else if (h.cmd === 2) startUdp(h);
    else close();
  }

  return { onData, close };
}

/* ------------------------------- HTTP 服务 ------------------------------ */

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url === '/' || url === '/index.html') {
    res.end(homePage());
  } else if (POSTS[url]) {
    res.end(postPage(POSTS[url]));
  } else if (url === '/about') {
    res.end(ABOUT);
  } else if (url === '/robots.txt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('User-agent: *\nAllow: /\n');
  } else {
    res.writeHead(404);
    res.end(NOT_FOUND);
  }
});

server.on('upgrade', (req, socket, headBytes) => {
  const path = (req.url || '/').split('?')[0];
  const key = req.headers['sec-websocket-key'];
  const isWs = String(req.headers.upgrade || '').toLowerCase() === 'websocket';

  if (path !== WS_PATH || !isWs || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  let resp =
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n`;

  // 可选 early data（Xray ?ed=）：base64url 数据放在子协议头里
  let early = null;
  const proto = req.headers['sec-websocket-protocol'];
  if (proto) {
    const first = proto.split(',')[0].trim();
    resp += `Sec-WebSocket-Protocol: ${first}\r\n`;
    early = Buffer.from(first, 'base64'); // Node 也接受 URL-safe 字母表
  }
  socket.write(resp + '\r\n');

  socket.setNoDelay(true);
  socket.setTimeout(0);

  const session = createSession(socket);
  const push = createWsParser(socket, session.onData, session.close);

  if (early && early.length) session.onData(early);
  if (headBytes && headBytes.length) push(headBytes);
  socket.on('data', push);
});

server.listen(PORT, () => {
  console.log(`blog + vless-ws listening on :${PORT}  path=${WS_PATH}`);
});

process.on('uncaughtException', (e) => console.error('uncaught:', e.message));
process.on('unhandledRejection', (e) => console.error('unhandled:', e));
