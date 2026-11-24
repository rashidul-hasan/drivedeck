#!/usr/bin/env node
// Pre-publish safety checks. Run with `npm run check`.
// `npm publish` runs it with --release, which also refuses to publish from
// anywhere except the release workflow in the official GitHub repo.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPO = 'rashidul-hasan/drivedeck';
const ALLOWED = [/^bin\//, /^lib\//, /^public\//, /^README\.md$/, /^LICENSE$/, /^SECURITY\.md$/, /^package\.json$/];
const release = process.argv.includes('--release');
const errors = [];
const fail = (msg) => errors.push(msg);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// 1. No third-party code: DriveDeck ships with zero dependencies, and any
//    new one has to be added on purpose, here.
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
  if (pkg[field] && Object.keys(pkg[field]).length) fail(`package.json has ${field}; DriveDeck must stay dependency-free`);
}

// 2. Nothing runs on install. These hooks run on users' machines.
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'preuninstall', 'uninstall', 'postuninstall']) {
  if (pkg.scripts && pkg.scripts[hook]) fail(`package.json has a "${hook}" script; install hooks are not allowed`);
}

// 3. The package points at the official repo, so provenance can be checked against it.
if (!String(pkg.repository && pkg.repository.url).includes(`github.com/${REPO}`)) fail(`repository.url must point to github.com/${REPO}`);

// 4. The command starts with a shebang and every file parses.
const bin = path.join(ROOT, pkg.bin.drivedeck);
if (!fs.readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node')) fail(`${pkg.bin.drivedeck} must start with #!/usr/bin/env node`);
for (const dir of ['bin', 'lib', 'public']) {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    if (!f.endsWith('.js')) continue;
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, dir, f)], { encoding: 'utf8' });
    if (r.status !== 0) fail(`${dir}/${f} has a syntax error:\n${r.stderr}`);
  }
}

// 5. Only expected files go into the tarball (no .env, keys, notes or stray files).
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pack = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
if (pack.status !== 0) {
  fail(`npm pack failed:\n${pack.stderr}`);
} else {
  const files = JSON.parse(pack.stdout)[0].files.map((f) => f.path);
  for (const f of files) if (!ALLOWED.some((re) => re.test(f))) fail(`unexpected file in package: ${f}`);
  console.log(`package contents (${files.length} files) look right`);
}

// 6. Releases only come from the official repo's release workflow, for a tag
//    that matches the version. This stops an accidental `npm publish` from a
//    laptop; npm's trusted-publisher setting is what enforces it on the registry.
if (release) {
  const env = process.env;
  if (env.GITHUB_ACTIONS !== 'true') fail('publishing is only allowed from GitHub Actions. Push a version tag instead (see SECURITY.md)');
  if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== REPO) fail(`publishing is only allowed from ${REPO}, not ${env.GITHUB_REPOSITORY}`);
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF !== `refs/tags/v${pkg.version}`) fail(`tag ${env.GITHUB_REF} does not match package.json version v${pkg.version}`);
}

if (errors.length) {
  console.error(`\n✗ ${errors.length} problem(s):\n- ${errors.join('\n- ')}\n`);
  process.exit(1);
}
console.log(release ? '✓ release checks passed' : '✓ checks passed');
