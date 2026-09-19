// 事件订阅 —— 协议没有反射，"这个对象有哪些通道/发生过什么" 只能靠订阅去学。
//
// 默认对清单里每个节点订阅 4 个内置事件；收到 DataChannelChanged 就记下通道名与载荷快照，
// 于是检查器里的「已观测通道」会自己长出来。
//
// 订阅是可关的：用户可以在检查器里逐个关掉不需要的事件类型。
// 「关掉」这件事按对象路径持久化（memory），否则每次重解析清单重建 node 对象时会被误恢复。

import { RemoteObject } from 'iobject-js';
import { state, emit, pushEvent, nodeByAddr, logLine } from './store.js';
import { session } from './session.js';
import { memory } from './memory.js';
import { bytesToHex, describe, errText } from './bytes.js';
import { scheduleRefresh } from './topology.js';

export const BUILTIN_EVENTS = ['ChildConnected', 'ChildDisconnected', 'DataChannelChanged', 'Released'];

/** addr -> Map<type, Subscription> */
const subs = new Map();
/** 订阅挂在哪个 client 上；换连接后旧句柄全部失效。 */
let boundClient = null;

export async function syncSubscriptions() {
  if (!session.isOpen) return;

  if (boundClient !== session.client) {
    subs.clear();
    boundClient = session.client;
    for (const n of state.nodes) n.subs = new Set();
  }

  const wanted = new Set(state.nodes.map((n) => n.addr));

  // 摘掉已不在清单里的节点
  for (const [addr, m] of [...subs]) {
    if (wanted.has(addr)) continue;
    for (const sub of m.values()) {
      try { await sub.cancel(); } catch { /* 会话可能已断 */ }
    }
    subs.delete(addr);
  }

  // 给节点补齐订阅。注意这里是「补齐」而不是「新节点才订阅」：
  // 用户可能在检查器里关掉了某几类，之后又打开——那种情况也要能挂回去。
  for (const n of state.nodes) {
    if (!n.subs) n.subs = new Set();
    if (!n.subsOff) n.subsOff = new Set(memory.subsOff(n.path));

    let m = subs.get(n.addr);
    if (!m) {
      m = new Map();
      subs.set(n.addr, m);
    }

    for (const type of BUILTIN_EVENTS) {
      if (n.subsOff.has(type)) {
        n.subs.delete(type);
        continue;
      }
      if (m.has(type)) {
        n.subs.add(type);
        continue;
      }
      await subscribeOne(n, type, m);
    }
  }

  emit('topology', { nodes: state.nodes, edges: state.edges });
}

/** 挂一个订阅；失败只记日志，不中断其余类型。返回是否成功。 */
async function subscribeOne(node, type, bucket) {
  try {
    const sub = await new RemoteObject(session.client, node.addr)
      .subscribe(type, (ev) => handleEvent(node.addr, ev));
    bucket.set(type, sub);
    node.subs.add(type);
    return true;
  } catch (e) {
    node.subs.delete(type);
    logLine('订阅 ' + type + ' 失败 @ ' + (node.path || node.name) + '：' + errText(e));
    return false;
  }
}

/** 单点开关。返回该类型最终的订阅状态。 */
export async function setSubscription(node, type, on) {
  if (!session.isOpen) throw new Error('尚未连接');
  if (!node.subs) node.subs = new Set();
  if (!node.subsOff) node.subsOff = new Set(memory.subsOff(node.path));

  if (!on) {
    node.subsOff.add(type);
    const m = subs.get(node.addr);
    const sub = m?.get(type);
    if (sub) {
      try { await sub.cancel(); } catch { /* 忽略 */ }
      m.delete(type);
    }
    node.subs.delete(type);
  } else {
    node.subsOff.delete(type);
    let m = subs.get(node.addr);
    if (!m) {
      m = new Map();
      subs.set(node.addr, m);
    }
    if (!m.has(type)) await subscribeOne(node, type, m);
  }

  memory.setSubsOff(node.path, type, !on);
  emit('subscriptions', { addr: node.addr });
  return node.subs.has(type);
}

/** 该节点全部内置事件的批量开关（逐个执行，避免同一连接上并发风暴）。 */
export async function setAllSubscriptions(node, on) {
  for (const type of BUILTIN_EVENTS) {
    const active = node.subs?.has(type);
    if (on === active) continue;
    await setSubscription(node, type, on);
  }
  return node.subs.size;
}

export async function cancelAll() {
  for (const m of subs.values()) {
    for (const sub of m.values()) {
      try { await sub.cancel(); } catch { /* 忽略 */ }
    }
  }
  subs.clear();
  boundClient = null;
  for (const n of state.nodes) n.subs = new Set();
}

export function subscriptionCount() {
  let n = 0;
  for (const m of subs.values()) n += m.size;
  return n;
}

function handleEvent(addr, ev) {
  const node = nodeByAddr(addr);
  const path = node?.path || node?.name || '0x' + addr.toString(16);

  const rec = {
    ts: new Date(),
    type: ev.event,
    addr,
    path,
    channel: ev.channel || '',
    data: ev.data,
    primary: ev.data !== undefined ? describe(ev.data).primary : '',
  };
  pushEvent(rec);

  if (ev.event === 'DataChannelChanged') {
    if (node) {
      node.lastPulse = performance.now();
      const payload = ev.data !== undefined ? ev.data : null;
      node.channels.set(ev.channel, {
        hex: payload ? bytesToHex(payload) : null,
        primary: payload ? describe(payload).primary : '(无载荷，需主动读)',
        at: Date.now(),
      });
      memory.observeChannel(node.path, ev.channel, payload || new Uint8Array(0));
    }
    emit('node-data', { addr, channel: ev.channel });
  }

  if (ev.event === 'ChildConnected' || ev.event === 'ChildDisconnected') {
    scheduleRefresh();
  }

  if (ev.event === 'Released') {
    if (node) node.released = true;
    emit('topology', { nodes: state.nodes, edges: state.edges });
  }
}
