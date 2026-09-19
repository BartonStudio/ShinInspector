// 布局：d3-force-3d 算位置，渲染层只负责画。
// 手动 tick 而不是让 d3 自己跑定时器，这样布局推进与渲染帧严格同步，也方便"冻结"。

import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceZ,
} from 'd3-force-3d';
import { state } from '../store.js';

const SHELL_GAP = 105;

export function createLayout() {
  let mode = 'force';

  const sim = forceSimulation([], 3)
    .stop()
    .alphaDecay(0.035)
    .velocityDecay(0.36);

  function rebuild() {
    const nodes = state.nodes;
    const links = state.edges.map((e) => ({ source: e.source, target: e.target }));

    sim.nodes(nodes);
    sim.force('link', forceLink(links).id((d) => d.addr).distance(96).strength(0.6));
    sim.force('charge', forceManyBody().strength(-420));
    sim.force('center', forceCenter(0, 0, 0));
    sim.force('z', forceZ(0).strength(0.045));
    sim.force('collide', forceCollide(42));

    if (mode === 'radial') applyRadial();
    sim.alpha(nodes.length > 1 ? 0.95 : 0.3);
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    if (mode === 'radial') {
      applyRadial();
    } else {
      for (const n of state.nodes) { n.fx = null; n.fy = null; n.fz = null; }
      sim.alpha(0.7);
    }
  }

  /** 径向：按深度分同心球壳，用 Fibonacci 球面分布避免同层节点重叠。 */
  function applyRadial() {
    const shells = new Map();
    for (const n of state.nodes) {
      const d = n.depth ?? 1;
      if (!shells.has(d)) shells.set(d, []);
      shells.get(d).push(n);
    }
    for (const [depth, arr] of shells) {
      const r = depth * SHELL_GAP;
      arr.forEach((n, i) => {
        if (depth === 0) {
          n.fx = 0; n.fy = 0; n.fz = 0;
          return;
        }
        const phi = Math.acos(1 - (2 * (i + 0.5)) / arr.length);
        const theta = Math.PI * (1 + Math.sqrt(5)) * (i + 0.5);
        n.fx = r * Math.sin(phi) * Math.cos(theta);
        n.fy = r * Math.cos(phi);
        n.fz = r * Math.sin(phi) * Math.sin(theta);
      });
    }
    sim.alpha(0.4);
  }

  function tick() {
    if (state.ui.frozen) return;
    if (sim.alpha() < 0.005) return;
    sim.tick();
  }

  function reheat(alpha = 0.4) {
    sim.alpha(alpha);
  }

  return {
    rebuild, setMode, tick, reheat,
    mode: () => mode,
    alpha: () => sim.alpha(),
    simulation: sim,
  };
}
