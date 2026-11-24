'use strict';
// A search index of every file name on each drive, kept in ~/.drivedeck/index/<drive>.json so searches are
// instant and work across drives. Each index is built with one recursive rclone listing, refreshed in the
// background once it's an hour old, and rebuilt shortly after DriveDeck changes something on the drive.
// Google Drive includes an MD5 checksum per file in its listing at no cost, so its index keeps that too,
// which lets the duplicate finder match files exactly. Other drives would have to read every file to
// get one, so they don't.
const fs = require('fs');
const path = require('path');

const STALE = 60 * 60 * 1000;
const FREE_HASH = { drive: 'md5' };
const fold = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();   // é -> e; other scripts are left alone

module.exports = function createSearch({ dir, rcCall, log, enabled }) {
  const mem = new Map();       // drive -> { built, items: [[path, size, mtime, isDir, hash]], names: [folded names] }
  let known = [];              // the drives the app shows; only these are indexed and searched
  const queue = [], building = new Set(), touched = new Map();
  let running = false;

  const file = name => path.join(dir, encodeURIComponent(name) + '.json');
  const prep = idx => ({ ...idx, names: idx.items.map(i => fold(i[0].slice(i[0].lastIndexOf('/') + 1))) });
  const load = name => {
    if (mem.has(name)) return mem.get(name);
    try { const idx = prep(JSON.parse(fs.readFileSync(file(name), 'utf8'))); mem.set(name, idx); return idx; } catch (_) { return null; }
  };
  const stale = name => { const idx = load(name); return !idx || Date.now() - idx.built > STALE; };

  async function build(name) {
    const type = (await rcCall('config/get', { name }).catch(() => ({}))).type;
    const hash = FREE_HASH[type];
    const started = Date.now();
    const list = (await rcCall('operations/list', { fs: name + ':', remote: '', opt: { recurse: true, ...(hash && { showHash: true, hashTypes: [hash] }) } })).list;
    const idx = { version: 1, built: started, hash: hash || null, items: list.map(f => [f.Path, f.Size, Date.parse(f.ModTime) || 0, f.IsDir ? 1 : 0, (hash && f.Hashes?.[hash]) || '']) };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = file(name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx), { mode: 0o600 });
    fs.renameSync(tmp, file(name));
    mem.set(name, prep(idx));
    log(`Search index for ${name}: ${idx.items.length.toLocaleString()} items in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
  // One drive at a time, so indexing never competes with itself (MEGA also rate-limits logins).
  async function run() {
    if (running) return;
    running = true;
    while (queue.length) {
      const name = queue.shift();
      if (!enabled() || !known.includes(name)) continue;
      building.add(name);
      try { await build(name); } catch (e) { log(`Couldn't index ${name}: ${e.message}`); }
      building.delete(name);
    }
    running = false;
  }
  const schedule = (names, force) => {
    for (const n of names) if ((force || stale(n)) && !queue.includes(n) && !building.has(n)) queue.push(n);
    run();
  };
  setInterval(() => { if (enabled()) schedule(known); }, 15 * 60 * 1000).unref();

  // Every word must appear in the file name. Exact names rank first, then names starting with the
  // query, then words starting with it, then anything containing it; folders before files within each.
  function search(q, limit = 100) {
    const words = fold(q).split(/\s+/).filter(Boolean), whole = fold(q.trim());
    if (!words.length) return { results: [], total: 0 };
    const hits = [];
    for (const name of known) {
      const idx = load(name); if (!idx) continue;
      for (let i = 0; i < idx.items.length; i++) {
        const n = idx.names[i];
        if (!words.every(w => n.includes(w))) continue;
        const rank = n === whole ? 0 : n.startsWith(whole) ? 1 : words.every(w => n.startsWith(w) || n.includes(' ' + w) || /[\s._-]/.test(n[n.indexOf(w) - 1] || '')) ? 2 : 3;
        hits.push({ rank, drive: name, item: idx.items[i] });
      }
    }
    hits.sort((a, b) => a.rank - b.rank || b.item[3] - a.item[3] || a.item[0].length - b.item[0].length);
    return {
      total: hits.length,
      results: hits.slice(0, limit).map(({ drive, item: [p, size, mtime, isDir] }) => ({ drive, path: p, name: p.slice(p.lastIndexOf('/') + 1), size, mtime, isDir: !!isDir })),
    };
  }

  // Files stored more than once, across all drives. Files are linked when their checksums match, or when
  // their names and sizes match (unless both have checksums and those differ). A group is "exact" when every
  // file in it has the same checksum; otherwise it's "probably the same".
  function duplicates(minSize = 1024 * 1024) {
    const files = [];
    for (const name of known) { const idx = load(name); if (idx) for (const it of idx.items) if (!it[3] && it[1] >= minSize) files.push({ drive: name, it }); }
    const parent = files.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    const join = (a, b) => { parent[find(a)] = find(b); };
    const byHash = new Map(), byName = new Map();
    files.forEach((f, i) => {
      const [p, size, , , hash] = f.it;
      if (hash) { const k = hash + '|' + size; if (byHash.has(k)) join(i, byHash.get(k)); else byHash.set(k, i); }
      const k = fold(p.slice(p.lastIndexOf('/') + 1)) + '|' + size;
      (byName.get(k) || byName.set(k, []).get(k)).push(i);
    });
    for (const ids of byName.values()) for (let a = 1; a < ids.length; a++) {
      const [x, y] = [files[ids[0]].it[4], files[ids[a]].it[4]];
      if (!(x && y && x !== y)) join(ids[a], ids[0]);
    }
    const groups = new Map();
    files.forEach((f, i) => { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(f); });
    const out = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const size = g[0].it[1], hashes = new Set(g.map(f => f.it[4]));
      out.push({
        name: g[0].it[0].slice(g[0].it[0].lastIndexOf('/') + 1), size, exact: hashes.size === 1 && !hashes.has(''), wasted: size * (g.length - 1),
        items: g.map(f => ({ drive: f.drive, path: f.it[0], mtime: f.it[2] })).sort((a, b) => a.mtime - b.mtime),
      });
    }
    out.sort((a, b) => b.wasted - a.wasted);
    return { groups: out.slice(0, 500), count: out.length, wasted: out.reduce((t, g) => t + g.wasted, 0) };
  }

  return {
    setDrives(names) { known = names; if (enabled()) schedule(names); },
    refresh(names = known) { schedule(names.filter(n => known.includes(n)), true); },
    // Something changed on a drive: rebuild its index once things have been quiet for a few seconds.
    touch(name) {
      if (!enabled() || !known.includes(name)) return;
      clearTimeout(touched.get(name));
      touched.set(name, setTimeout(() => { touched.delete(name); schedule([name], true); }, 8000));
    },
    search, duplicates,
    status: () => known.map(name => { const idx = load(name); return { drive: name, built: idx?.built || null, count: idx?.items.length || 0, building: building.has(name) || queue.includes(name) }; }),
    size: () => { let b = 0; for (const f of (() => { try { return fs.readdirSync(dir); } catch (_) { return []; } })()) { try { b += fs.statSync(path.join(dir, f)).size; } catch (_) {} } return b; },
    clear() { queue.length = 0; mem.clear(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
};
