#!/usr/bin/env node
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const NATIVE = require('../lib/native-thumbs');
const createTransfers = require('../lib/transfers');
const createSearch = require('../lib/search');
const createBackups = require('../lib/backups');
const createSetupFiles = require('../lib/setup-file');
const deps = require('../lib/deps');
const createOAuth = require('../lib/oauth');
const { ZipWriter } = require('../lib/zip');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i > -1 && args[i + 1] ? args[i + 1] : def; };

if (args.includes('-h') || args.includes('--help')) {
  console.log(`DriveDeck - all your cloud drives in one place, powered by rclone

Usage: npx drivedeck [options]

  --port <n>      port for the dashboard (default 5573)
  --rclone <cmd>  path to the rclone binary (default: rclone)
  --ffmpeg <cmd>  path to ffmpeg, used for photo and video thumbnails (default: ffmpeg)
  --no-open       don't open the browser automatically
  -h, --help      show this help

If rclone or ffmpeg is missing, the browser opens a setup screen that helps install them.`);
  process.exit(0);
}

const PORT = parseInt(opt('--port', '5573'), 10);
const RCLONE_OPT = opt('--rclone', 'rclone');
const FFMPEG_OPT = opt('--ffmpeg', 'ffmpeg');
const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/_ui/app.css': 'app.css', '/_ui/app.js': 'app.js', '/_ui/i18n-bn.js': 'i18n-bn.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
// The page and its scripts are read once, so a running DriveDeck always serves the UI that matches its own
// code, even if the files on disk change while it runs (an update, or a newer checkout).
const ASSETS = Object.fromEntries(Object.entries(STATIC).map(([url, f]) => [url, fs.readFileSync(path.join(PUBLIC, f))]));
const SESSION_DAYS = 30;   // the key changes on every launch, so this only matters while this process runs

// Drive colors, emoji and UI preferences live next to (not inside) the rclone config.
const HOME = path.join(os.homedir(), '.drivedeck');
const CONFIG = path.join(HOME, 'config.json');
const THUMBS = path.join(HOME, 'thumbs');
const INDEX = path.join(HOME, 'index');   // search index, one file per drive
const BACKUPS = path.join(HOME, 'backups.json');
const UPLOADS = path.join(os.tmpdir(), `drivedeck-uploads-${PORT}`);   // files waiting to be uploaded by rclone

// Find rclone and ffmpeg. A missing rclone doesn't stop DriveDeck: the browser opens a setup screen that
// helps install it, and rclone is started as soon as it's found.
let inst = deps.installer();
let tools = deps.detect({ rclone: RCLONE_OPT, ffmpeg: FFMPEG_OPT }, inst);
const hasFfmpeg = () => tools.ffmpeg.found;
const hasSips = process.platform === 'darwin';
// Settings saved before the project was renamed (in ~/.rcloud-ui) move over the first time DriveDeck starts.
const OLD_HOME = path.join(os.homedir(), '.rcloud-ui');
try { if (!fs.existsSync(HOME) && fs.existsSync(OLD_HOME)) fs.renameSync(OLD_HOME, HOME); } catch (_) {}
try { fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); } catch (_) {}
if (tools.rclone.found) console.log(`rclone ${tools.rclone.version}`);
else {
  const step = deps.manualSteps('rclone', inst).find(x => x.cmd);
  console.log(`rclone isn't installed yet. DriveDeck needs it to reach your cloud drives.\nThe link below opens a setup screen that helps you install it${step ? `, or run:\n\n  ${step.cmd}\n` : '.'}`);
}
if (!tools.ffmpeg.found) console.log('ffmpeg isn\'t installed (optional, for thumbnails). You can add it from Settings > Set up tools.');

// Reuse an rclone config password stored in macOS Keychain, if there is one.
const env = { ...process.env };
if (!env.RCLONE_CONFIG_PASS && process.platform === 'darwin') {
  const k = spawnSync('security', ['find-generic-password', '-s', 'rclone-config', '-w'], { encoding: 'utf8' });
  if (k.status === 0 && k.stdout.trim()) env.RCLONE_CONFIG_PASS = k.stdout.trim();
}

