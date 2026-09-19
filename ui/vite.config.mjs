// ShinInspector 前端 Vite 配置。
// 前端源码根 = 本目录（ui/）。SDK 源码在 ../third_party/IObject/js（位于 ui/ 之外），
// 通过 alias + server.fs.allow 引入；Vite 用 esbuild 即时转译 TS，无需手动编译。
import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const sdkEntry = resolve(repoRoot, 'third_party', 'IObject', 'js', 'src', 'index.ts');

export default defineConfig({
  resolve: {
    alias: {
      // 直接引用官方 iobject-js SDK 的 TypeScript 源码（前端 import 'iobject-js'）。
      'iobject-js': sdkEntry,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 8848,        // 与 src/App.cpp 的 SetStartupURL 端口一致
    strictPort: true,
    fs: {
      // 允许 dev server 读取仓库根（SDK 源码在 ui/ 之外，默认 allow 列表会拦它）。
      allow: [repoRoot],
    },
  },
  build: {
    // 单页应用：只构建 index.html。
    // 原 settings.html 已删除 —— 它存在的唯一理由是 IPC/WS 二选一，现在只剩 WS。
    rollupOptions: {
      input: resolve(here, 'index.html'),
    },
  },
  appType: 'spa',
});
