// 把 IObject 官方 JS 客户端（third_party/IObject/js，TypeScript）打包成
// 浏览器可直接 <script> 加载的单文件：ui/vendor/iobject-sdk.js（IIFE，全局名 IObjectSDK）。
//
// 前置条件（仅一次）：
//   cd third_party/IObject/js && pnpm install   # 拉取 @msgpack/msgpack + typescript
//
// 然后在本目录执行：
//   pnpm install            # 拉取 esbuild（devDependency）
//   pnpm build:sdk          # 运行本脚本
//
// 产物：ui/vendor/iobject-sdk.js（已内联 @msgpack/msgpack，前端无运行时依赖）。
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkEntry = resolve(here, '..', 'third_party', 'IObject', 'js', 'src', 'index.ts');
const sdkNodeModules = resolve(here, '..', 'third_party', 'IObject', 'js', 'node_modules');
const outfile = resolve(here, 'vendor', 'iobject-sdk.js');

// 友好前置检查：esbuild 会从 SDK 自身 node_modules 解析 @msgpack/msgpack，必须先装好。
if (!existsSync(resolve(sdkNodeModules, '@msgpack', 'msgpack'))) {
  console.error(
    '[build-sdk] 缺少 @msgpack/msgpack。请先执行：\n' +
    '  cd third_party/IObject/js && pnpm install\n' +
    '（需要联网；安装后回到 ui/ 重新运行 pnpm build:sdk）',
  );
  process.exit(1);
}

await build({
  entryPoints: [sdkEntry],
  bundle: true,
  format: 'iife',
  globalName: 'IObjectSDK',
  platform: 'browser',
  target: ['es2020'],
  outfile,
  logLevel: 'info',
});

console.log('[build-sdk] 已生成 ' + outfile);
