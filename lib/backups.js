'use strict';
// Backups of folders on this computer to a drive, kept in ~/.drivedeck/backups.json. Each one copies new and
// changed files with rclone's sync/copy (or, in mirror mode, sync/sync, which also deletes from the backup
// what was deleted here). They run when asked, or every 1, 6 or 24 hours while DriveDeck is running, one at
// a time. Each backup remembers how its last run went.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVERY = [0, 1, 6, 24];                     // hours; 0 = only when asked
const HOUR = 60 * 60 * 1000;
// System clutter that never needs backing up.
const SKIP = ['.DS_Store', '._*', '.Spotlight-V100/**', '.Trashes/**', '.fseventsd/**', 'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN/**', 'System Volume Information/**'];

module.exports = function createBackups({ file, rcCall, log, onDone }) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')).backups || []; } catch (_) {}
  const live = new Map();   // id -> { jobid, group, stats }
  const queue = [];
  let busy = false;

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, backups: list }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const find = id => list.find(b => b.id === id);
  const view = b => {
    const l = live.get(b.id);
    return { ...b, state: l ? 'running' : queue.includes(b.id) ? 'queued' : 'idle', progress: l?.stats || null,
      next: b.every && !l && !b.paused ? Math.max(Date.now(), (b.last?.start || 0) + b.every * HOUR) : null };
  };

  const checkSrc = src => {
    if (typeof src !== 'string' || !path.isAbsolute(src)) throw new Error('Choose a folder on this computer.');
    let st;
    try { st = fs.statSync(src); } catch (_) { throw new Error(`The folder ${src} isn’t there any more.`); }
    if (!st.isDirectory()) throw new Error(`${src} isn’t a folder.`);
  };
  const checkDst = async dst => {
    const m = /^([\w.\- ]{1,64}):(.*)$/.exec(String(dst || ''));
    if (!m) throw new Error('Choose a drive and folder to back up to.');
    const cfg = await rcCall('config/get', { name: m[1] }).catch(() => null);
    if (!cfg || !cfg.type) throw new Error(`There’s no drive called ${m[1]}.`);
    return m[1] + ':' + m[2].replace(/^\/+|\/+$/g, '');
  };
  const clean = b => ({ every: EVERY.includes(b.every) ? b.every : 0, mirror: b.mirror === true });

  async function run(b) {
    const group = 'backup-' + b.id;
    const started = Date.now();
    live.set(b.id, { group, stats: null });
    b.last = { ...(b.last || {}), start: started, end: null, ok: null, error: null };
    let result;
    try {
      if (b.paused) throw new Error('Choose where this folder is on this computer first.');
      checkSrc(b.src);
      // An empty source in mirror mode would empty the backup: a disconnected disk looks exactly like that.
      if (b.mirror && !fs.readdirSync(b.src).length) throw new Error('The folder on this computer is empty, so the mirror wasn’t run. It would have deleted everything in the backup.');
      const { jobid } = await rcCall(b.mirror ? 'sync/sync' : 'sync/copy', {
        srcFs: b.src, dstFs: b.dst, createEmptySrcDirs: true, _async: true, _group: group, _filter: { ExcludeRule: SKIP },
      });
      live.get(b.id).jobid = jobid;
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        const st = await rcCall('core/stats', { group }).catch(() => null);
        if (st) live.get(b.id).stats = { bytes: st.bytes || 0, totalBytes: st.totalBytes || 0, files: st.transfers || 0, totalFiles: st.totalTransfers || 0, checks: st.checks || 0, speed: st.speed || 0 };
        const job = await rcCall('job/status', { jobid });
        if (job.finished) { result = { ok: job.success, error: job.success ? null : job.error, stats: st }; break; }
      }
    } catch (e) { result = { ok: false, error: e.message, stats: null }; }
    const st = result.stats || {};
    b.last = { start: started, end: Date.now(), ok: result.ok, error: result.ok ? null : /context canceled/i.test(result.error) ? 'Stopped before it finished.' : String(result.error || 'The backup failed.').split('\n')[0],
      files: st.transfers || 0, bytes: st.bytes || 0, deleted: st.deletes || 0, errors: st.errors || 0, checked: st.checks || 0 };
    live.delete(b.id);
    rcCall('core/stats-delete', { group }).catch(() => {});
    if (find(b.id)) save();
    log(`Backup of ${b.src} to ${b.dst}: ${b.last.ok ? `done, ${b.last.files} file${b.last.files === 1 ? '' : 's'} copied` : 'failed: ' + b.last.error}`);
    onDone?.(b);
  }
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const b = find(queue.shift());
      if (b) await run(b).catch(e => log(`Backup error: ${e.message}`));
    }
    busy = false;
  }
  const enqueue = id => { if (!queue.includes(id) && !live.has(id)) { queue.push(id); pump(); } };

  // Every minute: start backups that are due.
  setInterval(() => {
    for (const b of list) if (b.every && !b.paused && (!b.last?.start || Date.now() - b.last.start >= b.every * HOUR)) enqueue(b.id);
  }, 60 * 1000).unref();

  return {
    list: () => list.map(view),
    // imported: a backup from a setup file made on another computer. Its folder may not be here (or may be
    // somewhere else), so it's added paused until the user chooses the folder.
    async add(b, { imported = false } = {}) {
      let paused = false;
      try { checkSrc(b.src); } catch (e) { if (!imported || typeof b.src !== 'string' || !b.src) throw e; paused = true; }
      const item = { id: crypto.randomUUID(), src: paused ? b.src : path.resolve(b.src), dst: await checkDst(b.dst), ...clean(b), created: Date.now(), last: null, ...(paused && { paused: true }) };
      list.push(item); save();
      return view(item);
    },
    async update(id, b) {
      const item = find(id);
      if (!item) throw new Error('That backup was removed.');
      if (live.has(id)) throw new Error('Wait for this backup to finish before changing it.');
      if (b.src !== undefined) { checkSrc(b.src); item.src = path.resolve(b.src); delete item.paused; }
      if (b.dst !== undefined) item.dst = await checkDst(b.dst);
      Object.assign(item, clean({ ...item, ...b }));
      save();
      return view(item);
    },
    remove(id) {
      const l = live.get(id);
      if (l?.jobid) rcCall('job/stop', { jobid: l.jobid }).catch(() => {});
      const i = queue.indexOf(id); if (i >= 0) queue.splice(i, 1);
      list = list.filter(b => b.id !== id); save();
    },
    run(id) {
      const b = find(id);
      if (!b) throw new Error('That backup was removed.');
      if (b.paused) throw new Error('Choose where this folder is on this computer first.');
      enqueue(id);
    },
    stop(id) {
      const i = queue.indexOf(id); if (i >= 0) queue.splice(i, 1);
      const l = live.get(id); if (l?.jobid) rcCall('job/stop', { jobid: l.jobid }).catch(() => {});
    },
    active: () => live.size + queue.length,
  };
};
