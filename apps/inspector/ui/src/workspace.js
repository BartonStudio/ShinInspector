// 「观察清单」——画布上能看到哪些对象，完全由用户声明，工具不做全树扫描。
//
// 每条 spec 记录的是「**怎么找到它**」（相对路径 / 绝对地址 / 根锚点），而不是找到之后的 addr。
// 这样断开重连、乃至目标应用重启后，清单依然可用 —— 重新解析即可。

import { state, emit, logLine } from './store.js';
import { session } from './session.js';
import { errText, shortAddr } from './bytes.js';
import { refreshTopology } from './topology.js';
import { syncSubscriptions } from './observe.js';

const storeKey = (url, domain) => 'shin.workspace.' + url + '|' + domain;

// ---------------- 持久化 ----------------

function loadSpecs(url, domain) {
  try {
    const arr = JSON.parse(localStorage.getItem(storeKey(url, domain)) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => s && typeof s.value === 'string')
      .map((s) => ({ id: s.kind + ':' + s.value, kind: s.kind, value: s.value }));
  } catch {
    return [];
  }
}

function saveSpecs() {
  const { url, domain } = state.connection;
  if (!url || !domain) return;
  try {
    localStorage.setItem(
      storeKey(url, domain),
      JSON.stringify(state.specs.map((s) => ({ kind: s.kind, value: s.value }))),
    );
  } catch { /* 忽略 */ }
}

// ---------------- 输入解析 ----------------

export function parseInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('请输入路径或地址');

  if (/^0x[0-9a-f]+$/i.test(s)) {
    return { id: '', kind: 'addr', value: String(parseInt(s, 16)) };
  }
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('addr 超出可表示范围');
    return { id: '', kind: 'addr', value: s };
  }

  const cleaned = s.replace(/^root\./i, '').replace(/^\./, '');
  if (!cleaned) return { id: '', kind: 'root', value: 'root' };
  if (cleaned.includes('..') || cleaned.endsWith('.')) throw new Error('路径格式非法');
  return { id: '', kind: 'path', value: cleaned };
}

function withId(spec) {
  spec.id = spec.kind + ':' + spec.value;
  return spec;
}

// ---------------- 清单操作 ----------------

export async function bootstrapWorkspace(url, domain) {
  const saved = loadSpecs(url, domain);
  state.specs = saved.length ? saved : [];
  ensureRootSpec();
  await resolveAll();
}

/** 根锚点来自握手响应，不是"发现"出来的，始终保留在清单里作为路径解析的起点。 */
export function ensureRootSpec() {
  if (!state.specs.some((s) => s.kind === 'root')) {
    state.specs.unshift(withId({ kind: 'root', value: 'root' }));
  }
}

export async function addSpec(rawInput) {
  const spec = withId(parseInput(rawInput));
  if (state.specs.some((s) => s.id === spec.id)) throw new Error('该节点已在清单中');
  state.specs.push(spec);
  saveSpecs();
  await resolveAll();
  return spec;
}

/** 从「未加入的子节点」一键加入：拓扑层已经算好了它的完整路径。 */
export async function addByPath(fullPath) {
  return addSpec(String(fullPath).replace(/^root\.?/i, ''));
}

/**
 * 批量加入（导入用）。
 * addSpec 每调一次就 resolveAll 一遍全清单，逐条导入会变成 N 次全量重扫，
 * 所以这里先攒齐再一次性解析。
 */
export async function addSpecs(rawList) {
  const added = [];
  const failed = [];

  for (const raw of rawList) {
    const line = String(raw ?? '').trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const spec = withId(parseInput(line));
      if (state.specs.some((s) => s.id === spec.id)) continue;
      state.specs.push(spec);
      added.push(spec);
    } catch (e) {
      failed.push({ line, error: errText(e) });
    }
  }

  saveSpecs();
  if (added.length) await resolveAll();
  return { added, failed };
}

/** 当前清单的纯文本表示：每行一条，可直接粘回来导入。 */
export function exportSpecs() {
  return state.specs
    .map((s) => (s.kind === 'addr'
      ? '0x' + Number(s.value).toString(16).toUpperCase()
      : s.value))
    .join('\n');
}

export async function removeSpec(id) {
  state.specs = state.specs.filter((s) => s.id !== id || s.kind === 'root');
  saveSpecs();
  await resolveAll();
}

// ---------------- 解析 ----------------

/** 把一个 spec 解析成 { addr, name, path, segments }。失败会 throw。 */
async function resolveSpec(spec) {
  if (!session.isOpen) throw new Error('尚未连接');

  if (spec.kind === 'root') {
    return { addr: session.client.root.addr, name: 'root', path: 'root', segments: ['root'] };
  }

  if (spec.kind === 'addr') {
    const addr = Number(spec.value);
    if (!Number.isSafeInteger(addr) || addr <= 0) throw new Error('addr 非法');
    const known = state.childIndex.get(addr);
    return { addr, name: known?.name ?? null, path: known?.path ?? null, segments: [] };
  }

  const parts = spec.value.split('.').filter(Boolean);
  let cursor = session.client.root;
  for (const part of parts) {
    cursor = await cursor.getChildItem(part);
    if (!cursor || !cursor.addr) throw new Error('路径在 "' + part + '" 处解析失败');
  }
  return {
    addr: cursor.addr,
    name: parts[parts.length - 1],
    path: 'root.' + parts.join('.'),
    segments: parts,
  };
}

/** 重新解析整份清单。断线重连后必须调用（addr 全变了）。 */
export async function resolveAll() {
  ensureRootSpec();

  if (!session.isOpen) {
    state.nodes = [];
    state.edges = [];
    emit('workspace', state);
    return;
  }

  const nodes = [];
  const seen = new Set();

  for (const spec of state.specs) {
    delete spec.error;
    try {
      const r = await resolveSpec(spec);
      if (seen.has(r.addr)) {
        spec.error = '与清单中另一项指向同一对象，已忽略';
        continue;
      }
      seen.add(r.addr);
      nodes.push({
        addr: r.addr,
        name: r.name,
        path: r.path,
        segments: r.segments,
        isRoot: spec.kind === 'root',
        spec,
        depth: null,
        childCount: null,
        childError: '',
        unjoined: [],
        channels: new Map(),
        lastPulse: 0,
        released: false,
      });
    } catch (e) {
      spec.error = errText(e);
      logLine('加入失败 ' + describeSpec(spec) + ' —— ' + spec.error, 'conn');
    }
  }

  state.nodes = nodes;
  emit('workspace', state);

  await refreshTopology();
  if (state.ui.autoSubscribe) await syncSubscriptions();
}

export function describeSpec(spec) {
  if (spec.kind === 'root') return 'root（锚点）';
  if (spec.kind === 'addr') return 'addr ' + shortAddr(Number(spec.value));
  return spec.value;
}

/** 清空画布（保留清单）。 */
export function clearNodes() {
  state.nodes = [];
  state.edges = [];
  state.selection = null;
  emit('workspace', state);
  emit('topology', { nodes: [], edges: [] });
}
