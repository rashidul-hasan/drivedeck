'use strict';
// The external tools DriveDeck uses, how to find them and how to install them on each OS:
//   rclone  required: talks to the cloud drives
//   ffmpeg  optional: photo and video thumbnails
// Where a package manager installs without admin rights or questions (Homebrew on macOS, winget on
// Windows), the setup screen offers a one-click install after the user confirms. Otherwise, and as a
// fallback, it shows the steps to do it by hand.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const exe = name => WIN ? name + '.exe' : name;
const isFile = p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
const readdir = d => { try { return fs.readdirSync(d); } catch (_) { return []; } };
const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

const TOOLS = {
  rclone: { label: 'rclone', required: true, why: 'Connects DriveDeck to your cloud drives.', args: ['version'], re: /rclone (v\S+)/, brew: 'rclone', winget: 'Rclone.Rclone' },
  ffmpeg: { label: 'ffmpeg', required: false, why: 'Makes photo and video thumbnails. You can add it later from Settings.', args: ['-version'], re: /ffmpeg version (\S+)/, brew: 'ffmpeg', winget: 'Gyan.FFmpeg' },
};

// Package manager folders that may be missing from PATH. Right after winget installs something, for
// example, this process still has the old PATH.
function extraDirs(inst) {
  if (MAC) return inst ? [path.dirname(inst.path)] : [];
  if (WIN) return [
    path.join(localAppData(), 'Microsoft', 'WinGet', 'Links'),
    path.join(os.homedir(), 'scoop', 'shims'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin'),
  ];
  return ['/usr/local/bin', '/usr/bin', '/snap/bin', path.join(os.homedir(), '.local', 'bin')];
}
function which(name, dirs = []) {
  for (const d of [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...dirs]) {
    const p = path.join(d, exe(name));
    if (isFile(p)) return p;
  }
  return null;
}
// winget unpacks zip packages under %LOCALAPPDATA%\Microsoft\WinGet\Packages\<id>_<source>\...
function wingetPackage(id, name, depth = 3) {
  const root = path.join(localAppData(), 'Microsoft', 'WinGet', 'Packages');
  const search = (dir, d) => {
    if (isFile(path.join(dir, exe(name)))) return path.join(dir, exe(name));
    if (!d) return null;
    for (const s of readdir(dir)) { const hit = search(path.join(dir, s), d - 1); if (hit) return hit; }
    return null;
  };
  for (const d of readdir(root).filter(n => n.startsWith(id + '_'))) { const hit = search(path.join(root, d), depth); if (hit) return hit; }
  return null;
}
function versionOf(bin, t) {
  const r = spawnSync(bin, t.args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return (t.re.exec(r.stdout || '') || [])[1] || 'installed';
}

function installer() {
  if (MAC) {
    const brew = which('brew', ['/opt/homebrew/bin', '/usr/local/bin']);
    return brew && { kind: 'brew', label: 'Homebrew', path: brew };
  }
  if (WIN) {
    const winget = which('winget', [path.join(localAppData(), 'Microsoft', 'WindowsApps')]);
    return winget && { kind: 'winget', label: 'winget', path: winget };
  }
  return null;
}

// overrides: paths or command names from --rclone / --ffmpeg. They're tried first; if they don't work,
// the usual places are searched, so installing a tool fixes a wrong override too.
function detect(overrides = {}, inst = installer()) {
  const dirs = extraDirs(inst), out = {};
  for (const [key, t] of Object.entries(TOOLS)) {
    const o = overrides[key];
    const candidates = [o && (/[\\/]/.test(o) ? o : which(o, dirs)), which(key, dirs), WIN && wingetPackage(t.winget, key)];
    out[key] = { found: false, path: null, version: null };
    for (const p of new Set(candidates.filter(Boolean))) {
      const v = versionOf(p, t);
      if (v) { out[key] = { found: true, path: p, version: v }; break; }
    }
  }
  return out;
}

function installArgs(key, inst) {
  const t = TOOLS[key];
  if (inst?.kind === 'brew') return ['install', t.brew];
  // Without the agreement flags winget stops to ask, and nobody can answer from here.
  if (inst?.kind === 'winget') return ['install', '--id', t.winget, '--exact', '--source', 'winget', '--silent', '--accept-source-agreements', '--accept-package-agreements'];
  return null;
}
const displayCommand = (key, inst) => { const a = installArgs(key, inst); return a && [inst.kind, ...a].join(' '); };

function linuxFamily() {
  let t = '';
  try { t = fs.readFileSync('/etc/os-release', 'utf8'); } catch (_) {}
  const ids = ['ID', 'ID_LIKE'].map(k => (new RegExp(`^${k}="?([^"\\n]*)`, 'm').exec(t) || [])[1] || '').join(' ').toLowerCase();
  return /debian|ubuntu/.test(ids) ? 'apt' : /fedora|rhel|centos/.test(ids) ? 'dnf' : /arch/.test(ids) ? 'pacman' : /suse/.test(ids) ? 'zypper' : null;
}
const PKG = { apt: n => `sudo apt install ${n}`, dnf: n => `sudo dnf install ${n}`, pacman: n => `sudo pacman -S ${n}`, zypper: n => `sudo zypper install ${n}` };

// Steps for installing a tool by hand: [{ text, cmd?, url? }]
function manualSteps(key, inst) {
  const t = TOOLS[key];
  if (MAC) {
    const brewFirst = inst ? [] : [{ text: 'Install Homebrew. It asks for your Mac password.', cmd: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' }];
    return [...brewFirst,
      { text: inst ? 'In Terminal, run:' : `Then install ${t.label}:`, cmd: `brew install ${t.brew}` },
      key === 'rclone' ? { text: 'Or download rclone for macOS, unzip it and move it to /usr/local/bin.', url: 'https://rclone.org/downloads/' }
        : { text: 'Or download a macOS build of ffmpeg.', url: 'https://ffmpeg.org/download.html' }];
  }
  if (WIN) return [
    { text: 'In PowerShell or Terminal, run:', cmd: `winget install --id ${t.winget} -e` },
    key === 'rclone' ? { text: 'Or download the Windows zip, extract rclone.exe, and start DriveDeck with --rclone followed by its full path.', url: 'https://rclone.org/downloads/' }
      : { text: 'Or download a Windows build, extract it, and start DriveDeck with --ffmpeg followed by the full path to ffmpeg.exe.', url: 'https://www.gyan.dev/ffmpeg/builds/' }];
  const fam = linuxFamily();
  if (key === 'rclone') return [
    { text: 'In a terminal, run the official installer. It asks for your password.', cmd: 'sudo -v ; curl https://rclone.org/install.sh | sudo bash' },
    ...(fam ? [{ text: 'Or use your package manager (its version may be older):', cmd: PKG[fam]('rclone') }] : []),
  ];
  return [
    { text: 'In a terminal, run:', cmd: PKG[fam || 'apt']('ffmpeg') },
    ...(fam === 'dnf' ? [{ text: 'On Fedora, the full ffmpeg comes from RPM Fusion.', url: 'https://rpmfusion.org/Configuration' }] : []),
  ];
}

// Runs the install and reports output line by line. Progress bars rewrite their line with \r, so only
// the latest text of each line is kept. Resolves with the exit code.
function runInstall(key, inst, onLine) {
  return new Promise(resolve => {
    const p = spawn(inst.path, installArgs(key, inst), {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      // Don't upgrade things the user already has; this is about adding what's missing.
      env: { ...process.env, HOMEBREW_NO_INSTALL_UPGRADE: '1', HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1' },
    });
    const timer = setTimeout(() => p.kill(), 30 * 60 * 1000);
    const feed = () => { let buf = ''; return d => {
      const parts = (buf + d).split('\n'); buf = parts.pop();
      for (const l of parts) { const s = l.split('\r').filter(Boolean).pop()?.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd(); if (s) onLine(s); }
    }; };
    p.stdout.on('data', feed()); p.stderr.on('data', feed());
    p.on('error', e => { clearTimeout(timer); onLine(e.message); resolve(-1); });
    p.on('close', code => { clearTimeout(timer); resolve(code ?? -1); });
  });
}

module.exports = { TOOLS, installer, detect, installArgs, displayCommand, manualSteps, runInstall };
