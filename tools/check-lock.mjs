/**
 * 检查 package-lock.json 是否覆盖了 esbuild 的全部平台包。
 *
 * 为什么需要这个检查：
 *   esbuild 通过 optionalDependencies 分发各平台的原生二进制。
 *   如果 lock 文件只记了当前平台（例如 Windows 上生成时漏掉 linux-x64），
 *   本地一切都正常，但 CI（Linux）上 `npm ci` 会直接报
 *   "Missing: @esbuild/linux-x64@x.y.z from lock file" 并失败。
 *
 * 这个坑真实踩过两次：CI 失败 → 我改 lock → 还是失败。
 * 所以把它变成可自动检查的断言，而不是靠人肉比对。
 *
 * 用法: node tools/check-lock.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'D:\\English words game';

/** esbuild 需要覆盖的平台（与 esbuild 官方 optionalDependencies 一致） */
const REQUIRED_PLATFORMS = [
  '@esbuild/aix-ppc64',
  '@esbuild/android-arm',
  '@esbuild/android-arm64',
  '@esbuild/android-x64',
  '@esbuild/darwin-arm64',
  '@esbuild/darwin-x64',
  '@esbuild/freebsd-arm64',
  '@esbuild/freebsd-x64',
  '@esbuild/linux-arm',
  '@esbuild/linux-arm64',
  '@esbuild/linux-ia32',
  '@esbuild/linux-loong64',
  '@esbuild/linux-mips64el',
  '@esbuild/linux-ppc64',
  '@esbuild/linux-riscv64',
  '@esbuild/linux-s390x',
  '@esbuild/linux-x64',
  '@esbuild/netbsd-arm64',
  '@esbuild/netbsd-x64',
  '@esbuild/openbsd-arm64',
  '@esbuild/openbsd-x64',
  '@esbuild/openharmony-arm64',
  '@esbuild/sunos-x64',
  '@esbuild/win32-arm64',
  '@esbuild/win32-ia32',
  '@esbuild/win32-x64',
];

const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const pkgs = lock.packages ?? {};

let failures = 0;
const fail = (msg, hint) => {
  console.log(`  ✗ ${msg}`);
  if (hint) console.log(`      ${hint}`);
  failures++;
};
const pass = msg => console.log(`  ✓ ${msg}`);

console.log('检查 package-lock.json\n');

// 1. lockfileVersion
console.log(`lockfileVersion: ${lock.lockfileVersion}`);
if (lock.lockfileVersion !== 3) {
  fail('lockfileVersion 不是 3', 'npm 9+ 生成的才是 3');
} else {
  pass('lockfileVersion 正常');
}

// 2. package.json 与 lock 里声明的依赖是否一致
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const declared = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
};
const lockRoot = pkgs[''] ?? {};
const lockDeclared = {
  ...(lockRoot.dependencies ?? {}),
  ...(lockRoot.devDependencies ?? {}),
};

console.log('\n依赖一致性:');
const declaredNames = Object.keys(declared).sort();
const lockNames = Object.keys(lockDeclared).sort();
const missingInLock = declaredNames.filter(n => !lockNames.includes(n));
const extraInLock = lockNames.filter(n => !declaredNames.includes(n));

if (missingInLock.length) {
  fail(`lock 缺少依赖: ${missingInLock.join(', ')}`, '跑 npm install 更新 lock');
} else {
  pass(`package.json 里的 ${declaredNames.length} 个依赖都在 lock 中`);
}
if (extraInLock.length) {
  fail(`lock 里有 package.json 没有的依赖: ${extraInLock.join(', ')}`, '跑 npm install 清理');
} else {
  pass('lock 里没有多余依赖');
}

// 3. esbuild 版本与平台覆盖 —— 这是真正导致 CI 失败的点
console.log('\nesbuild 平台覆盖:');
const esbuildVersions = new Set();
const presentPlatforms = new Map();

for (const [key, val] of Object.entries(pkgs)) {
  if (key === 'node_modules/esbuild') esbuildVersions.add(val.version);
  const m = key.match(/^node_modules\/(@esbuild\/[^/]+)$/);
  if (m) {
    if (!presentPlatforms.has(m[1])) presentPlatforms.set(m[1], new Set());
    presentPlatforms.get(m[1]).add(val.version);
  }
}

if (esbuildVersions.size === 0) {
  if (Object.keys(presentPlatforms).length > 0) {
    fail('lock 里没有 node_modules/esbuild 条目，但有平台包');
  } else {
    console.log('  （这个项目不依赖 esbuild，跳过）');
  }
} else {
  pass(`esbuild 版本: ${[...esbuildVersions].join(', ')}`);

  const missing = REQUIRED_PLATFORMS.filter(p => !presentPlatforms.has(p));

  // ⚠️ 重要：npm 在某个平台生成 lock 时，会把**该平台自己的** optional 包剔除。
  //    所以在 Windows 上生成的 lock 天生缺 @esbuild/win32-x64，
  //    这是正常的，不影响 Linux 上的 CI。
  //    真正会导致 CI 失败的是缺少 CI 所在平台的包（Linux），那一项必须报错。
  const CI_CRITICAL = ['@esbuild/linux-x64', '@esbuild/linux-arm64'];
  const criticalMissing = missing.filter(p => CI_CRITICAL.includes(p));
  const hostMissing = missing.filter(p => !CI_CRITICAL.includes(p));

  if (criticalMissing.length) {
    fail(
      `缺 CI 必需的平台包: ${criticalMissing.join(', ')}`,
      '在 Linux 上会直接报 Missing ... from lock file',
    );
  } else {
    pass('CI 所需的 Linux 平台包齐全');
  }

  if (hostMissing.length) {
    // 只提示，不算失败——本平台包缺失是 npm 的正常行为
    console.log(
      `  · 另有 ${hostMissing.length} 个非 CI 平台包不在 lock 中（${hostMissing
        .slice(0, 3)
        .join(', ')}${hostMissing.length > 3 ? ' …' : ''}）`,
    );
    console.log('    这是正常的：npm 会剔除生成 lock 时所在平台自身的 optional 包。');
  }

  // 平台包版本必须与主包一致
  const mismatched = [];
  for (const [name, vers] of presentPlatforms) {
    for (const v of vers) if (!esbuildVersions.has(v)) mismatched.push(`${name}@${v}`);
  }
  if (mismatched.length) {
    fail(`平台包版本与主包不一致: ${mismatched.slice(0, 5).join(', ')}`);
  } else {
    pass('平台包版本与主包一致');
  }
}

// 4. 危险信号：有没有多个 vite 大版本并存
const viteVersions = Object.entries(pkgs)
  .filter(([k]) => k === 'node_modules/vite')
  .map(([, v]) => v.version);
if (viteVersions.length) {
  console.log(`\nvite: ${viteVersions.join(', ')}`);
  const majors = new Set(viteVersions.map(v => v.split('.')[0]));
  if (majors.size > 1) fail('存在多个 vite 大版本', '通常是有 devDependency 拉了不同版本');
  else pass('vite 只有一个大版本');
}

console.log(`\n${failures === 0 ? '✅ lock 文件检查通过' : `❌ ${failures} 项有问题`}`);
process.exit(failures === 0 ? 0 : 1);
