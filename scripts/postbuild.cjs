// ncc misses libpg-query's lazily-loaded wasm asset; copy it into dist.
const { copyFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'node_modules', 'libpg-query', 'wasm', 'libpg-query.wasm');
const dst = path.join(__dirname, '..', 'dist', 'libpg-query.wasm');
if (!existsSync(src)) {
  console.error(`missing ${src}`);
  process.exit(1);
}
copyFileSync(src, dst);
console.log(`copied ${path.basename(src)} -> dist/`);
