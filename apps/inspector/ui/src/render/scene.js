// Three.js 场景外壳：渲染器 / 相机 / 轨道控制 / 渲染循环。
// 只负责"舞台"，不含任何节点语义 —— 那些在 graph.js。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// 底色必须与 styles/app.css 的 --bg 完全一致 —— 差一点点，画布就会像贴上去的补丁。
const BG = 0x000000;

export function webglSupported() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function createScene(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth || 1, host.clientHeight || 1, false);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 900, 2600);

  const camera = new THREE.PerspectiveCamera(
    48,
    (host.clientWidth || 1) / (host.clientHeight || 1),
    0.5,
    8000,
  );
  // 初始用 3/4 视角：正对 +z 时深度完全看不出来，节点在屏幕上会互相压住。
  camera.position.set(150, 105, 250);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.85;
  controls.minDistance = 25;
  controls.maxDistance = 4000;

  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.45);
  key.position.set(160, 240, 300);
  scene.add(key);
  // 补光换成品牌橙：暗面不会糊成一团黑，而是透出一点暖调——和面板里的强调色呼应。
  const rim = new THREE.DirectionalLight(0xff9000, 0.45);
  rim.position.set(-220, -140, -200);
  scene.add(rim);

  // 地面参考网格：给 3D 布局一个"地平线"，也让终端味的画面不至于空得发飘。
  // 颜色压到最暗的两级，靠雾自然收边，绝不能抢节点的视觉权重。
  const grid = new THREE.GridHelper(2400, 48, 0x333333, 0x1a1a1a);
  grid.position.y = -0.5;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  grid.material.depthWrite = false;
  scene.add(grid);

  const frames = new Set();

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    for (const fn of [...frames]) {
      try { fn(); } catch (e) { console.error('[scene] 帧回调抛异常', e); }
    }
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  return {
    kind: 'webgl',
    renderer,
    scene,
    camera,
    controls,
    addFrame(fn) { frames.add(fn); return () => frames.delete(fn); },
    /** 让相机注视当前图的包围盒。 */
    frameAll(box) {
      if (!box || box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 40);
      const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.35;
      controls.target.copy(center);
      const dir = camera.position.clone().sub(center).normalize();
      if (dir.lengthSq() < 1e-6) dir.set(0, 0.22, 1).normalize();
      camera.position.copy(center).addScaledVector(dir, dist);
      // near/far 保持固定，避免反复取景后把远处的节点裁掉。
      camera.updateProjectionMatrix();
      controls.maxDistance = Math.max(dist * 6, 1200);
      controls.update();
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      frames.clear();
      controls.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
