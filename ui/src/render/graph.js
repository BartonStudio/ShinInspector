// 把 store 里的节点/边画成三维图，并把"状态"编码成视觉：
//   选中 -> 加粗环；刚发生 DataChannelChanged -> 金色脉冲环；Released -> 变灰。
// 节点用单个 InstancedMesh，边用单个 LineSegments，标签是 Sprite。

import * as THREE from 'three';
import { state } from '../store.js';
import { shortAddr } from '../bytes.js';

// 画布色板（与 styles/app.css 里的 --text / --accent / --warn 对齐）：
// 橙 = root，浅灰 = 普通对象，亮橙 = 选中，琥珀 = 刚发生 DataChannelChanged，深灰 = Released。
// 只保留"白 → 橙"一条色阶，橙色是唯一的注意力引导，别再加第二种饱和色。
const C = {
  root: 0xff9000,
  normal: 0xd6d6d6,
  selected: 0xffe3b0,
  released: 0x4a4a4a,
  pulse: 0xffc23d,
  edge: 0x3d3d3d,
  edgeHot: 0xff9000,
};

const R_BASE = 7.5;
const R_ROOT = 10;
const PULSE_MAX = 48;
const PULSE_MS = 950;
/** 节点的世界尺寸按相机距离缩放，使屏幕上的观感基本恒定 —— 无论图有多大都读得清。 */
const REF_DIST = 280;

