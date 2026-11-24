'use strict';
// Setup files: everything needed to set DriveDeck up again on another computer, in one file locked with a
// password. That's the drives and their sign-ins (from the rclone config), their colors and icons, the
// settings, the user's own Google app and the backups. Thumbnails and the search index are left out: they're
// rebuilt on their own.
//
// The file is JSON: { drivedeck: 'setup', version, created, kdf, cipher, iv, tag, data }. The contents are
// encrypted with AES-256-GCM, using a key made from the password with scrypt. Everything in the file but
// data and tag is checked by GCM too, so a changed header is caught like a wrong password.
//
// Sign-ins have to be locked: an OAuth token gives full access to its account, and rclone only scrambles
// passwords in its config (rclone reveal undoes that), so a plain copy would be as good as the passwords.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KIND = 'setup', VERSION = 1;
const KDF = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 };
const MIN_PASSWORD = 10;
const MAX_FILE = 8 * 1024 * 1024;
const NAME = /^[\w.\- ]{1,64}$/;
const KEEP_MINUTES = 15;             // an opened file waits this long for the user to choose what to import
// rclone settings that run a program on this computer (sftp's ssh, webdav's bearer_token_command, …). A setup
// file can come from someone else, so drives with these aren't imported: add them with rclone config instead.
const RUNS_COMMAND = k => k === 'ssh' || /_command$/.test(k);
// Settings that belong to this computer rather than to the person.
const LOCAL_PREFS = new Set(['setupDone']);

const b64 = b => Buffer.from(b).toString('base64');
const unb64 = (s, what) => { if (typeof s !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(s)) throw new Error(`This setup file is damaged (${what}).`); return Buffer.from(s, 'base64'); };
const keyFrom = (password, salt, k) => new Promise((resolve, reject) =>
  crypto.scrypt(String(password).normalize('NFC'), salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 512 * 1024 * 1024 }, (e, key) => e ? reject(e) : resolve(key)));
const header = f => JSON.stringify({ drivedeck: f.drivedeck, version: f.version, created: f.created, kdf: f.kdf, cipher: f.cipher, iv: f.iv });

async function seal(payload, password) {
  if (String(password || '').length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
  const kdf = { ...KDF, salt: b64(crypto.randomBytes(16)) };
  const f = { drivedeck: KIND, version: VERSION, created: new Date().toISOString(), kdf, cipher: 'aes-256-gcm', iv: b64(crypto.randomBytes(12)) };
  const key = await keyFrom(password, unb64(kdf.salt, 'salt'), kdf);
  const c = crypto.createCipheriv('aes-256-gcm', key, unb64(f.iv, 'iv'));
  c.setAAD(Buffer.from(header(f)));
  const data = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return JSON.stringify({ ...f, tag: b64(c.getAuthTag()), data: b64(data) }, null, 1) + '\n';
}

async function unseal(text, password) {
  let f;
  try { f = JSON.parse(text); } catch (_) { f = null; }
  if (!f || f.drivedeck !== KIND) throw new Error('This isn’t a DriveDeck setup file. Choose the file you saved with Export setup.');
  if (f.version > VERSION) throw new Error('This setup file was made by a newer DriveDeck. Update DriveDeck (npx drivedeck@latest) and try again.');
  const k = f.kdf || {};
  // The file says how hard the key is to make; keep that within sane bounds so a crafted file can't stall DriveDeck.
  if (k.name !== 'scrypt' || ![2 ** 14, 2 ** 15, 2 ** 16, 2 ** 17, 2 ** 18, 2 ** 19, 2 ** 20].includes(k.N) || k.r !== 8 || !(k.p >= 1 && k.p <= 4) || f.cipher !== 'aes-256-gcm')
    throw new Error('This setup file uses a format this DriveDeck doesn’t know.');
  const key = await keyFrom(password, unb64(k.salt, 'salt'), k);
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(f.iv, 'iv'));
  d.setAAD(Buffer.from(header(f)));
  d.setAuthTag(unb64(f.tag, 'tag'));
  let plain;
  try { plain = Buffer.concat([d.update(unb64(f.data, 'data')), d.final()]).toString('utf8'); }
  catch (_) { throw new Error('That password doesn’t open this setup file. Check it and try again.'); }
  const payload = JSON.parse(plain);
  return { created: f.created, payload };
}

// The drive a remote is stored in, from its "remote" setting ("mega1:Encrypted" -> mega1), if that drive is
// in the given set. Encrypted folders (crypt) work like this, and so do rclone's alias, chunker and others.
// Two drive settings are the same whatever order their keys are in.
const same = (a, b) => { const k = o => JSON.stringify(Object.keys(o).sort().map(x => [x, String(o[x])])); return k(a) === k(b); };
const parentOf = (params, names) => {
  const m = /^([^:/\\]{1,64}):/.exec(String(params?.remote || ''));
  return m && names.has(m[1]) ? m[1] : null;
};

