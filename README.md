# Orkestr 节点：单文件 Node VLESS + WS（零依赖）

文件在 `~/workspace/orkestr-node/`：`server.js` 是节点本身（博客前台 +
VLESS-WS），`Dockerfile` + `package.json` 只是部署用的包装。

## 先说结论：Functions 跑不了这个节点

Orkestr Functions 是**纯 handler 模式**：平台自己包了一个小 HTTP 服务器，
你只贴一段“收到请求、返回什么”的 handler 函数。每次请求进来，函数被叫醒，
算完返回一个响应就结束，60 秒没人就休眠（scale-to-zero）。

你拿不到底层的 TCP 连接，所以：

- 没法做 WebSocket 握手升级（101 Switching Protocols）；
- 没法一直挂着一条长连接来回传数据；
- VLESS + WS 恰恰要的就是这条一直挂着的长连接。

所以 Functions 只能做 webhook、小 API 这种“一问一答”的事，节点必须走
**Projects（长跑容器）**：你自己跑 `node server.js`，一直监听端口，
连接可以一直挂着。

## 节点信息（新 UUID，不跟 serv00 / Cloady / 36 台复用）

- UUID：`<UUID>`
- WS 路径：`/<UUID-无横线>-vl`
- 前台：以前的博客小站“半山小记”（/、/posts/*、/about），错路径 400，错 UUID 断开
- 协议：VLESS TCP + UDP（UDP 只在代码里，沙箱禁 UDP 出站所以没法完整验证），
  支持 Xray early data，TCP 空闲 120 秒断开，UDP 空闲 30 秒断开
- 本地实测 6/6 通过（2026-11-16）：博客首页 200、文章页 200、404 页、
  VLESS TCP 往返（响应头 `[0,0]` + `TARGET-OK:ping`）、错路径拒绝、错 UUID 拒绝

## 部署：走 Projects（免费 1 个项目）

1. 把这三个文件推到一个 Git 仓库（GitHub / GitLab / Bitbucket / Codeberg 都行，
   公开仓库也可以直接贴仓库地址，不用连账号）。
2. Orkestr 控制台 → Settings → Connected Providers，连上你的 Git 账号
   （或者建 Project 时直接贴仓库 URL）。
3. Projects → New Project，选这个仓库，slug 自己起一个，
   比如 `node-blog`，地址就是 `node-blog.orkestr.run`。
4. 环境变量里设（也可以不设，用文件里 baked 的默认值）：
   - `UUID=<UUID>`
   - `PORT` 由平台注入，代码会自己读，不用手动设
5. 点 Deploy，等状态 Live，打开 `https://<slug>.orkestr.run/` 应该看到博客首页。

客户端链接（把 `<slug>` 换成你自己的，host 填平台给的域名，TLS 由平台负责）：

```
vless://<UUID>@<slug>.orkestr.run:443?encryption=none&security=tls&type=ws&host=<slug>.orkestr.run&path=%2F<UUID-无横线>-vl#orkestr-node
```

## 已知的坑

- 免费版 30 分钟没流量就休眠，下一次访问要先唤醒，第一次会慢一点，
  客户端要能自动重连。
- Orkestr 文档没明说 Projects 的反向代理一定透传 WebSocket 升级，
  部署后必须用客户端实测一次 WS 握手（101）+ 往返，不通就是平台网关拦了。
- 代理用途可能违反平台条款，自己承担风险；UUID 和链接不要公开贴出去。