export function createGraph(view) {
  const group = new THREE.Group();
  view.scene.add(group);

  const sphereGeo = new THREE.SphereGeometry(1, 20, 14);
  // 低金属度 + 高粗糙度：弱化高光，让实例色尽量等于"终端里那颗点的颜色"。
  const nodeMat = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.04 });
  let nodesMesh = null;
  let nodeCapacity = 0;

  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setDrawRange(0, 0);
  const edgeMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
  const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
  edgeLines.frustumCulled = false;
  group.add(edgeLines);
  let edgeCapacity = 0;

  const ringGeo = new THREE.TorusGeometry(1, 0.035, 8, 48);
  const selRing = new THREE.Mesh(
    ringGeo,
    new THREE.MeshBasicMaterial({ color: C.selected, transparent: true, opacity: 0.95 }),
  );
  selRing.visible = false;
  selRing.frustumCulled = false;
  group.add(selRing);

  const labelGroup = new THREE.Group();
  group.add(labelGroup);
  const labelCache = new Map();
  let sprites = [];

  const pulses = [];
  for (let i = 0; i < PULSE_MAX; i++) {
    const mesh = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: C.pulse, transparent: true, opacity: 0 }),
    );
    mesh.visible = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    pulses.push({ mesh, t0: 0, addr: 0, r0: R_BASE });
  }
  let pulseCursor = 0;
  const seenPulse = new Map();

  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  const byAddr = new Map();

  // ---------------- 资源分配 ----------------

  function ensureNodes(n) {
    if (nodesMesh && n <= nodeCapacity) return;
    if (nodesMesh) { group.remove(nodesMesh); nodesMesh.dispose?.(); }
    nodeCapacity = Math.max(n, 32);
    nodesMesh = new THREE.InstancedMesh(sphereGeo, nodeMat, nodeCapacity);
    nodesMesh.frustumCulled = false;
    nodesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(nodesMesh);
  }

  function ensureEdges(n) {
    if (n <= edgeCapacity) return;
    edgeCapacity = Math.max(n, 64);
    edgeGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(edgeCapacity * 2 * 3), 3),
    );
    edgeGeo.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(edgeCapacity * 2 * 3), 3),
    );
  }

  function ensureLabels(n) {
    while (sprites.length < n) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
      sp.frustumCulled = false;
      labelGroup.add(sp);
      sprites.push(sp);
    }
  }

  function labelTexture(text) {
    let tex = labelCache.get(text);
    if (tex) return tex;
    // 标签用等宽字体 + 近白，和面板里的字是同一套视觉语言。
    const font = '600 30px "Cascadia Mono", "JetBrains Mono", Consolas, "Microsoft YaHei", monospace';
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const w = Math.ceil(probe.measureText(text).width) + 26;
    const h = 48;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 先描一圈黑底，再叠近白 —— 深浅节点重叠时标签也不会糊在一起。
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(text, w / 2, h / 2);
    ctx.fillStyle = 'rgba(242,242,242,0.95)';
    ctx.fillText(text, w / 2, h / 2);
    tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    tex.userData = { aspect: w / h };
    labelCache.set(text, tex);
    return tex;
  }

  function radiusFor(n, selected, dist) {
    let r = n.isRoot ? R_ROOT : R_BASE;
    if (selected) r += 2.2;
    const depthScale = Math.min(Math.max(dist / REF_DIST, 0.45), 2.4);
    return r * depthScale;
  }

  function spawnPulse(node, r) {
    const slot = pulses[pulseCursor % PULSE_MAX];
    pulseCursor += 1;
    slot.addr = node.addr;
    slot.r0 = r;
    slot.t0 = performance.now();
    slot.mesh.visible = true;
    slot.mesh.material.opacity = 0.75;
  }

  // ---------------- 每帧更新 ----------------

  function update() {
    const nodes = state.nodes;
    const edges = state.edges;
    const now = performance.now();
    const selected = state.selection;

    ensureNodes(nodes.length);
    ensureEdges(edges.length);
    ensureLabels(nodes.length);

    byAddr.clear();
    for (const n of nodes) byAddr.set(n.addr, n);

    const cam = view.camera.position;

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const x = n.x || 0;
      const y = n.y || 0;
      const z = n.z || 0;
      const isSel = n.addr === selected;
      const dist = Math.hypot(x - cam.x, y - cam.y, z - cam.z) || REF_DIST;
      const r = radiusFor(n, isSel, dist);

      dummy.position.set(x, y, z);
      dummy.scale.setScalar(r);
      dummy.updateMatrix();
      nodesMesh.setMatrixAt(i, dummy.matrix);

      const pulsing = n.lastPulse > 0 && now - n.lastPulse < PULSE_MS;
      let hex = C.normal;
      if (n.released) hex = C.released;
      else if (n.isRoot) hex = C.root;
      if (pulsing && !n.released) hex = C.pulse;
      if (isSel && !n.released) hex = C.selected;
      nodesMesh.setColorAt(i, tmpColor.setHex(hex));

      const sprite = sprites[i];
      const text = n.name || shortAddr(n.addr);
      const tex = labelTexture(text);
      if (sprite.material.map !== tex) {
        sprite.material.map = tex;
        sprite.material.needsUpdate = true;
      }
      // 标签同样按相机距离缩放，保证屏幕字号恒定。
      const labelH = dist * 0.030 * (n.isRoot || isSel ? 1.15 : 1);
      sprite.scale.set(labelH * (tex.userData.aspect || 1), labelH, 1);
      sprite.position.set(x, y + r + labelH * 0.85, z);
      sprite.material.opacity = n.released ? 0.45 : 1;
      sprite.visible = true;

      if (n.lastPulse > 0 && seenPulse.get(n.addr) !== n.lastPulse) {
        seenPulse.set(n.addr, n.lastPulse);
        spawnPulse(n, r);
      }
    }

    nodesMesh.count = nodes.length;
    nodesMesh.instanceMatrix.needsUpdate = true;
    if (nodesMesh.instanceColor) nodesMesh.instanceColor.needsUpdate = true;
    // 实例位置每帧都在变，包围球必须失效，否则拾取会命中错误的位置。
    nodesMesh.boundingSphere = null;

    for (let i = nodes.length; i < sprites.length; i++) sprites[i].visible = false;

    // ---- 边 ----
    const pos = edgeGeo.attributes.position?.array;
    const col = edgeGeo.attributes.color?.array;
    if (pos && col) {
      let w = 0;
      for (let i = 0; i < edges.length; i++) {
        const a = byAddr.get(edges[i].source);
        const b = byAddr.get(edges[i].target);
        if (!a || !b) continue;
        pos[w] = a.x || 0; pos[w + 1] = a.y || 0; pos[w + 2] = a.z || 0;
        pos[w + 3] = b.x || 0; pos[w + 4] = b.y || 0; pos[w + 5] = b.z || 0;

        const hot = a.lastPulse > 0 && now - a.lastPulse < PULSE_MS
          || b.lastPulse > 0 && now - b.lastPulse < PULSE_MS
          || a.addr === selected || b.addr === selected;
        tmpColor.setHex(hot ? C.edgeHot : C.edge);
        col[w] = tmpColor.r; col[w + 1] = tmpColor.g; col[w + 2] = tmpColor.b;
        col[w + 3] = tmpColor.r; col[w + 4] = tmpColor.g; col[w + 5] = tmpColor.b;
        w += 6;
      }
      edgeGeo.setDrawRange(0, w / 3);
      edgeGeo.attributes.position.needsUpdate = true;
      edgeGeo.attributes.color.needsUpdate = true;
    }

    // ---- 选中环 ----
    const selNode = selected ? byAddr.get(selected) : null;
    if (selNode && !selNode.released) {
      const sd = Math.hypot(
        (selNode.x || 0) - cam.x, (selNode.y || 0) - cam.y, (selNode.z || 0) - cam.z,
      ) || REF_DIST;
      selRing.visible = true;
      selRing.position.set(selNode.x || 0, selNode.y || 0, selNode.z || 0);
      selRing.quaternion.copy(view.camera.quaternion);
      const s = radiusFor(selNode, true, sd) * 1.75;
      selRing.scale.set(s, s, 1);
    } else {
      selRing.visible = false;
    }

    // ---- 脉冲环 ----
    for (const p of pulses) {
      if (!p.mesh.visible) continue;
      const age = (now - p.t0) / PULSE_MS;
      const node = byAddr.get(p.addr);
      if (age >= 1 || !node) {
        p.mesh.visible = false;
        continue;
      }
      p.mesh.position.set(node.x || 0, node.y || 0, node.z || 0);
      p.mesh.quaternion.copy(view.camera.quaternion);
      const s = p.r0 * (1 + age * 2.0);
      p.mesh.scale.set(s, s, 1);
      p.mesh.material.opacity = 0.8 * (1 - age) ** 1.5;
    }
  }

  /** 包围盒留出节点半径与标签的富余，否则取景会把边缘节点裁掉一半。 */
  function bounds() {
    const box = new THREE.Box3();
    for (const n of state.nodes) {
      box.expandByPoint(new THREE.Vector3(n.x || 0, n.y || 0, n.z || 0));
    }
    if (!box.isEmpty()) box.expandByScalar(28);
    return box;
  }

  /** 屏幕归一化坐标 -> 命中的节点。仅在鼠标抬起时调用，重建包围球的开销可忽略。 */
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function pick(ndcX, ndcY) {
    if (!nodesMesh || nodesMesh.count === 0) return null;
    pointer.set(ndcX, ndcY);
    raycaster.setFromCamera(pointer, view.camera);
    raycaster.params.Points = { threshold: 0.1 };
    const hits = raycaster.intersectObject(nodesMesh, false);
    if (!hits.length || hits[0].instanceId === undefined) return null;
    return state.nodes[hits[0].instanceId] || null;
  }

  return {
    update,
    bounds,
    pick,
    group,
    dispose() {
      view.scene.remove(group);
      sphereGeo.dispose();
      nodeMat.dispose();
      ringGeo.dispose();
      for (const tex of labelCache.values()) tex.dispose();
      labelCache.clear();
    },
  };
}
