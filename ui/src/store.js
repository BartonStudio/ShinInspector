// 全局状态 + 极简事件总线。
// 各模块只通过这里交换数据，不互相持有状态引用。

const listeners = new Map();

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt)?.delete(fn);
}

export function emit(evt, payload) {
  const set = listeners.get(evt);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (e) {
      console.error('[store] 监听器抛异常：' + evt, e);
    }
  }
}

export const MAX_EVENTS = 2000;

export const state = {
  /** { status: idle|connecting|open|closed|error, url, domain, rootAddr, error, diagnosis } */
  connection: { status: 'idle', url: '', domain: '', rootAddr: null, error: '', diagnosis: null },

  /** 用户声明的节点清单（持久化的就是它）。spec = { id, kind: 'root'|'path'|'addr', value, error? } */
  specs: [],

  /** 清单解析成功后的节点。node = { addr, name, path, segments, depth, isRoot, spec, ... } */
  nodes: [],

  /** 由「已声明节点的 GetChildren」反推出来的边。edge = { source, target, name } */
  edges: [],

  /** 扫描中积累的子节点索引：addr -> { name, parentAddr, path }。用于给「按地址声明」的节点补名字。 */
  childIndex: new Map(),

  /** 事件流（环形缓冲）。 */
  events: [],

  /** 当前选中的 addr。 */
  selection: null,

  ui: {
    // 布局模式不在这里：它由 render/layout.js 自己持有（默认力导向，且不再暴露切换入口）。
    frozen: false,
    autoSubscribe: true,
    eventFilter: 'all', // all | structure | data
    eventPaused: false,
  },

  /** 渲染器类型：webgl | none（WebGL 不可用，整个 UI 停摆）。null = 尚未装配 */
  renderer: null,
};

export function nodeByAddr(addr) {
  return state.nodes.find((n) => n.addr === addr) || null;
}

export function pushEvent(rec) {
  state.events.push(rec);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  if (!state.ui.eventPaused) emit('event', rec);
}

export function logLine(text, type = 'conn') {
  pushEvent({ ts: new Date(), type, path: text, channel: '', data: undefined, isLog: true });
}

export function select(addr) {
  if (state.selection === addr) return;
  state.selection = addr;
  emit('selection', addr);
}

export function setUI(patch) {
  Object.assign(state.ui, patch);
  emit('ui', state.ui);
}
