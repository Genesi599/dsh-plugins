#!/usr/bin/env node
/**
 * dsh-hub-suite 安装器 —— 把 AI-Agent-Hub 的一整套 DSH 插件装进本机 profile。
 *
 * 做三件事：
 *   ① 在 profile 的 package.json 里登记依赖（套装 + 4 个前端 bundle 包）
 *   ② 用该 profile 自己的包管理器安装（npm，或有 pnpm-lock 时用 pnpm）
 *   ③ 把 bundle 名字写进 dsh.profile.bundles（不写进去插件不会加载）
 *
 * 用法：
 *   npx dsh-hub-suite                 # 装到 ~/.dsh/profiles/* 下所有带 package.json 的 profile
 *   npx dsh-hub-suite --dry-run       # 只看计划，不动文件
 *   npx dsh-hub-suite --no-install    # 只改 package.json，不跑 npm/pnpm install
 *   npx dsh-hub-suite --profile <dir> # 指定单个 profile 目录
 *
 * 说明：host-only 的 4 个插件（reminders / tool-policy / curator / branch）由套装自带的
 * cordis.patch.yml 挂载；带前端的一半（desktop-ui / project-room / callout / quota-panel）
 * 必须各自作为 bundle 登记，所以下面 BUNDLES 里列全。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 需要登记成 bundle 的包（顺序无关）。 */
const BUNDLES = [
  'dsh-hub-suite',
  'dsh-hub-desktop-ui',
  'dsh-project-room',
  'dsh-hub-callout',
  'dsh-hub-quota-panel',
];

/** 需要写进 profile dependencies 的包；四个 host-only 插件由 suite 依赖带入。 */
const DEPS = {
  'dsh-hub-suite': '^0.1.1',
  'dsh-hub-desktop-ui': '^0.2.3',
  'dsh-project-room': '^0.2.3',
  'dsh-hub-callout': '^0.1.1',
  'dsh-hub-quota-panel': '^0.1.2',
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dryRun = flag('--dry-run') || flag('-n');
const skipInstall = flag('--no-install');
const explicitProfile = valueOf('--profile');

const say = (msg = '') => console.log(msg);
const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

/** 找出要处理的 profile 目录。 */
function findProfiles() {
  if (explicitProfile) {
    const dir = resolvePath(explicitProfile.replace(/^~(?=$|[\\/])/, homedir()));
    if (!existsSync(join(dir, 'package.json'))) fail(`不是一个 DSH profile（缺 package.json）：${dir}`);
    return [dir];
  }
  const root = join(homedir(), '.dsh', 'profiles');
  if (!existsSync(root)) fail(`找不到 ${root} —— 这台机器装过 DSH 桌面版吗？可用 --profile 指定目录`);
  const found = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'package.json')))
    .map((e) => join(root, e.name));
  if (found.length === 0) fail(`${root} 下没有含 package.json 的 profile`);
  return found;
}

/** 选包管理器：有 pnpm-lock.yaml 且能调起 pnpm 就用 pnpm，否则 npm。 */
function pickPM(dir) {
  const hasPnpmLock = existsSync(join(dir, 'pnpm-lock.yaml'));
  if (hasPnpmLock) {
    const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (probe.status === 0) return 'pnpm';
    warn('发现 pnpm-lock.yaml 但调不起 pnpm，回落 npm');
  }
  return 'npm';
}

function installProfile(dir) {
  step(`处理 profile: ${dir}`);
  const pkgPath = join(dir, 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);

  // ① 依赖
  const deps = (pkg.dependencies ||= {});
  const missing = Object.entries(DEPS).filter(([name]) => !deps[name]);
  if (missing.length === 0) ok('依赖已齐全');
  else {
    for (const [name, range] of missing) {
      say(`    + dependencies["${name}"] = "${range}"`);
      if (!dryRun) deps[name] = range;
    }
  }

  // ② bundles
  const profileBlock = ((pkg.dsh ||= {}).profile ||= {});
  const bundles = (profileBlock.bundles ||= []);
  const addBundles = BUNDLES.filter((n) => !bundles.includes(n));
  if (addBundles.length === 0) ok('bundles 已齐全');
  else {
    for (const n of addBundles) {
      say(`    + dsh.profile.bundles += "${n}"`);
      if (!dryRun) bundles.push(n);
    }
  }

  // 落盘（先备份）
  if (!dryRun && (missing.length || addBundles.length)) {
    const backup = `${pkgPath}.bak-suite-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(pkgPath, backup);
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    ok(`已写入 package.json（备份 ${backup.slice(dirname(backup).length + 1)}）`);
  }

  // ③ 安装
  if (skipInstall) { warn('按 --no-install 跳过安装步骤'); return { installed: false }; }
  const pm = pickPM(dir);
  const argv = pm === 'pnpm' ? ['install', '--config.confirmModulesPurge=false'] : ['install', '--no-audit', '--no-fund', '--prefer-online'];
  step(`安装依赖（${pm} ${argv.join(' ')}）`);
  if (dryRun) { warn('dry-run：不实际执行'); return { installed: false }; }
  const r = spawnSync(pm, argv, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`${pm} install 失败（退出码 ${r.status}）—— 请手动在 ${dir} 里跑一次 ${pm} install 看报错`);
  ok('依赖安装完成');
  return { installed: true };
}

// ── main ────────────────────────────────────────────────────────────────
say('AI-Agent-Hub · DSH 插件套装安装器');
say(`  模式: ${dryRun ? '演练（不改任何文件）' : skipInstall ? '只改配置、不安装' : '实际安装'}`);
say(`  将登记 bundle: ${BUNDLES.join(', ')}`);

const profiles = findProfiles();
say(`  找到 ${profiles.length} 个 profile`);

let installedAny = false;
for (const dir of profiles) {
  const r = installProfile(dir);
  installedAny = installedAny || r.installed;
}

step('完成');
if (installedAny) {
  say('  重启 DSH 后，插件管理器里应能看到这整套插件。');
  say('  没看到的话先确认 profile 的 package.json 里 dsh.profile.bundles 已含上述 5 个名字。');
} else {
  say('  配置已写好，请自己在 profile 目录里跑一次安装命令，然后重启 DSH。');
}