module.exports = function createSetupFiles({ rcCall, readConfig, writeConfig, prefsOk, googleOk, backups, log }) {
  const opened = new Map();   // id -> { payload, created, timer }

  // ---- export ----
  async function exportFile(b) {
    const dump = await rcCall('config/dump');
    const want = Array.isArray(b.drives) ? b.drives.map(String) : Object.keys(dump);
    const names = new Set(want.filter(n => dump[n]));
    // A drive that others are stored in comes along with them, or they couldn't be opened.
    const all = new Set(Object.keys(dump));
    for (const n of [...names]) for (let p = parentOf(dump[n], all); p && !names.has(p); p = parentOf(dump[p], all)) names.add(p);
    if (!names.size) throw new Error('Choose at least one drive to export.');
    const c = readConfig();
    const remotes = {}, looks = {};
    for (const n of Object.keys(dump)) if (names.has(n)) { remotes[n] = dump[n]; if (c.drives[n]) looks[n] = c.drives[n]; }
    const payload = {
      app: 'DriveDeck', made: { host: os.hostname(), platform: process.platform, home: os.homedir() },
      remotes, looks,
      ...(b.settings !== false && { prefs: Object.fromEntries(Object.entries(c.prefs).filter(([k]) => !LOCAL_PREFS.has(k))) }),
      ...(b.google !== false && c.google && { google: c.google }),
      ...(b.backups !== false && { backups: backups.list().filter(x => names.has(x.dst.split(':')[0])).map(x => ({ src: x.src, dst: x.dst, every: x.every, mirror: x.mirror })) }),
    };
    log(`Exported a setup file with ${names.size} drive${names.size === 1 ? '' : 's'}`);
    return { text: await seal(payload, b.password), count: names.size };
  }

  // ---- open: decrypt and describe what's inside, so the user can choose ----
  async function openFile(text, password) {
    if (typeof text !== 'string' || !text) throw new Error('Choose a setup file.');
    if (text.length > MAX_FILE) throw new Error('This file is too big to be a DriveDeck setup file.');
    const { created, payload } = await unseal(text, password);
    const remotes = payload?.remotes && typeof payload.remotes === 'object' ? payload.remotes : {};
    for (const [n, r] of Object.entries(remotes)) if (!NAME.test(n) || !r || typeof r.type !== 'string') throw new Error('This setup file is damaged (drives).');
    const id = crypto.randomUUID();
    const timer = setTimeout(() => opened.delete(id), KEEP_MINUTES * 60 * 1000); timer.unref();
    opened.set(id, { payload, created, timer });
    return { id, ...(await describe(payload, created)) };
  }
  async function describe(p, created) {
    const here = await rcCall('config/dump');
    const fileNames = new Set(Object.keys(p.remotes));
    const c = readConfig();
    return {
      created, made: p.made || {},
      drives: Object.entries(p.remotes).map(([name, r]) => ({
        name, type: r.type, parent: parentOf(r, fileNames), look: p.looks?.[name] || null, runsCommand: Object.keys(r).some(RUNS_COMMAND),
        // same: an identical drive is already here (nothing to do); other: a different drive has this name.
        here: !here[name] ? null : same(here[name], r) ? 'same' : here[name].type === r.type ? 'other' : 'otherType',
      })).map((d, _, all) => {
        // A drive stored in another one is only the same if that one is too.
        for (let par = d.parent, i = 0; par && d.here === 'same' && i < 20; par = all.find(x => x.name === par)?.parent, i++) if (all.find(x => x.name === par)?.here !== 'same') d.here = 'other';
        return d;
      }),
      settings: !!(p.prefs && Object.keys(p.prefs).length),
      google: p.google?.clientId ? { clientId: p.google.clientId, differs: !!c.google && c.google.clientId !== p.google.clientId } : null,
      backups: (Array.isArray(p.backups) ? p.backups : []).map(x => ({ src: String(x.src || ''), dst: String(x.dst || ''), every: x.every, mirror: !!x.mirror, here: folderOnThis(x.src, p.made) })),
    };
  }
  const folderHere = src => { try { return path.isAbsolute(String(src)) && fs.statSync(String(src)).isDirectory(); } catch (_) { return false; } };
  // Where a backed-up folder is on this computer: the same path, or the same place in this computer's home
  // folder (/Users/old/Documents -> /Users/new/Documents). null if neither is there.
  const folderOnThis = (src, made) => {
    src = String(src || '');
    if (folderHere(src)) return src;
    const home = String(made?.home || '');
    if (!home || !src.startsWith(home) || !/^[\\/]/.test(src.slice(home.length))) return null;
    const rest = src.slice(home.length).split(/[\\/]/).filter(Boolean);
    const mine = path.join(os.homedir(), ...rest);
    return folderHere(mine) ? mine : null;
  };

  // ---- import ----
  // b: { id, drives: { name: 'add' | 'replace' | 'both' | 'skip' }, settings, google, backups }.
  // Drives are written to the rclone config as they were, with rclone's sign-in steps switched off
  // (nonInteractive), so importing never opens a browser or signs in anywhere. Whether each sign-in still
  // works is checked afterwards by the page, which offers Reconnect for any that don't.
  async function importFile(b) {
    const f = opened.get(String(b.id || ''));
    if (!f) throw new Error('This setup file was closed. Open it again to import it.');
    const p = f.payload, here = await rcCall('config/dump');
    const fileNames = new Set(Object.keys(p.remotes));
    const pick = b.drives && typeof b.drives === 'object' ? b.drives : {};
    const rename = {}, skipped = [], added = [];
    const taken = new Set(Object.keys(here));
    const freeName = n => { for (let i = 2; ; i++) { const x = `${n.slice(0, 60)}-${i}`; if (!taken.has(x)) return x; } };
    // Drives that others are stored in go first, so those know where their drive ended up.
    const order = [], seen = new Set();
    const visit = (n, depth = 0) => { if (seen.has(n) || depth > 20) return; seen.add(n); const par = parentOf(p.remotes[n], fileNames); if (par) visit(par, depth + 1); order.push(n); };
    fileNames.forEach(n => visit(n));
    // A drive the user leaves out (or keeps this computer's version of) isn't written; drives and backups that
    // point at it then use the drive of that name already here, if there is one.
    for (const n of order) {
      const how = pick[n];
      if (!['add', 'replace', 'both'].includes(how)) continue;
      const { type, ...params } = p.remotes[n];
      if (Object.keys(params).some(RUNS_COMMAND)) { skipped.push({ name: n, why: 'it runs a program on this computer, so add it with rclone config instead' }); continue; }
      const par = parentOf(p.remotes[n], fileNames);
      if (par) {
        const target = rename[par] || (here[par] ? par : null);   // imported (maybe renamed), or the drive of that name already here
        if (!target) { skipped.push({ name: n, why: `needs ${par}, which wasn’t imported` }); continue; }
        params.remote = target + String(params.remote).slice(par.length);
      }
      if (here[n] && how !== 'replace' && same(here[n], { type, ...params })) { skipped.push({ name: n, why: 'already here' }); continue; }
      const name = !here[n] || how === 'replace' ? n : freeName(n);
      taken.add(name);
      try {
        if (here[name] && how === 'replace') await rcCall('config/delete', { name });
        // noObscure: passwords in the file are already scrambled the way rclone stores them.
        await rcCall('config/create', { name, type, parameters: params, opt: { nonInteractive: true, noObscure: true } });
        rename[n] = name;
        added.push({ from: n, name, type });
      } catch (e) { skipped.push({ name: n, why: e.message.split('\n')[0] }); }
    }

    const c = structuredClone(readConfig());
    for (const { from, name } of added) {
      const l = p.looks?.[from];
      if (l && /^#[0-9a-f]{6}$/i.test(l.color || '') && typeof l.emoji === 'string' && l.emoji.length <= 32) c.drives[name] = { color: l.color.toLowerCase(), emoji: l.emoji };
      delete c.usage[name];
    }
    let lang = null;
    if (b.settings && p.prefs) for (const [k, v] of Object.entries(p.prefs)) {
      if (LOCAL_PREFS.has(k) || !prefsOk[k]?.(v)) continue;
      if (k === 'lang' && v !== c.prefs.lang) lang = v;
      c.prefs[k] = v;
    }
    const google = !!(b.google && p.google && googleOk(p.google));
    if (google) c.google = { clientId: p.google.clientId, clientSecret: p.google.clientSecret };
    writeConfig(c);

    const bk = { added: 0, paused: 0, skipped: 0 };
    if (b.backups && Array.isArray(p.backups)) {
      const now = await rcCall('config/dump');
      for (const x of p.backups) {
        const [drive, ...rest] = String(x.dst || '').split(':');
        const target = rename[drive] || (now[drive] ? drive : null);
        const dst = target ? `${target}:${rest.join(':')}` : null, src = folderOnThis(x.src, p.made) || String(x.src || '');
        if (!dst || backups.list().some(y => y.src === src && y.dst === dst)) { bk.skipped++; continue; }
        try { const v = await backups.add({ src, dst, every: x.every, mirror: x.mirror }, { imported: true }); bk.added++; if (v.paused) bk.paused++; }
        catch (_) { bk.skipped++; }
      }
    }
    clearTimeout(f.timer); opened.delete(b.id);
    log(`Imported a setup file: ${added.length} drive${added.length === 1 ? '' : 's'} added${skipped.length ? `, ${skipped.length} skipped` : ''}`);
    return { added, skipped, backups: bk, settings: !!(b.settings && p.prefs), google, lang };
  }

  const close = id => { const f = opened.get(id); if (f) { clearTimeout(f.timer); opened.delete(id); } };
  return { exportFile, openFile, importFile, close, MIN_PASSWORD };
};