const SIGNED_OUT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DriveDeck</title><meta name="color-scheme" content="light dark"><style>
:root{--bg:#f2f3f5;--card:#fff;--ink:#1c2028;--mute:#6b7280;--code:#f6f7f9}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f13;--card:#16181e;--ink:#e8eaee;--mute:#8c93a0;--code:#1b1e25}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
main{max-width:440px;background:var(--card);border-radius:18px;padding:28px;box-shadow:0 1px 2px rgba(0,0,0,.06),0 0 0 1px rgba(0,0,0,.05)}
h1{font:700 21px/1.25 ui-rounded,system-ui,sans-serif;margin:0 0 8px}p{margin:0 0 12px;color:var(--mute)}b{color:var(--ink);font-weight:600}
code{background:var(--code);padding:2px 6px;border-radius:6px;font:13px ui-monospace,Menlo,monospace;color:var(--ink)}
</style></head><body><main><h1>Open DriveDeck from your terminal</h1>
<p>DriveDeck is running, but this browser isn't signed in to it. For your security it only opens from the private link it prints when it starts.</p>
<p><b>Go to the terminal where DriveDeck is running and press Enter</b> to open it here, or copy the link that starts with <code>http://127.0.0.1:${PORT}/?k=</code>.</p>
<p>If you restarted DriveDeck, use the new link it printed.</p></main></body></html>`;

const freePort = () => new Promise(resolve => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const waitForPort = port => new Promise(resolve => {
  const attempt = () => {
    const c = net.connect(port, '127.0.0.1');
    c.on('connect', () => { c.destroy(); resolve(); });
    c.on('error', () => setTimeout(attempt, 250));
  };
  attempt();
});
const openBrowser = url => {
  const [cmd, a] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch (_) {}
};

// ---- UI config (~/.drivedeck/config.json) ----

let configMemo = null;
const readConfig = () => {
  if (configMemo) return configMemo;
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const obj = v => v && typeof v === 'object' ? v : {};
    configMemo = { drives: obj(c.drives), prefs: obj(c.prefs), usage: obj(c.usage), ...(c.google?.clientId && { google: c.google }) };
  } catch (_) { configMemo = { drives: {}, prefs: {}, usage: {} }; }
  return configMemo;
};
const writeConfig = c => {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const tmp = CONFIG + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...c }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG);
  configMemo = c;
};
const MB = 1024 * 1024;
const CACHE_LIMITS = [0, 250 * MB, 500 * MB, 1024 * MB, 2048 * MB, 5120 * MB, 10240 * MB];   // 0 = no limit
const cacheLimit = () => readConfig().prefs.cacheMax ?? 1024 * MB;
const autoThumbs = () => readConfig().prefs.thumbs !== false;
const PREFS = {
  view: v => ['grid', 'list'].includes(v),
  theme: v => ['auto', 'light', 'dark'].includes(v),
  sort: v => v && ['name', 'size', 'modified'].includes(v.key) && [1, -1].includes(v.dir),
  thumbs: v => typeof v === 'boolean',
  cacheMax: v => CACHE_LIMITS.includes(v),
  setupDone: v => typeof v === 'boolean',
  index: v => typeof v === 'boolean',
  lang: v => ['en', 'bn'].includes(v),
};
// Merges a patch like { drives: { mega1: { color, emoji } | null }, prefs: { view: 'grid' },
// usage: { mega1: { used, total, free } | null }, google: { clientId, clientSecret } | null }.
// Usage is the last known storage use of each drive, shown at startup while fresh numbers load.
// google is the user's own Google app, used to sign in when they add a Google Drive.
const patchConfig = patch => {
  const c = structuredClone(readConfig());
  for (const [name, d] of Object.entries(patch.drives || {})) {
    if (!/^[\w.\- ]{1,64}$/.test(name)) throw new Error('invalid drive name');
    if (d === null) { delete c.drives[name]; delete c.usage[name]; continue; }
    const next = { ...c.drives[name] };
    if (d.color !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(d.color)) throw new Error('invalid color');
      next.color = d.color.toLowerCase();
    }
    if (d.emoji !== undefined) {
      if (typeof d.emoji !== 'string' || !d.emoji.trim() || d.emoji.length > 32) throw new Error('invalid emoji');
      next.emoji = d.emoji.trim();
    }
    c.drives[name] = next;
  }
  for (const [name, u] of Object.entries(patch.usage || {})) {
    if (!/^[\w.\- ]{1,64}$/.test(name)) throw new Error('invalid drive name');
    if (u === null) { delete c.usage[name]; continue; }
    const n = v => v == null || (Number.isFinite(v) && v >= 0);
    if (!u || !n(u.used) || !n(u.total) || !n(u.free)) throw new Error('invalid usage');
    c.usage[name] = { used: u.used ?? null, total: u.total ?? null, free: u.free ?? null, checked: Date.now() };
  }
  for (const [k, v] of Object.entries(patch.prefs || {})) {
    if (!PREFS[k] || !PREFS[k](v)) throw new Error('invalid preference: ' + k);
    c.prefs[k] = v;
  }
  if (patch.google === null) delete c.google;
  else if (patch.google !== undefined) {
    const g = patch.google || {};
    if (!GOOGLE_ID.test(g.clientId || '') || !GOOGLE_SECRET.test(g.clientSecret || '')) throw new Error('invalid Google app');
    c.google = { clientId: g.clientId, clientSecret: g.clientSecret };
  }
  writeConfig(c);
  return c;
};
const GOOGLE_ID = /^[\w.-]{1,200}\.apps\.googleusercontent\.com$/;
const GOOGLE_SECRET = /^[\w-]{10,100}$/;
// Drive types that sign in through the browser, and the settings their new drives get.
// ask: rclone has questions after signing in (OneDrive: which drive to use), which the user answers.
const OAUTH = { drive: { scope: 'drive' }, dropbox: {}, onedrive: { ask: true } };
// rclone's next setup question (from config/create or config/update with nonInteractive), for the page.
const question = r => r?.State && r.Option ? { state: r.State, name: r.Option.Name, type: r.Option.Type || '', help: r.Option.Help || '', default: r.Option.Default ?? '',
  examples: (r.Option.Examples || []).map(x => ({ value: String(x.Value), help: x.Help || '' })), exclusive: !!r.Option.Exclusive, error: r.Error || '' } : null;
// rclone's own sign-in questions come first ("Token already configured - replace it?", then whether to open a
// browser). The token was just saved, so the answer is always to keep it: never let rclone start a sign-in.
const OAUTH_KEEP = { config_refresh_token: 'false' };
const readBody = (req, limit) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', d => { size += d.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(d); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

// ---- Thumbnails (~/.drivedeck/thumbs) ----
// Providers with a thumbnail API (lib/native-thumbs.js) are asked first. Otherwise, if the user allows it,
// ffmpeg makes one straight from rclone's file server (it seeks with range requests, so a video thumbnail
// doesn't download the whole file). On macOS, sips covers images ffmpeg can't decode, like HEIC.
// The cache is trimmed oldest-used first once it grows past the size limit in settings.

const THUMB_SIZE = 360;
const SIPS_MAX = 80 * 1024 * 1024;
let running = 0; const waiting = []; const inflight = new Map();
const SKIPPED = Symbol('skipped');
const slot = () => new Promise(r => { if (running < 3) { running++; r(); } else waiting.push(r); });
const release = () => { const next = waiting.shift(); if (next) next(); else running--; };

const cache = { bytes: 0, files: 0 };
const readdir = d => { try { return fs.readdirSync(d); } catch (_) { return []; } };
const cacheFiles = () => {
  const out = [];
  for (const d of readdir(THUMBS)) for (const f of readdir(path.join(THUMBS, d))) {
    const file = path.join(THUMBS, d, f);
    try { const st = fs.statSync(file); if (st.isFile()) out.push({ file, size: st.size, used: st.mtimeMs }); } catch (_) {}
  }
  return out;
};
const recount = (files = cacheFiles()) => { cache.files = files.length; cache.bytes = files.reduce((n, f) => n + f.size, 0); return files; };
const trimCache = () => {
  const max = cacheLimit();
  if (!max || cache.bytes <= max) return;
  for (const f of recount().sort((a, b) => a.used - b.used)) {
    if (cache.bytes <= max * 0.9) break;
    try { fs.unlinkSync(f.file); cache.bytes -= f.size; cache.files--; } catch (_) {}
  }
};
const clearCache = () => { fs.rmSync(THUMBS, { recursive: true, force: true }); recount([]); };
const cacheInfo = () => ({ ...cache, max: cacheLimit(), dir: THUMBS });

const run = (cmd, argv, timeoutMs) => new Promise(resolve => {
  const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'ignore'] });
  const out = [];
  const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
  p.stdout.on('data', d => out.push(d));
  p.on('error', () => { clearTimeout(timer); resolve(null); });
  p.on('close', code => { clearTimeout(timer); const b = Buffer.concat(out); resolve(code === 0 && b.length ? b : null); });
});

(async () => {
  const inner = await freePort();                       // rclone's private port
  const rcUser = 'drivedeck';
  const rcPass = crypto.randomBytes(16).toString('hex');
  const auth = 'Basic ' + Buffer.from(`${rcUser}:${rcPass}`).toString('base64');
  const key = crypto.randomBytes(16).toString('hex');   // session key for the browser

  const backend = { child: null, ready: false };
  const rcCall = async (cmd, params = {}) => {
    if (!backend.ready) throw new Error('rclone is not running yet');
    const r = await fetch(`http://127.0.0.1:${inner}/${cmd}`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(params) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };
  // OAuth tokens live in the rclone config. rclone refreshes and saves them whenever it uses the remote,
  // so an expired one is renewed by having rclone touch the remote once.
  const remoteConfig = async remote => {
    const cfg = await rcCall('config/get', { name: remote.slice(0, -1) });
    let tok = {};
    try { tok = JSON.parse(cfg.token || '{}'); } catch (_) {}
    return { cfg, token: tok.access_token, expiry: Date.parse(tok.expiry) };
  };
  const nativeThumb = async (remote, p, fileId) => {
    let r = await remoteConfig(remote);
    if (r.token && r.expiry < Date.now() + 60000) { await rcCall('operations/about', { fs: remote }).catch(() => {}); r = await remoteConfig(remote); }
    if (!r.token) return null;
    const call = () => NATIVE[r.cfg.type]({ cfg: r.cfg, id: fileId, path: p, token: r.token, size: THUMB_SIZE * 2 });
    try { return await call(); }
    catch (e) {
      if (e.status !== 401) throw e;
      await rcCall('operations/about', { fs: remote }).catch(() => {});
      r = await remoteConfig(remote);
      return call();
    }
  };

  const fileUrl = (remote, p) => `http://127.0.0.1:${inner}/${encodeURIComponent('[' + remote + ']')}/${p.split('/').map(encodeURIComponent).join('/')}`;

  const ffmpegThumb = (url, seek) => run(tools.ffmpeg.path, [
    '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'http,tcp',
    '-headers', `Authorization: ${auth}\r\n`,
    ...(seek ? ['-ss', String(seek)] : []), '-i', url,
    '-frames:v', '1', '-vf', `scale=${THUMB_SIZE}:${THUMB_SIZE}:force_original_aspect_ratio=increase`,
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1',
  ], 60000);

  const sipsThumb = url => new Promise(resolve => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivedeck-thumb-'));
    const src = path.join(dir, 'src'), dst = path.join(dir, 'out.jpg');
    const done = b => { fs.rm(dir, { recursive: true, force: true }, () => {}); resolve(b); };
    http.get(url, { headers: { authorization: auth } }, r => {
      if (r.statusCode !== 200 || +r.headers['content-length'] > SIPS_MAX) { r.resume(); return done(null); }
      const w = fs.createWriteStream(src);
      r.pipe(w);
      w.on('finish', async () => {
        const ok = await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', String(THUMB_SIZE * 2), src, '--out', dst], 30000);
        try { done(ok !== null || fs.existsSync(dst) ? fs.readFileSync(dst) : null); } catch (_) { done(null); }
      });
      w.on('error', () => done(null));
    }).on('error', () => done(null));
  });

  const makeThumb = async (remote, p, kind, { native, generate, fileId }) => {
    let img = null;
    if (native) {
      try { img = await nativeThumb(remote, p, fileId); }
      catch (e) { console.error(`Provider thumbnail failed for ${remote}${p}: ${e.message}`); }
      if (img || !generate) return img;
    }
    const url = fileUrl(remote, p);
    if (hasFfmpeg()) {
      img = await ffmpegThumb(url, kind === 'video' ? 1 : 0);
      if (!img && kind === 'video') img = await ffmpegThumb(url, 0);   // clips shorter than a second
    }
    if (!img && kind === 'image' && hasSips) img = await sipsThumb(url);
    return img;
  };

  const thumb = async (u, res) => {
    const remote = u.searchParams.get('fs') || '', p = u.searchParams.get('path') || '', kind = u.searchParams.get('kind');
    if (!/^[^\[\]\/]+:$/.test(remote) || !p || !['image', 'video', 'audio'].includes(kind)) return sendJson(res, 400, { error: 'bad thumbnail request' });
    const id = crypto.createHash('sha1').update([remote, p, u.searchParams.get('v') || '', THUMB_SIZE].join('\0')).digest('hex');
    const file = path.join(THUMBS, id.slice(0, 2), id + '.jpg');
    const send = (b, keep = true) => { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': b.length, 'Cache-Control': keep ? 'private, max-age=31536000, immutable' : 'no-store' }); res.end(b); };
    try { const b = fs.readFileSync(file); const now = new Date(); fs.utimes(file, now, now, () => {}); return send(b); } catch (_) {}
    const type = (await rcCall('config/get', { name: remote.slice(0, -1) }).catch(() => ({}))).type;
    const native = !!NATIVE[type];
    // Encrypted folders: thumbnails are made each time and never kept, on disk or in the browser's cache.
    const keep = type !== 'crypt';
    const generate = autoThumbs() && (hasFfmpeg() || (kind === 'image' && hasSips));
    if (!native && !generate) return sendJson(res, 404, { error: autoThumbs() ? 'no thumbnailer available' : 'thumbnail generation is turned off' });
    const fileId = u.searchParams.get('id') || '';
    // Jobs wait for a free slot; one whose browsers all went away meanwhile (the user left the folder) is skipped.
    let job = inflight.get(id);
    if (!job) {
      job = { waiters: 0 };
      job.promise = (async () => {
        await slot();
        try {
          if (!job.waiters) return SKIPPED;
          const img = await makeThumb(remote, p, kind, { native, generate, fileId });
          if (img && keep) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, img);
            cache.bytes += img.length; cache.files++;
            trimCache();
          }
          return img;
        } finally { release(); inflight.delete(id); }
      })();
      inflight.set(id, job);
    }
    job.waiters++;
    let gone = false;
    res.on('close', () => { if (!res.writableEnded && !gone) { gone = true; job.waiters--; } });
    const img = await job.promise;
    if (gone || res.destroyed) return;
    if (img === SKIPPED) return thumb(u, res);   // joined just as the job was dropped: start a fresh one
    if (img) send(img, keep); else sendJson(res, 415, { error: 'could not make a thumbnail' });
  };

  // ---- Audio ----
  // The browser plays common formats straight from rclone. For the rest (WMA, APE, ALAC, AIFF in Chrome
  // and so on) ffmpeg converts the file as it streams, reading it from rclone's file server, and sends MP3
  // (or AAC when this ffmpeg has no MP3 encoder). Seeking starts a new conversion from that point (?t=).
  // Album art comes through the thumbnail cache (kind=audio): it's the file's embedded cover picture.
  let mp3Encoder = null;
  const audioOut = () => {
    if (mp3Encoder === null) mp3Encoder = /libmp3lame/.test(spawnSync(tools.ffmpeg.path, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000 }).stdout || '');
    return mp3Encoder ? { args: ['-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3'], type: 'audio/mpeg' } : { args: ['-c:a', 'aac', '-b:a', '192k', '-f', 'adts'], type: 'audio/aac' };
  };
  const ffmpegIn = (remote, p, seek) => ['-hide_banner', '-protocol_whitelist', 'http,tcp', '-headers', `Authorization: ${auth}\r\n`,
    ...(seek ? ['-ss', String(seek)] : []), '-i', fileUrl(remote, p)];
  const audioTarget = u => {
    const remote = u.searchParams.get('fs') || '', p = u.searchParams.get('path') || '';
    return /^[^\[\]\/]+:$/.test(remote) && p ? { remote, p } : null;
  };
  // ffmpeg describes the file on stderr when it's given no output: tags, duration, streams.
  // Tags are read from the file, then from its first audio stream (where Ogg and Opus keep them), skipping
  // chapters and the cover picture, whose own titles aren't the track's.
  const parseProbe = text => {
    const input = (text.split(/^Input #0/m)[1] || '').split(/^\s*Stream #0:\d+.*?: (?:Video|Subtitle|Data|Attachment)/m)[0]
      .replace(/^ +Chapters?[\s\S]*?(?=^ {2}Stream|$(?![\s\S]))/m, '');
    const tags = {};
    for (const m of input.matchAll(/^ {4,}([A-Za-z][\w ]*?)\s*: (.*)$/gm)) { const k = m[1].toLowerCase(); if (!(k in tags)) tags[k] = m[2].trim(); }
    const d = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
    return {
      duration: d ? Math.round((+d[1] * 3600 + +d[2] * 60 + +d[3]) * 1000) / 1000 : null,
      title: tags.title || null, artist: tags.artist || tags.album_artist || null, album: tags.album || null,
      codec: (/Stream #0:\d+.*?: Audio: (\w+)/.exec(text) || [])[1] || null,
      cover: /Stream #0:\d+.*Video:.*\(attached pic\)/.test(text),
    };
  };
  const audioInfo = (u, res) => {
    const t = audioTarget(u); if (!t) return sendJson(res, 400, { error: 'bad audio request' });
    if (!hasFfmpeg()) return sendJson(res, 404, { error: 'ffmpeg isn’t installed' });
    const p = spawn(tools.ffmpeg.path, ffmpegIn(t.remote, t.p), { stdio: ['ignore', 'ignore', 'pipe'] });
    let text = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.stderr.on('data', d => { if (text.length < 256 * 1024) text += d; });
    p.on('error', e => { clearTimeout(timer); sendJson(res, 500, { error: e.message }); });
    p.on('close', () => {
      clearTimeout(timer);
      if (res.headersSent) return;
      if (!/^Input #0/m.test(text)) return sendJson(res, 415, { error: text.trim().split('\n').pop() || 'ffmpeg couldn’t read this file' });
      sendJson(res, 200, parseProbe(text));
    });
    res.on('close', () => { if (!res.writableEnded) p.kill('SIGKILL'); });
  };
  const audioStream = (u, res) => {
    const t = audioTarget(u); if (!t) return sendJson(res, 400, { error: 'bad audio request' });
    if (!hasFfmpeg()) return sendJson(res, 404, { error: 'ffmpeg isn’t installed' });
    const seek = Math.max(0, Number(u.searchParams.get('t')) || 0), out = audioOut();
    const p = spawn(tools.ffmpeg.path, ['-loglevel', 'error', ...ffmpegIn(t.remote, t.p, seek), '-map', '0:a:0', '-vn', ...out.args, 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { if (err.length < 8000) err += d; });
    // Headers wait for the first converted bytes, so a file ffmpeg can't read gets a real error instead of silence.
    p.stdout.once('data', chunk => {
      res.writeHead(200, { 'Content-Type': out.type, 'Cache-Control': 'no-store' });
      res.write(chunk); p.stdout.pipe(res);
    });
    p.on('error', e => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    p.on('close', () => { if (!res.headersSent) sendJson(res, 415, { error: err.trim().split('\n').pop() || 'ffmpeg couldn’t convert this file' }); });
    res.on('close', () => p.kill('SIGKILL'));
  };

  // ---- Zip downloads ----
  // A folder, or several selected items, download as one zip that's built while it streams (lib/zip.js).
  // Everything is listed first, so a missing item fails with a proper error before the download starts.
  // Files that fail part way are listed in a text file at the end of the zip.
  const rcloneGet = url => new Promise((resolve, reject) => http.get(url, { headers: { authorization: auth } }, resolve).on('error', reject));
  const zipName = s => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'Download';
  const zipDownload = async (req, res) => {
    const form = new URLSearchParams(await readBody(req, 4 * 1024 * 1024));
    const remote = form.get('fs') || '';
    let paths = [];
    try { paths = JSON.parse(form.get('paths') || '[]'); } catch (_) {}
    if (!/^[^\[\]\/]+:$/.test(remote) || !Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !p || p.split('/').includes('..')))
      return sendJson(res, 400, { error: 'bad download request' });
    const entries = [];
    try {
      for (const p of paths) {
        const base = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1).length : 0;   // names in the zip start at the item
        const item = (await rcCall('operations/stat', { fs: remote, remote: p })).item;
        if (!item) throw new Error(`“${p}” wasn’t found`);
        entries.push({ ...item, name: item.Path.slice(base) });
        if (item.IsDir) for (const f of (await rcCall('operations/list', { fs: remote, remote: p, opt: { recurse: true } })).list) entries.push({ ...f, name: f.Path.slice(base) });
      }
    } catch (e) { return sendJson(res, 404, { error: e.message }); }
    const name = zipName(form.get('name') || 'Download') + '.zip';
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` });
    const zip = new ZipWriter(res), failed = [];
    let current = null;
    res.on('close', () => current?.destroy());
    try {
      for (const e of entries) {
        if (e.IsDir) { await zip.addDir(e.name, e.ModTime); continue; }
        try {
          current = await rcloneGet(fileUrl(remote, e.Path));
          if (current.statusCode !== 200) { current.resume(); failed.push(`${e.name}: HTTP ${current.statusCode}`); continue; }
          await zip.addFile(e.name, e.ModTime, current, e.Size >= 0xFFFFFFF0);
        } catch (err) { if (res.destroyed) throw err; failed.push(`${e.name}: ${err.message}`); }
      }
      if (failed.length) await zip.addFile('DriveDeck - files that failed.txt', Date.now(), [Buffer.from(`These files couldn’t be downloaded completely:\n\n${failed.join('\n')}\n`)]);
      await zip.finish();
      res.end();
    } catch (_) { res.destroy(); }   // the browser went away
  };

  const startBackend = async () => {
    if (backend.child) return;
    const child = backend.child = spawn(tools.rclone.path, ['rcd', '--rc-addr', `127.0.0.1:${inner}`, '--rc-user', rcUser, '--rc-pass', rcPass, '--rc-serve'],
      { env, stdio: ['ignore', 'ignore', 'pipe'] });
    // Pass rclone's messages through, minus the one logged each time ffmpeg stops reading a video early
    // after grabbing a thumbnail frame (harmless, but alarming in a terminal people now keep an eye on).
    let errBuf = '';
    child.stderr.on('data', d => {
      const lines = (errBuf + d).split('\n'); errBuf = lines.pop();
      for (const l of lines) if (!/Didn't finish writing GET request/.test(l)) process.stderr.write(l + '\n');
    });
    child.on('error', e => { console.error('Could not start rclone:', e.message); process.exit(1); });
    child.on('exit', code => { console.error(`rclone stopped (code ${code}).`); process.exit(code || 1); });
    await waitForPort(inner);
    backend.ready = true;
  };

  // ---- Setup: finding and installing rclone and ffmpeg ----
  let job = null;   // the install in progress or last finished: { tool, state, log, code }
  const setupState = () => ({
    platform: process.platform, backend: backend.ready,
    installer: inst && { kind: inst.kind, label: inst.label },
    tools: Object.fromEntries(Object.entries(deps.TOOLS).map(([k, t]) => [k, {
      ...tools[k], label: t.label, required: t.required, why: t.why,
      command: deps.displayCommand(k, inst), steps: deps.manualSteps(k, inst),
    }])),
    job: job && { ...job, log: job.log.slice(-200) },
  });
  const recheck = async () => {
    const had = tools;
    inst = deps.installer();
    tools = deps.detect({ rclone: RCLONE_OPT, ffmpeg: FFMPEG_OPT }, inst);
    for (const k of Object.keys(tools)) if (tools[k].found && !had[k].found) console.log(`Found ${k} ${tools[k].version} at ${tools[k].path}`);
    if (tools.rclone.found && !backend.child) { await startBackend(); console.log('rclone is running. DriveDeck is ready.'); }
  };
  const install = tool => {
    job = { tool, state: 'running', log: [`$ ${deps.displayCommand(tool, inst)}`], code: null };
    console.log(`Installing ${tool}: ${deps.displayCommand(tool, inst)}`);
    deps.runInstall(tool, inst, line => { job.log.push(line); if (job.log.length > 1000) job.log.splice(0, 500); }).then(async code => {
      job.code = code;
      await recheck().catch(e => job.log.push(e.message));
      job.state = tools[tool].found ? 'done' : 'error';
      console.log(job.state === 'done' ? `Installed ${tool}.` : `Installing ${tool} didn't work (exit code ${code}). See the setup screen for details.`);
    });
  };

  const search = createSearch({ dir: INDEX, rcCall, log: m => console.log(m), enabled: () => readConfig().prefs.index !== false });
  const uploads = createTransfers({ dir: UPLOADS, rcCall, log: m => console.log(m),
    onDone: u => { search.touch(u.fs.slice(0, -1)); if (u.srcFs) search.touch(u.srcFs.slice(0, -1)); } });
  const oauth = createOAuth({ rclone: () => tools.rclone.path, env });
  const backups = createBackups({ file: BACKUPS, rcCall, log: m => console.log(m), onDone: b => search.touch(b.dst.split(':')[0]) });
  const setupFiles = createSetupFiles({ rcCall, readConfig, writeConfig, prefsOk: PREFS, backups, log: m => console.log(m),
    googleOk: g => GOOGLE_ID.test(String(g.clientId || '')) && GOOGLE_SECRET.test(String(g.clientSecret || '')) });
  const localFolders = want => {
    const home = os.homedir();
    const roots = process.platform === 'win32'
      ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => l + ':\\').filter(d => { try { fs.accessSync(d); return true; } catch (_) { return false; } })
      : ['/', ...(fs.existsSync('/Volumes') ? ['/Volumes'] : []), ...(fs.existsSync('/media') ? ['/media'] : [])];
    let dir = path.resolve(want || home), dirs = [], error = null;
    try {
      dirs = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch (_) { return false; } })())))
        .map(e => e.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    } catch (e) { error = e.code === 'EACCES' || e.code === 'EPERM' ? 'DriveDeck isn’t allowed to open this folder.' : e.code === 'ENOENT' ? 'This folder isn’t there.' : e.message; }
    const parent = path.dirname(dir);
    return { path: dir, parent: parent === dir ? null : parent, sep: path.sep, dirs, error, home, roots };
  };
  // Answers rclone's sign-in questions itself and returns the first real one (or null when setup is done).
  const nextQuestion = async (name, r) => {
    for (let i = 0; i < 5 && r?.State && r.Option && /^\*oauth/.test(r.State); i++) {
      const keep = OAUTH_KEEP[r.Option.Name];
      if (keep === undefined) throw new Error(`rclone wanted to sign in to ${name} again (${r.Option.Name}). Remove the drive and add it again.`);
      r = await rcCall('config/update', { name, parameters: {}, opt: { nonInteractive: true, continue: true, state: r.State, result: keep } });
    }
    if (r?.Error && !r.State) throw new Error(r.Error.split('\n')[0].replace(/ returned body:.*/, ''));   // the setup failed (e.g. no drive found)
    return question(r);
  };
  const jsonBody = async req => { try { return JSON.parse(await readBody(req, 2 * 1024 * 1024)) || {}; } catch (_) { return {}; } };
  // The app to sign in with: the user's own Google app, the one a drive was added with, or rclone's shared one (null).
  const oauthClient = async b => {
    if (b.client === 'own') {
      const g = readConfig().google;
      if (!g) throw new Error('Set up your Google app first.');
      return { id: g.clientId, secret: g.clientSecret };
    }
    if (b.client === 'remote') {
      const cfg = await rcCall('config/get', { name: String(b.remote || '') });
      if (cfg.type !== b.backend) throw new Error(`${b.remote} isn't a ${b.backend} drive`);
      return cfg.client_id ? { id: cfg.client_id, secret: cfg.client_secret || '' } : null;
    }
    return null;
  };
  // Saves a finished sign-in as a new drive, or as the new sign-in of an existing one.
  const saveSignIn = async (j, b) => {
    const name = String(b.name || '');
    if (!/^[\w-]{1,64}$/.test(name)) throw new Error('invalid drive name');
    const existing = (await rcCall('config/dump'))[name];
    if (b.create) {
      if (existing) throw new Error(`There is already a remote called “${name}” in your rclone config.`);
      const parameters = { ...OAUTH[j.backend], token: j.token, ...(j.client && { client_id: j.client.id, client_secret: j.client.secret }) };
      // nonInteractive: rclone saves what it's given and returns its next question (unanswered) instead of
      // starting a sign-in of its own.
      const r = await rcCall('config/create', { name, type: j.backend, parameters, opt: { nonInteractive: true } });
      return OAUTH[j.backend].ask ? nextQuestion(name, r) : null;
    } else {
      if (existing?.type !== j.backend) throw new Error(`${name} isn't a ${j.backend} drive`);
      await rcCall('config/update', { name, parameters: { token: j.token }, opt: { nonInteractive: true } });
    }
  };
  uploads.wipe();
  const shutdown = code => {
    const n = uploads.active();
    if (n) console.log(`\nStopped ${n} unfinished upload${n === 1 ? '' : 's'}. Upload ${n === 1 ? 'it' : 'them'} again after restarting DriveDeck.`);
    if (backups.active()) console.log('Stopped a backup that was running. It runs again next time, and only copies what’s still missing.');
    try { backend.child?.kill(); } catch (_) {}
    oauth.stopAll();
    uploads.wipe();
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  const hostOk = h => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
  const cookieOk = c => (c || '').split(/;\s*/).includes('drivedeck_key=' + key);

  const server = http.createServer(async (req, res) => {
    if (!hostOk(req.headers.host)) { res.writeHead(403); return res.end('Forbidden'); }
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/' && u.searchParams.get('k') === key) {
      // A lasting cookie (not a session one) keeps this browser signed in after it's quit and reopened.
      res.writeHead(302, { 'Set-Cookie': `drivedeck_key=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`, Location: '/' });
      return res.end();
    }
    if (!cookieOk(req.headers.cookie)) {
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(SIGNED_OUT_PAGE);
      }
      return sendJson(res, 401, { error: 'This browser isn\'t signed in to DriveDeck.', signedOut: true });
    }
    if (req.method === 'GET' && ASSETS[u.pathname]) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(STATIC[u.pathname])], 'Cache-Control': 'no-store' });
      return res.end(ASSETS[u.pathname]);
    }
    if (u.pathname === '/_ui/config') {
      if (req.method === 'GET') {
        const rcloneConfig = (await rcCall('config/paths').catch(() => ({}))).config || '';
        let configEncrypted = false;
        try { configEncrypted = fs.readFileSync(rcloneConfig, 'utf8').slice(0, 200).includes('RCLONE_ENCRYPT_V0'); } catch (_) {}
        return sendJson(res, 200, { ...readConfig(),
          features: { ffmpeg: hasFfmpeg(), sips: hasSips, nativeThumbs: Object.keys(NATIVE), oauth: Object.keys(OAUTH) },
          about: { rclone: tools.rclone.found ? `rclone ${tools.rclone.version}` : '', rcloneConfig, configEncrypted, settings: CONFIG, backups: BACKUPS, thumbs: THUMBS, index: INDEX, uploads: UPLOADS } });
      }
      if (req.method === 'PATCH') {
        try {
          const patch = JSON.parse(await readBody(req, 64 * 1024)), c = patchConfig(patch);
          trimCache();
          if (patch.prefs?.index === false) search.clear(); else if (patch.prefs?.index === true) search.refresh();
          return sendJson(res, 200, c);
        }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (u.pathname === '/_ui/setup' && req.method === 'GET') return sendJson(res, 200, setupState());
    if (u.pathname === '/_ui/setup/check' && req.method === 'POST') {
      try { await recheck(); return sendJson(res, 200, setupState()); }
      catch (e) { return sendJson(res, 500, { error: e.message }); }
    }
    if (u.pathname === '/_ui/setup/install' && req.method === 'POST') {
      let tool;
      try { tool = JSON.parse(await readBody(req, 1024)).tool; } catch (_) {}
      if (!deps.TOOLS[tool] || !inst) return sendJson(res, 400, { error: 'nothing to install this way' });
      if (job?.state === 'running') return sendJson(res, 409, { error: `already installing ${job.tool}` });
      install(tool);
      return sendJson(res, 200, setupState());
    }
    if (u.pathname === '/_ui/cache') {
      if (req.method === 'GET') { recount(); return sendJson(res, 200, cacheInfo()); }   // pick up files removed by hand
      if (req.method === 'DELETE') {
        try { clearCache(); return sendJson(res, 200, cacheInfo()); }
        catch (e) { return sendJson(res, 500, { error: e.message }); }
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (u.pathname === '/_ui/upload' && req.method === 'POST') return uploads.receive(u.searchParams, req, res, sendJson);
    if (u.pathname === '/_ui/uploads' && req.method === 'GET') return sendJson(res, 200, { items: uploads.list() });
    if (u.pathname === '/_ui/uploads/clear' && req.method === 'POST') { uploads.clear(); return sendJson(res, 200, { items: uploads.list() }); }
    const up = /^\/_ui\/uploads\/([\w-]{8,64})\/(cancel|retry|dismiss)$/.exec(u.pathname);
    if (up && req.method === 'POST') {
      const ok = uploads[up[2]](up[1]);
      return sendJson(res, ok ? 200 : 409, ok ? { items: uploads.list() } : { error: `can't ${up[2]} this upload now` });
    }
    if (!backend.ready) return sendJson(res, 503, { error: 'rclone isn\'t installed yet. Finish setup first.', setup: true });
    if (u.pathname === '/_ui/oauth/start' && req.method === 'POST') {
      const b = await jsonBody(req);
      if (!OAUTH[b.backend]) return sendJson(res, 400, { error: 'This drive type doesn’t sign in through the browser.' });
      try { return sendJson(res, 200, await oauth.start(b.backend, await oauthClient(b))); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    const oa = /^\/_ui\/oauth\/([\w-]{36})(?:\/(cancel|save))?$/.exec(u.pathname);
    if (oa) {
      const j = oauth.get(oa[1]);
      if (!j) return sendJson(res, 404, { error: 'This sign-in has expired. Please sign in again.' });
      if (!oa[2] && req.method === 'GET') return sendJson(res, 200, oauth.view(j));
      if (oa[2] === 'cancel' && req.method === 'POST') { oauth.cancel(j.id); return sendJson(res, 200, oauth.view(j)); }
      if (oa[2] === 'save' && req.method === 'POST') {
        if (j.state !== 'done' || !j.token) return sendJson(res, 409, { error: 'The sign-in hasn’t finished yet.' });
        try { return sendJson(res, 200, { ok: true, question: await saveSignIn(j, await jsonBody(req)) }); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    // An answer to rclone's setup question for a drive that was just signed in: { name, state, result }.
    if (req.method === 'POST' && u.pathname === '/_ui/drive-question') {
      const b = await jsonBody(req);
      try {
        const cfg = await rcCall('config/get', { name: String(b.name || '') });
        if (!OAUTH[cfg.type]?.ask) throw new Error('This drive has no questions to answer.');
        const r = await rcCall('config/update', { name: b.name, parameters: {}, opt: { nonInteractive: true, continue: true, state: String(b.state || ''), result: String(b.result ?? '') } });
        return sendJson(res, 200, { question: await nextQuestion(b.name, r) });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    // Backups of folders on this computer (lib/backups.js).
    if (u.pathname === '/_ui/backups') {
      try {
        if (req.method === 'POST') await backups.add(await jsonBody(req));
        return sendJson(res, 200, { items: backups.list() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    const bk = /^\/_ui\/backups\/([\w-]{36})(?:\/(run|stop))?$/.exec(u.pathname);
    if (bk) {
      try {
        if (bk[2] && req.method === 'POST') backups[bk[2]](bk[1]);
        else if (!bk[2] && req.method === 'PATCH') await backups.update(bk[1], await jsonBody(req));
        else if (!bk[2] && req.method === 'DELETE') backups.remove(bk[1]);
        else return sendJson(res, 405, { error: 'method not allowed' });
        return sendJson(res, 200, { items: backups.list() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    // Setup files (lib/setup-file.js): export everything to one password-locked file, and import one.
    if (req.method === 'POST' && u.pathname === '/_ui/setup-file/export') {
      try {
        const { text } = await setupFiles.exportFile(await jsonBody(req));
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="drivedeck-setup-${new Date().toISOString().slice(0, 10)}.drivedeck"` });
        return res.end(text);
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && u.pathname === '/_ui/setup-file/open') {
      let b = {};
      try { b = JSON.parse(await readBody(req, 12 * 1024 * 1024)) || {}; } catch (e) { return sendJson(res, 400, { error: /too large/.test(e.message) ? 'This file is too big to be a DriveDeck setup file.' : 'Choose a setup file.' }); }
      try { return sendJson(res, 200, await setupFiles.openFile(b.file, String(b.password || ''))); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && u.pathname === '/_ui/setup-file/import') {
      try { return sendJson(res, 200, await setupFiles.importFile(await jsonBody(req))); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && u.pathname === '/_ui/setup-file/close') { setupFiles.close(String((await jsonBody(req)).id || '')); return sendJson(res, 200, {}); }
    // Folders on this computer, for choosing what to back up. Browsers can't give a page real folder paths.
    if (req.method === 'GET' && u.pathname === '/_ui/local') return sendJson(res, 200, localFolders(u.searchParams.get('path')));
    // Copies and moves: { kind, fs, dir, items: [{ srcFs, srcPath, isDir, size, name }] }, into fs + dir.
    if (req.method === 'POST' && u.pathname === '/_ui/transfer') {
      const b = await jsonBody(req);
      try {
        if (!Array.isArray(b.items) || !b.items.length) throw new Error('nothing to transfer');
        for (const it of b.items) uploads.transfer({ ...it, kind: b.kind, fs: b.fs, dir: b.dir });
        return sendJson(res, 200, { items: uploads.list() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    // Search: the app sends the drives it shows (POST /_ui/index), and they're indexed in the background.
    if (u.pathname === '/_ui/index') {
      if (req.method === 'POST') { const b = await jsonBody(req); search.setDrives((b.drives || []).filter(d => typeof d === 'string')); }
      else if (req.method === 'DELETE') search.clear();
      return sendJson(res, 200, { status: search.status(), size: search.size() });
    }
    if (req.method === 'POST' && u.pathname === '/_ui/index/refresh') { search.refresh(); return sendJson(res, 200, { status: search.status() }); }
    if (req.method === 'POST' && u.pathname === '/_ui/index/touch') { const b = await jsonBody(req); search.touch(String(b.drive || '')); return sendJson(res, 200, {}); }
    if (req.method === 'GET' && u.pathname === '/_ui/search') return sendJson(res, 200, { ...search.search(u.searchParams.get('q') || ''), status: search.status() });
    if (req.method === 'GET' && u.pathname === '/_ui/duplicates') return sendJson(res, 200, { ...search.duplicates(Math.max(0, Number(u.searchParams.get('min')) || 0)), status: search.status() });
    if (req.method === 'POST' && u.pathname === '/_ui/zip') return zipDownload(req, res).catch(e => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); else res.destroy(); });
    if (req.method === 'GET' && u.pathname === '/_ui/audio') return audioInfo(u, res);
    if (req.method === 'GET' && u.pathname === '/_ui/audio/stream') return audioStream(u, res);
    if (req.method === 'GET' && u.pathname === '/_ui/thumb') return thumb(u, res).catch(e => sendJson(res, 500, { error: e.message }));

    const headers = { ...req.headers, host: `127.0.0.1:${inner}`, authorization: auth };
    delete headers.cookie; delete headers.origin; delete headers.referer;
    const proxy = http.request({ host: '127.0.0.1', port: inner, method: req.method, path: req.url, headers }, r => {
      // Files from a drive are served from DriveDeck's own address, so an HTML or SVG file opened here could
      // otherwise run scripts as DriveDeck. They're sandboxed instead, except PDFs, which the browser's PDF
      // reader won't show in a sandbox (it doesn't run a PDF's scripts either way).
      if (req.method === 'GET' && u.pathname.startsWith('/[')) {
        r.headers['x-content-type-options'] = 'nosniff';
        if (!/^application\/pdf\b/i.test(r.headers['content-type'] || '')) r.headers['content-security-policy'] = 'sandbox';
      }
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
      // rclone sends the headers before reading the file, so a read that fails (a drive error, or a wrong
      // password on an encrypted folder) cuts the response short. Pass that on, or the browser waits forever.
      r.on('close', () => { if (!r.complete) res.destroy(); });
    });
    proxy.on('error', e => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rclone is not reachable: ' + e.message }));
    });
    req.pipe(proxy);
  });
  server.requestTimeout = 0;                            // allow long uploads
  server.on('error', e => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Try: npx drivedeck --port ${PORT + 1}` : e.message);
    shutdown(1);
  });
  server.listen(PORT, '127.0.0.1');
  setImmediate(() => { recount(); trimCache(); });

  if (tools.rclone.found) await startBackend();
  const url = `http://127.0.0.1:${PORT}/?k=${key}`;
  const canReopen = process.stdin.isTTY;
  console.log(`\nDriveDeck is running. Open this link in your browser:\n\n  ${url}\n\n${canReopen ? 'Closed the browser? Press Enter here to open DriveDeck again.\n' : ''}Uploads keep going after you close the browser tab, as long as this terminal stays open.\nPress Ctrl+C to stop (this also stops unfinished uploads).`);
  if (!args.includes('--no-open')) openBrowser(url);
  if (canReopen) process.stdin.on('data', () => { console.log('Opening DriveDeck in your browser…'); openBrowser(url); });
})();
