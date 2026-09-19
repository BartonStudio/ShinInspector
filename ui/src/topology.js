// 拓扑**不是扫描来的**。
//
// 规则：只对「用户已声明的节点」调用 GetChildren。返回的子节点里，
//   · 命中另一个已声明节点  -> 连一条边
//   · 未命中                -> 记为「未加入的子节点」，由用户决定是否加入清单
// 这样工具的可见范围严格等于用户的声明范围，不会自作主张铺开整棵树。

import { RemoteObject } from 'iobject-js';
import { state, emit } from './store.js';
import { session } from './session.js';
import { errText } from './bytes.js';

let timer = null;

/** 结构事件可能密集到达，合并成一次刷新。 */
export function scheduleRefresh(delay = 180) {
  clearTimeout(timer);
  timer = setTimeout(() => { refreshTopology(); }, delay);
}

export async function refreshTopology() {
  if (!session.isOpen || state.nodes.length === 0) {
    state.edges = [];
    emit('topology', { nodes: state.nodes, edges: state.edges });
    return;
  }

  const byAddr = new Map(state.nodes.map((n) => [n.addr, n]));
  const childIndex = new Map();
  const edges = [];

  for (const n of state.nodes) {
    n.unjoined = [];
    n.childError = '';
    try {
      const kids = await new RemoteObject(session.client, n.addr).getChildren();
      n.childCount = kids.length;
      for (const k of kids) {
        const path = n.path ? n.path + '.' + k.name : null;
        childIndex.set(k.addr, { name: k.name, parentAddr: n.addr, path });
        if (byAddr.has(k.addr)) {
          edges.push({ source: n.addr, target: k.addr, name: k.name });
        } else {
          n.unjoined.push({ name: k.name, addr: k.addr, path });
        }
      }
    } catch (e) {
      n.childCount = null;
      n.childError = errText(e);
    }
  }

  state.edges = edges;
  state.childIndex = childIndex;

  // 给「按地址声明」的节点补一个可读路径：它出现在某个已声明节点的子节点列表里时就能补上。
  for (const n of state.nodes) {
    if (!n.path && childIndex.has(n.addr)) {
      const info = childIndex.get(n.addr);
      n.path = info.path;
      n.name = info.name;
    }
  }

  recomputeDepth();
  emit('topology', { nodes: state.nodes, edges: state.edges });
}

/** 深度用于径向布局与视觉分层；从 root 锚点沿边 BFS，未连通的退化为路径层数。 */
function recomputeDepth() {
  const byAddr = new Map(state.nodes.map((n) => [n.addr, n]));
  const outgoing = new Map();
  for (const e of state.edges) {
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source).push(e.target);
  }

  for (const n of state.nodes) n.depth = null;

  const queue = state.nodes.filter((n) => n.isRoot);
  const seen = new Set();
  for (const r of queue) { r.depth = 0; seen.add(r.addr); }

  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    for (const target of outgoing.get(n.addr) || []) {
      const t = byAddr.get(target);
      if (!t || seen.has(t.addr)) continue;
      t.depth = n.depth + 1;
      seen.add(t.addr);
      queue.push(t);
    }
  }

  for (const n of state.nodes) {
    if (n.depth === null) n.depth = n.segments?.length || 1;
  }
}
