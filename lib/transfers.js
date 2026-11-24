'use strict';
// Transfers: uploads, and copies or moves between folders and drives. All of them run as rclone background
// jobs, two at a time, and carry on after the tab is closed, for as long as this process runs. State is
// kept in memory only: quitting DriveDeck stops unfinished transfers.
//
// Uploads happen in two steps:
//   1. The browser sends the file to this process, which keeps it in a temporary folder ("sending").
//   2. rclone uploads it from there ("queued" -> "uploading" -> "done").
// Copies and moves start at step 2. Within one drive the provider does the work; between drives rclone
// streams the data through this computer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLOUD_SLOTS = 2;      // uploads to the cloud running at once
const KEEP_FINISHED = 200;  // finished items remembered for the panel until cleared
const FINISHED = new Set(['done', 'error', 'cancelled']);

module.exports = function createTransfers({ dir, rcCall, log, onDone = () => {} }) {
  const items = new Map();
  let pollTimer = null, polling = false;

  const fileOf = id => path.join(dir, id);
  const dstPath = u => (u.dir ? u.dir + '/' : '') + u.name;
  const target = u => u.fs + dstPath(u);
  const view = u => ({
    id: u.id, kind: u.kind, fs: u.fs, dir: u.dir, name: u.name, size: u.size, state: u.state,
    srcFs: u.srcFs, srcPath: u.srcPath, isDir: !!u.isDir,
    sent: u.sent, done: u.done, speed: u.speed, eta: u.eta, error: u.error,
    retry: u.state === 'error' && (u.kind !== 'upload' || fs.existsSync(fileOf(u.id))),
  });
  const VERB = { upload: ['Uploaded', 'Upload'], copy: ['Copied', 'Copy'], move: ['Moved', 'Move'] };
  const dropFile = u => fs.rm(fileOf(u.id), { force: true }, () => {});
  const finish = (u, state, error = null) => {
    if (FINISHED.has(u.state)) return;
    // rclone's message names the temporary file; keep just the reason.
    if (error) error = (/couldn't copy from .+? to .+?: (.+)$/s.exec(error) || [])[1] || error.split(fileOf(u.id)).join(u.name);
    Object.assign(u, { state, error, speed: 0, eta: null });
    const [did, act] = VERB[u.kind];
    if (state === 'done') log(`${did} ${u.kind === 'upload' ? '' : u.srcFs + u.srcPath + ' to '}${target(u)}`);
    else if (state === 'error') log(`${act} failed: ${target(u)}: ${error}`);
    else log(`${act} cancelled: ${target(u)}`);
    onDone(u);
    // A file that failed in the cloud step stays on disk so it can be retried without sending it again.
    if (state !== 'error' || u.partial) dropFile(u);
    const finished = [...items.values()].filter(x => FINISHED.has(x.state));
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) { dropFile(old); items.delete(old.id); }
  };
  const count = state => [...items.values()].filter(u => u.state === state).length;

  // The rclone call that runs a transfer. Folders are synced into a folder of the same name; on the same
  // drive, rclone turns a folder move into a single server-side rename where the provider allows it.
  const start = u => u.kind === 'upload' ? ['operations/copyfile', { srcFs: dir, srcRemote: u.id, dstFs: u.fs, dstRemote: dstPath(u), _async: true }]
    : u.isDir ? [u.kind === 'move' ? 'sync/move' : 'sync/copy', { srcFs: u.srcFs + u.srcPath, dstFs: u.fs + dstPath(u), createEmptySrcDirs: true, ...(u.kind === 'move' && { deleteEmptySrcDirs: true }), _async: true }]
    : [u.kind === 'move' ? 'operations/movefile' : 'operations/copyfile', { srcFs: u.srcFs, srcRemote: u.srcPath, dstFs: u.fs, dstRemote: dstPath(u), _async: true }];

  async function pump() {
    for (const u of items.values()) {
      if (count('uploading') >= CLOUD_SLOTS) break;
      if (u.state !== 'queued') continue;
      Object.assign(u, { state: 'uploading', done: 0, jobid: null });
      try {
        const { jobid } = await rcCall(...start(u));
        u.jobid = jobid;
        log(`${{ upload: 'Uploading', copy: 'Copying', move: 'Moving' }[u.kind]} ${target(u)}`);
        if (u.cancelled) rcCall('job/stop', { jobid }).catch(() => {});
      } catch (e) { finish(u, 'error', e.message); }
    }
    if (!pollTimer && count('uploading')) pollTimer = setInterval(poll, 1000);
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (const u of [...items.values()].filter(x => x.state === 'uploading' && x.jobid)) {
        const group = 'job/' + u.jobid;
        try {
          const [st, stats] = await Promise.all([rcCall('job/status', { jobid: u.jobid }), rcCall('core/stats', { group })]);
          // A folder's total grows as rclone finds its files, so its size is taken from the job's stats.
          if (stats.totalBytes > u.size) u.size = stats.totalBytes;
          if (stats.bytes != null) Object.assign(u, { done: stats.bytes, speed: stats.speed || 0, eta: stats.eta ?? null });
          if (st.finished) {
            rcCall('core/stats-delete', { group }).catch(() => {});
            if (st.success) { u.done = u.size; finish(u, 'done'); }
            else if (u.cancelled) finish(u, 'cancelled');
            else finish(u, 'error', st.error || 'Upload failed');
          }
        } catch (_) { /* rclone busy; try again on the next tick */ }
      }
    } finally { polling = false; }
    if (!count('uploading')) { clearInterval(pollTimer); pollTimer = null; }
    pump();
  }

  return {
    dir,
    list: () => [...items.values()].map(view),
    active: () => [...items.values()].filter(u => !FINISHED.has(u.state)).length,

    // A copy or move: { kind, srcFs, srcPath, isDir, size, fs, dir, name }, where fs/dir/name is the destination.
    transfer(t) {
      const remoteOk = r => /^[^\[\]\/]+:$/.test(r || ''), pathOk = p => typeof p === 'string' && !p.split('/').includes('..');
      if (!['copy', 'move'].includes(t.kind) || !remoteOk(t.srcFs) || !remoteOk(t.fs) || !pathOk(t.srcPath) || !t.srcPath || !pathOk(t.dir)
        || !t.name || t.name.includes('/') || t.name.length > 255) throw new Error('bad transfer request');
      const id = 't' + crypto.randomUUID();
      items.set(id, { id, kind: t.kind, srcFs: t.srcFs, srcPath: t.srcPath, isDir: !!t.isDir, fs: t.fs, dir: (t.dir || '').replace(/^\/+|\/+$/g, ''),
        name: t.name, size: Math.max(0, Number(t.size) || 0), state: 'queued', sent: 0, done: 0, speed: 0, eta: null, error: null });
      pump();
      return id;
    },

    // Step 1 of an upload: stream the request body into the temporary folder. Responds once the file is complete.
    receive(q, req, res, sendJson) {
      const id = q.get('id') || '', remote = q.get('fs') || '', name = q.get('name') || '';
      const d = (q.get('dir') || '').replace(/^\/+|\/+$/g, ''), size = Number(q.get('size')), mtime = Number(q.get('mtime'));
      if (!/^[\w-]{8,64}$/.test(id) || items.has(id) || !/^[^\[\]\/]+:$/.test(remote) || !name || name.includes('/') || name.length > 255
        || d.split('/').some(s => s === '..') || !Number.isFinite(size) || size < 0) return sendJson(res, 400, { error: 'bad upload request' });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const u = { id, kind: 'upload', fs: remote, dir: d, name, size, state: 'sending', sent: 0, done: 0, speed: 0, eta: null, error: null, req };
      items.set(id, u);
      const out = fs.createWriteStream(fileOf(id), { mode: 0o600 });
      const stop = msg => {
        if (u.state !== 'sending') return;
        out.destroy(); u.partial = true;
        finish(u, u.cancelled ? 'cancelled' : 'error', u.cancelled ? null : msg);
        if (!res.headersSent && !res.destroyed) sendJson(res, u.cancelled ? 409 : 500, { error: msg });
      };
      req.on('data', b => { u.sent += b.length; });
      req.on('close', () => { if (!req.complete) stop('The browser stopped sending this file (the tab was closed or reloaded).'); });
      out.on('error', e => stop('Could not save the file temporarily: ' + e.message));
      out.on('finish', () => {
        if (u.state !== 'sending') return;
        delete u.req;
        if (u.sent !== size) return stop(`Only ${u.sent} of ${size} bytes arrived.`);
        if (mtime > 0) { try { fs.utimesSync(fileOf(id), new Date(), new Date(mtime)); } catch (_) {} }   // keep the original date
        u.state = 'queued';
        sendJson(res, 200, view(u));
        pump();
      });
      req.pipe(out);
    },

    cancel(id) {
      const u = items.get(id);
      if (!u || FINISHED.has(u.state)) return false;
      u.cancelled = true;
      if (u.state === 'sending') u.req?.destroy();
      else if (u.state === 'queued') finish(u, 'cancelled');
      else if (u.jobid) rcCall('job/stop', { jobid: u.jobid }).catch(() => {});
      return true;
    },
    retry(id) {
      const u = items.get(id);
      if (!u || u.state !== 'error' || (u.kind === 'upload' && !fs.existsSync(fileOf(id)))) return false;
      Object.assign(u, { state: 'queued', error: null, done: 0, cancelled: false });
      log(`Retrying ${target(u)}`);
      pump();
      return true;
    },
    dismiss(id) {
      const u = items.get(id);
      if (!u || !FINISHED.has(u.state)) return false;
      dropFile(u); items.delete(id);
      return true;
    },
    clear() {
      for (const u of [...items.values()]) if (FINISHED.has(u.state)) { dropFile(u); items.delete(u.id); }
    },
    // Leftovers from an earlier run can't be resumed (their state was in memory), so they are removed.
    wipe() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} },
  };
};
