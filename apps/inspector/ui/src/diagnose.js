// 连接失败的可执行诊断。
//
// 为什么需要这个模块：WebSocket 连不上时，浏览器出于安全考虑**刻意不把底层原因
// 交给页面**（onerror 不带任何信息），SDK 只能转述成 "OperationFailed: WebSocket
// 连接错误"。对一个「调试工具」来说，这句话等于没有信息 —— 而连接失败恰恰是它
// 最高频的失败模式。
//
// 补偿办法：失败之后主动补一次探测，把「连不上」拆成互不相同的几种情况，
// 每种情况给出对应的下一步动作。判定依据只有两条 —— 端口有没有人监听，
// 以及服务端有没有回业务错误码。

/** 本工具的演示配置（App.cpp 的 --demo 分支）。命中时给出最强的提示。 */
export const DEMO = { url: 'ws://127.0.0.1:9002', domain: 'shininspector', port: 9002 };

const PROBE_TIMEOUT_MS = 2500;

/** 解析 ws/wss 地址。返回 null 表示格式不合法。 */
export function parseWsUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }

  // 实测（apps/inspector/ui/tools/probe-ws.mjs）：WebSocket 构造器接受 http/https 并自动改写为
  // ws/wss —— Chrome 的报错文案自己就写着 "must be either 'http', 'https', 'ws',
  // or 'wss'"。所以 http:// 不是错误，别把它当格式问题拦下来。
  // 但 https:// 会变成 wss://，那是另一个失败模式（明文端口上做 TLS 握手），
  // 必须记下改写前是什么，否则用户对着「握手失败」想不通。
  const rewrite = { 'http:': 'ws:', 'https:': 'wss:' }[u.protocol] || null;
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:' && !rewrite) return null;
  if (!u.hostname) return null;

  const scheme = rewrite || u.protocol;
  const port = u.port ? Number(u.port) : scheme === 'wss:' ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  // rewritten 记的是「改写前」的 scheme（http: 或 https:），没改写则为 null。
  return { scheme, host: u.hostname, port, path: u.pathname, rewritten: rewrite ? u.protocol : null };
}

function hostForFetch(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * 探测主机端口是否有人监听。
 *
 * 浏览器不允许裸 TCP，这里用一个 no-cors 请求代偿：能连上并拿到 HTTP 响应
 * （哪怕是 404）就说明端口是开的；连接被拒绝会立刻抛 TypeError。
 * 局限：分不清「端口没服务」和「主机不可达」，所以措辞上覆盖两者。
 */
export async function probeHost(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const scheme = location.protocol === 'https:' ? 'https' : 'http';
    await fetch(`${scheme}://${hostForFetch(host)}:${port}/`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: ctl.signal,
    });
    return 'open';
  } catch (e) {
    return e?.name === 'AbortError' ? 'timeout' : 'refused';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 诊断一次连接失败。
 * @returns {{reason: string, detail: string, actions: string[]}}
 */
export async function diagnoseConnectFailure({ url, domain, error }) {
  const code = error?.code || '';
  const message = error?.message || String(error ?? '');
  const target = parseWsUrl(url);

  if (!target) {
    // 非法 scheme（ftp:// 之类）由 WebSocket 构造器自己抛 SyntaxError，
    // 文案里带 "scheme must be either…"，据此可以把「协议不支持」和
    // 「地址打错了」区分开。
    const schemeProblem = /scheme/i.test(message);
    return {
      reason: schemeProblem ? '地址协议不支持' : '地址无法解析',
      detail: schemeProblem
        ? `WebSocket 只接受 ws / wss（http / https 会被自动改写），当前填的是「${url}」。`
        : `「${url}」不是合法的 WebSocket 地址。`,
      actions: ['格式应为 ws://主机:端口，例如 ws://127.0.0.1:9002'],
    };
  }

  const where = `${target.host}:${target.port}`;

  // ---- 传输层是通的，服务端明确回了业务错误码 ----

  if (code === 'DomainNotFound' || /DomainNotFound/i.test(message)) {
    return {
      reason: '域名不存在',
      detail: `服务端在 ${where} 上活着，但拒绝了域名「${domain}」—— 没有注册这个名字的域。`,
      actions: [
        '域名是「域路由键」，必须与目标应用 RuntimeDomain 的名字完全一致（区分大小写，无别名）。',
        `本工具演示树的域名固定为 ${DEMO.domain}`,
      ],
    };
  }

  if (code && code !== 'OperationFailed') {
    return { reason: code, detail: message, actions: [] };
  }

  // ---- 传输层失败：只能靠探测区分 ----

  const probe = await probeHost(target.host, target.port);

  if (probe === 'open') {
    const actions = [];
    if (target.rewritten === 'https:') {
      actions.push(
        '地址写的是 https:// —— 浏览器会把它改写成 wss://（走 TLS），'
        + '但这个端口是明文 WebSocket，TLS 握手在服务端直接失败。改用 ws:// 再试。',
      );
    }
    actions.push(
      '确认该端口暴露的是 IObject 的 WebSocketServer，而不是别的 HTTP / WebSocket 服务。',
      '若中间有反向代理，检查 Upgrade / Connection 头有没有被剥掉。',
    );
    return {
      reason: `${where} 可以连通，但握手失败`,
      detail: `端口是开的，对方却没完成 IObject WebSocket 握手（${message}）。`,
      actions,
    };
  }

  if (probe === 'timeout') {
    return {
      reason: `${where} 无响应`,
      detail: `TCP 既连不上也等不到拒绝，探测请求在 ${PROBE_TIMEOUT_MS}ms 内没有任何结果。`,
      actions: [
        '检查防火墙 / 安全软件是否拦截了该端口。',
        '确认主机名或 IP 从本机可达（非回环地址先用 ping 试）。',
      ],
    };
  }

  // refused —— 最常见的一种，也最值得把话说明白。
  const isLoopback = target.host === '127.0.0.1' || target.host === 'localhost' || target.host === '::1';

  const actions = [
    '确认目标应用已启动，且它的 WebSocketServer 确实监听在这个端口（端口号要完全对上）。',
  ];
  if (isLoopback) {
    actions.push(
      '若只是想把界面先跑通：本工具自带演示对象树，带 --demo 启动即可 ——'
      + ` ShinInspectorApp.exe --demo（监听 ${DEMO.port}、域名 ${DEMO.domain}，窗口标题会显示 "[demo]"）。`,
    );
    if (target.port === DEMO.port) {
      actions.push(
        `若已经带了 --demo 却还是连不上，说明 ${DEMO.port} 被别的进程占用、服务端静默启动失败了 ——`
        + ' 看一下应用日志里的 "监听端口失败"，或先腾出这个端口。',
      );
    }
  }
  if (target.host === 'localhost') {
    actions.push('若目标只监听 IPv4，把 localhost 换成 127.0.0.1 再试。');
  }

  return {
    reason: `${where} 上没有服务在监听`,
    detail: `连接被拒绝（${message}）。浏览器不会把底层原因交给页面，这条结论来自一次主动探测。`,
    actions,
  };
}
