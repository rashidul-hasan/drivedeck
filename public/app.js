'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => { if (n == null || isNaN(n)) return '–'; const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; while (n >= 1024 && i < 5) { n /= 1024; i++; } return String(+n.toFixed(i > 1 ? (n < 10 ? 2 : 1) : 0)) + ' ' + u[i]; };
const ico = id => `<svg><use href="#i-${id}"/></svg>`;
const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- providers ----------
// Each supported rclone backend is described here; the add/reconnect dialogs are built from these fields.
const PROVIDERS = {
  mega: {
    label: 'MEGA', mark: 'M', color: '#d9272e', blurb: 'Encrypted storage, 20 GB free',
    fields: [
      { key: 'user', label: 'Email', type: 'email', required: true },
      { key: 'pass', label: 'Password', type: 'password', required: true },
      { key: '2fa', label: 'Two-factor code', hint: 'only if 2FA is on', inputmode: 'numeric' },
    ],
    // rclone caches a MEGA session in its config and never retries a fresh login if that session goes stale.
    // Clearing the cached keys forces a normal email/password login (plus a new 2FA code if needed).
    reconnect: { reset: { session_id: '', master_key: '' }, fields: [{ key: '2fa', label: 'Two-factor code', hint: 'only if 2FA is on', inputmode: 'numeric' }] },
    note: 'Your password is stored obscured in your rclone config on this computer.',
    serial: true,   // MEGA rate-limits logins made at the same time
  },
  // Drives with oauth sign in on the provider's own page (see "Google sign-in" below) instead of a form.
  drive: {
    label: 'Google Drive', mark: 'G', color: '#1a73e8', blurb: '15 GB free, shared with Gmail and Photos',
    oauth: true, prefix: 'gdrive', site: 'Google',
    trash: 'It moves to your Google Drive bin, where Google keeps it for 30 days.',
  },
  dropbox: {
    label: 'Dropbox', mark: 'D', color: '#0061fe', blurb: '2 GB free, with apps for every device',
    oauth: true, prefix: 'dropbox', site: 'Dropbox',
    trash: 'Dropbox keeps deleted files for at least 30 days, and you can restore them on its website.',
  },
  onedrive: {
    label: 'OneDrive', mark: 'O', color: '#0f6cbd', blurb: '5 GB free, personal or work accounts',
    oauth: true, prefix: 'onedrive', site: 'Microsoft',
    trash: 'It moves to your OneDrive recycle bin.',
  },
  // A folder inside another drive whose files (and names) are encrypted on this computer: an rclone crypt remote.
  crypt: {
    label: 'Encrypted folder', icon: 'lock', color: '#5b5bd6', blurb: 'A locked folder inside one of your drives',
    trash: 'It goes wherever the drive it’s stored in puts deleted files.',
  },
};
const COMING_SOON = [['Amazon S3', 'S3'], ['pCloud', 'P']];

const COLORS = ['#e5484d', '#f76b15', '#ffb224', '#30a46c', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#7c7f86'];
const EMOJIS = ['🗂️', '💾', '🗄️', '📦', '🏠', '💼', '🎓', '🎮', '🎬', '🎵', '📸', '🖼️', '📚', '✈️', '🌴', '🚀', '⭐', '🔥', '💎', '🌈', '🌙', '🌊', '🍀', '🌸', '🐳', '🦊', '🐼', '🐙', '🦄', '🐝', '🍕', '☕', '🎨', '🧪', '🔒', '💡', '❤️', '👾', '🪐', '☁️'];
const DEFAULT_EMOJIS = ['🐳', '🦊', '🚀', '🌈', '🍀', '💎', '🪐', '🐼', '🔥', '🌸'];

const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const inkFor = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b > .45 ? '#16181e' : '#ffffff';
};
const accent = (el, color) => {
  if (!color) { el.style.removeProperty('--drive'); el.style.removeProperty('--drive-ink'); return; }
  el.style.setProperty('--drive', color); el.style.setProperty('--drive-ink', inkFor(color));
};

// ---------- file kinds ----------
const KINDS = {
  image: 'jpg jpeg png gif webp heic heif bmp tif tiff avif svg',
  video: 'mp4 m4v mov webm mkv avi 3gp wmv flv mts m2ts mpg mpeg',
  audio: 'mp3 m4a m4b aac flac wav ogg oga opus weba aiff aif aifc caf wma ape alac amr ac3 eac3 dts mka wv mpc tta dsf dff au snd',
  archive: 'zip rar 7z tar gz tgz bz2 xz dmg iso',
  doc: 'pdf doc docx txt md rtf odt pages xls xlsx csv ppt pptx key numbers epub',
  code: 'js ts jsx tsx json html css py rb go rs java c cpp h sh yml yaml xml sql php swift kt',
};
for (const k in KINDS) KINDS[k] = new Set(KINDS[k].split(' '));
const BROWSER_IMG = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg']);
const BROWSER_VID = new Set(['mp4', 'm4v', 'webm', 'mov']);
const ICON = { folder: 'folder', image: 'image', video: 'video', audio: 'music', archive: 'archive', doc: 'doc', code: 'code', file: 'file' };
const extOf = n => (/\.([^.]+)$/.exec(n) || [])[1]?.toLowerCase() || '';
const kindOf = f => f.IsDir ? 'folder' : Object.keys(KINDS).find(k => KINDS[k].has(extOf(f.Name))) || 'file';
const rawUrl = (drive, p) => `/[${enc(drive)}:]/${p.split('/').map(enc).join('/')}`;

// ---------- language ----------
// English is written straight into the page. For Bangla, public/i18n-bn.js maps each English text (with {a},
// {b}… for names and numbers) to its translation, and the page is translated as it renders: text and the
// title, placeholder and aria-label attributes, everywhere except names, paths and file contents (SKIP).
// The language is kept in DriveDeck's settings and mirrored here so the first paint is already right.
const LANG = (() => { try { return localStorage.getItem('drivedeck-lang') === 'bn' ? 'bn' : 'en'; } catch (_) { return 'en'; } })();
const LOCALE = LANG === 'bn' ? 'bn-BD' : undefined;
document.documentElement.lang = LANG;
const SKIP = '[translate=no],code,pre,script,style,textarea,svg,.name,.lname,.drive-name,.look-name,.dup-name b,.dup-path,.pl-title,.pl-sub,.pk-row,.pk-drive,.pk-crumbs,.v-bar > b,.card-top b,.sr-main > b,.sr-where,.up-main > b,.bk-route,.pick-sel,.pickbox > span,.badge,.v-text,nav.crumbs .crumb';
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bnDigits = s => s.replace(/[0-9]/g, d => BN_DIGITS[d]);
const NUMERIC = /^[\s\d.,:%+\-–×/()]*(?:\s?(?:B|KB|MB|GB|TB|PB))?[\s\d.,:%/()]*$/;
const TR = { exact: new Map(), pats: [], done: new WeakMap() };
// A filled-in value: numbers get Bengali digits, and words built into a sentence ("3 files", "mirrored")
// are translated themselves. Names shown in quotes (“{a}”) stay exactly as they are.
const trValue = (v, quoted) => quoted ? v : NUMERIC.test(v) ? bnDigits(v) : trText(v) ?? v;
function trText(raw) {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/\d/.test(t) && NUMERIC.test(t)) return bnDigits(raw);   // sizes, counts, times
  if (!/[A-Za-z]/.test(t)) return null;
  let out = TR.exact.get(t);
  if (out == null) for (const p of TR.pats) {
    const m = p.re.exec(t); if (!m) continue;
    const val = n => m[1 + p.names.indexOf(n)] ?? '';
    if ([...p.counted].some(n => !/^[\d.,]+$/.test(val(n)))) continue;   // “{a}টি ড্রাইভ” is for numbers, not “MEGA drive”
    out = p.v.replace(/\{([a-j])\}/g, (_, n) => trValue(val(n), p.quoted.has(n)));
    break;
  }
  return out == null ? null : raw.match(/^\s*/)[0] + out + raw.match(/\s*$/)[0];
}
function trTree(root) {
  const attrs = el => { for (const a of ['title', 'placeholder', 'aria-label']) { const v = el.getAttribute(a); if (v) { const o = trText(v); if (o != null && o !== v) el.setAttribute(a, o); } } };
  const text = n => { const v = n.nodeValue; if (TR.done.get(n) === v) return; const o = trText(v); if (o != null && o !== v) n.nodeValue = o; TR.done.set(n, n.nodeValue); };
  if (root.nodeType === 3) { if (!root.parentElement?.closest(SKIP)) text(root); return; }
  if (root.nodeType !== 1 || root.closest(SKIP)) return;
  attrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? text(n) : attrs(n);
}
(function startTranslating() {
  if (LANG !== 'bn' || !window.I18N_BN) return;
  for (const [k, v] of Object.entries(window.I18N_BN)) {
    if (!/\{[a-j]\}/.test(k)) { TR.exact.set(k, v); continue; }
    if (!/[A-Za-z]{2}/.test(k.replace(/\{[a-j]\}/g, ''))) continue;   // a pattern with no words would match almost anything
    const names = [];
    const re = new RegExp('^' + k.split(/(\{[a-j]\})/).map(x => /^\{[a-j]\}$/.test(x) ? (names.push(x[1]), '(.+?)') : x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 's');
    TR.pats.push({ re, names, v, lit: k.replace(/\{[a-j]\}/g, '').length,
      quoted: new Set([...k.matchAll(/“\{([a-j])\}”/g)].map(x => x[1])), counted: new Set([...v.matchAll(/\{([a-j])\}টি/g)].map(x => x[1])) });
  }
  TR.pats.sort((a, b) => b.lit - a.lit);   // the most specific text first
  trTree(document.body);
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(trTree);
      else if (m.type === 'characterData') trTree(m.target);
      else if (m.target.nodeType === 1 && !m.target.closest(SKIP)) trTree(m.target);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder', 'aria-label'] });
})();
async function setLanguage(lang) {
  try { localStorage.setItem('drivedeck-lang', lang); } catch (_) {}
  await patchConfig({ prefs: { lang } }).catch(() => {});
  location.reload();
}

const DATE = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' });
const DATE_Y = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
const TIME = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' });
const fmtDate = s => {
  const d = new Date(s); if (isNaN(d)) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today, ' + TIME.format(d);
  return (d.getFullYear() === now.getFullYear() ? DATE : DATE_Y).format(d);
};

// ---------- state ----------
const S = {
  cfg: { drives: {}, prefs: {} }, features: {},
  remotes: [], drives: [], loaded: false,
  sel: null, path: '', list: null, listErr: null, items: [], filter: '', picked: new Set(), anchor: null,
  view: 'grid', sort: { key: 'name', dir: 1 }, theme: 'auto', nav: 0, page: 'home',
};
const lookOf = name => {
  const d = S.cfg.drives[name] || {};
  return { color: d.color || COLORS[hash(name) % COLORS.length], emoji: d.emoji || DEFAULT_EMOJIS[hash(name) % DEFAULT_EMOJIS.length] };
};
const driveOf = name => S.drives.find(d => d.name === name);

// ---------- api ----------
// Every request goes through api(), so losing the sign-in cookie shows a clear screen instead of a page
// that loads forever.
async function api(url, init) {
  const r = await fetch(url, init);
  if (r.status === 401) signedOut();
  return r;
}
function signedOut() {
  if (S.page === 'signedout') return;
  S.page = 'signedout'; S.nav++;
  clearTimeout(UP.timer); clearTimeout(setupTimer);
  document.body.classList.add('setup-mode');
  $('#main').innerHTML = `<div class="content"><div class="empty err"><div class="ill">${ico('link')}</div><h3>Open DriveDeck from your terminal</h3>
    <p>This browser isn’t signed in to DriveDeck anymore. Go to the terminal where DriveDeck is running and press Enter, or open the link it printed. If you restarted DriveDeck, use the new link.</p></div></div>`;
}
async function rc(cmd, p = {}) {
  const r = await api('/' + cmd, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function patchConfig(patch) {
  const r = await api('/_ui/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  S.cfg = { ...S.cfg, drives: j.drives, prefs: j.prefs, usage: j.usage, google: j.google };
}
let prefTimer;
const savePrefs = () => { clearTimeout(prefTimer); prefTimer = setTimeout(() => patchConfig({ prefs: { view: S.view, sort: S.sort, theme: S.theme } }).catch(() => {}), 400); };

// ---------- small ui helpers ----------
function toast(msg, type = '') {
  if (S.page === 'signedout') return;   // the signed-out screen already says what to do
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = (type === 'ok' ? ico('check') : type === 'err' ? ico('alert') : '') + `<span>${esc(msg)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); el.addEventListener('animationend', () => el.remove()); }, type === 'err' ? 6000 : 3200);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.html = btn.innerHTML; btn.classList.add('busy'); btn.innerHTML = `<span class="spin"></span>${esc(label || '')}`; }
  else if (btn.dataset.html) { btn.classList.remove('busy'); btn.innerHTML = btn.dataset.html; }
}
// Usage bars grow from their last rendered width to the new one, so re-renders animate instead of jumping.
const barMemo = new Map();
function growBars(root) {
  const els = $$('[data-k]', root);
  for (const el of els) el.style[el.dataset.prop || 'width'] = (barMemo.get(el.dataset.k) ?? 0) + '%';
  void root.offsetWidth;
  for (const el of els) { el.style[el.dataset.prop || 'width'] = el.dataset.w + '%'; barMemo.set(el.dataset.k, el.dataset.w); }
}
const pct = (a, b) => b ? Math.max(0, Math.min(100, a / b * 100)).toFixed(2) : 0;

// ---------- popover menu ----------
let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  const { el, anchor } = openMenu; openMenu = null;
  anchor.setAttribute('aria-expanded', 'false');
  el.classList.add('closing'); el.addEventListener('animationend', () => el.remove());
}
function menu(anchor, items) {
  if (openMenu?.anchor === anchor) return closeMenu();
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu'; el.setAttribute('role', 'menu');
  el.innerHTML = items.map((it, i) => it === '-' ? '<hr>' :
    `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${ico(it.icon)}<span>${esc(it.label)}${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}</span></button>`).join('');
  document.body.append(el);
  const r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
  const below = r.bottom + 6 + h < innerHeight;
  el.style.left = left + 'px'; el.style.top = (below ? r.bottom + 6 : r.top - h - 6) + 'px';
  el.style.setProperty('--origin', `${r.right - left > w / 2 ? 'right' : 'left'} ${below ? 'top' : 'bottom'}`);
  el.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; closeMenu(); items[b.dataset.i].run(); };
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = { el, anchor };
  el.querySelector('button')?.focus({ preventScroll: true });
}
document.addEventListener('pointerdown', e => { if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu(); });
addEventListener('resize', closeMenu);

// ---------- modal ----------
const modal = $('#modal');
let closingTimer = null;
function openModal(html, cls = '') {
  // A dialog opened while the last one is still closing: finish that close now (its callback included),
  // so its timer can't shut this one.
  if (closingTimer) { clearTimeout(closingTimer); closingTimer = null; const done = modal.onclose; modal.onclose = null; done?.(); }
  modal.className = 'modal ' + cls; modal.innerHTML = html; accent(modal, null);
  if (!modal.open) modal.showModal();
  $$('[data-close]', modal).forEach(b => b.addEventListener('click', closeModal));
  setTimeout(() => $('[autofocus]', modal)?.focus(), 30);
}
function closeModal() {
  if (!modal.open || modal.classList.contains('closing')) return;
  modal.classList.add('closing');
  closingTimer = setTimeout(() => { closingTimer = null; modal.close(); modal.classList.remove('closing'); modal.innerHTML = ''; modal.onclose?.(); modal.onclose = null; }, 150);
}
modal.addEventListener('cancel', e => { e.preventDefault(); closeModal(); });
modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });
const modalHead = (title, sub, back) => `<div class="m-head">${back ? `<button class="icon-btn back" data-back title="Back">${ico('chev-l')}</button>` : ''}<div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div><button class="icon-btn" data-close title="Close">${ico('x')}</button></div>`;
const formError = (root, msg) => { const el = $('.form-err', root); el.hidden = !msg; el.innerHTML = msg ? ico('alert') + `<span>${esc(msg)}</span>` : ''; };
const fieldHtml = (f, id) => `<label class="field"><span>${esc(f.label)}${f.hint ? `<em>${esc(f.hint)}</em>` : ''}</span>
  <input class="input" id="${id}" type="${f.type === 'password' ? 'password' : f.type === 'email' ? 'email' : 'text'}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} autocomplete="off" spellcheck="false" ${f.value ? `value="${esc(f.value)}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}></label>`;

// Generic dialog: resolves with the field values (or true) once onSubmit succeeds, or null if dismissed.
function dialog({ title, text, fields = [], ok = 'Save', danger = false, onSubmit }) {
  return new Promise(resolve => {
    let done = false;
    openModal(`${modalHead(title, text)}<form class="m-body" id="dlgForm">${fields.map((f, i) => fieldHtml(f, 'df' + i)).join('')}<div class="form-err" hidden></div></form>
      <div class="m-foot"><button class="btn ghost" data-cancel>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" form="dlgForm" type="submit">${esc(ok)}</button></div>`, 'sm');
    if (fields.length) $('#df0', modal).setAttribute('autofocus', ''); else $('[type=submit]', modal).setAttribute('autofocus', '');
    if (!fields.length) $('#dlgForm', modal).hidden = !$('.form-err', modal).innerHTML;
    modal.onclose = () => { if (!done) resolve(null); };
    $('[data-cancel]', modal).onclick = closeModal;
    $('#dlgForm', modal).onsubmit = async e => {
      e.preventDefault();
      const vals = Object.fromEntries(fields.map((f, i) => [f.key, $('#df' + i, modal).value.trim()]));
      const btn = $('[type=submit]', modal);
      for (const [i, f] of fields.entries()) if (f.required && !vals[f.key]) { const el = $('#df' + i, modal); el.classList.remove('bad'); void el.offsetWidth; el.classList.add('bad'); el.focus(); return; }
      busy(btn, true, ok);
      try { await onSubmit?.(vals); done = true; resolve(fields.length ? vals : true); closeModal(); }
      catch (err) { $('#dlgForm', modal).hidden = false; formError(modal, err.message); busy(btn, false); }
    };
  });
}

// ---------- theme ----------
const THEMES = { auto: ['auto', 'Theme: match system'], light: ['sun', 'Theme: light'], dark: ['moon', 'Theme: dark'] };
function applyTheme() {
  if (S.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = S.theme;
  $('#bTheme').innerHTML = ico(THEMES[S.theme][0]); $('#bTheme').title = THEMES[S.theme][1];
}
$('#bTheme').onclick = () => setTheme({ auto: 'light', light: 'dark', dark: 'auto' }[S.theme]);

// ---------- drives ----------
async function loadDrives() {
  const btn = $('#bRef'); btn.classList.add('spinning');
  try {
    const d = await rc('config/dump');
    S.remotes = Object.keys(d);
    // Start from the last known numbers (from this session, or saved from the previous one) so the
    // sidebar and overview show up filled in; fresh numbers replace them as each drive answers.
    const prev = new Map(S.drives.map(x => [x.name, x])), saved = S.cfg.usage || {};
    const all = S.remotes.filter(k => PROVIDERS[d[k].type]).map(name => {
      const u = saved[name], t = d[name].type;
      const where = t === 'crypt' ? { parent: String(d[name].remote || '').split(':')[0], at: String(d[name].remote || '').split(':').slice(1).join(':').replace(/^\/+|\/+$/g, '') } : {};
      return { ...(u && t !== 'crypt' && { used: u.used, total: u.total, free: u.free }), ...prev.get(name), name, type: t, ...where, pending: t !== 'crypt' };
    });
    // Each encrypted folder is listed right after the drive it's stored in.
    const plain = all.filter(x => x.type !== 'crypt');
    S.drives = [...plain.flatMap(x => [x, ...all.filter(c => c.type === 'crypt' && c.parent === x.name)]), ...all.filter(c => c.type === 'crypt' && !plain.some(x => x.name === c.parent))];
    S.loaded = true;
    if (indexOn()) sendDrivesToIndex();
    const gone = Object.keys(saved).filter(n => !S.remotes.includes(n));   // removed from the rclone config
    if (gone.length) patchConfig({ usage: Object.fromEntries(gone.map(n => [n, null])) }).catch(() => {});
    renderSide(); if (S.page === 'home') renderHome(false);
    if (S.page === 'drive' && nativeThumbs()) renderFiles(false);   // the drive's type is known now
    // Drives whose provider rate-limits logins are checked one at a time; the rest all at once.
    const serial = S.drives.filter(d => PROVIDERS[d.type].serial);
    await Promise.all([(async () => { for (const dr of serial) await aboutDrive(dr); })(), ...S.drives.filter(d => !serial.includes(d)).map(aboutDrive)]);
  } finally { btn.classList.remove('spinning'); }
}
const checking = d => d.used == null && d.type !== 'crypt';   // no numbers yet, saved or fresh
// Drives that report what they use but no limit (encrypted folders report nothing: their space is their drive's).
const noLimit = d => d.total == null && !checking(d) && !d.err && d.type !== 'crypt';
const cryptPlace = d => `${d.parent}${d.at ? '/' + d.at : ''}`;
async function aboutDrive(dr) {
  if (dr.type === 'crypt') { dr.pending = false; return; }   // its space is counted in the drive it's stored in
  dr.pending = true;
  try {
    const a = await rc('operations/about', { fs: dr.name + ':' });
    // Some accounts (Google Workspace with pooled storage, for example) report no total: only what's used.
    Object.assign(dr, { used: a.used ?? 0, total: a.total ?? null, free: a.free ?? (a.total != null ? a.total - a.used : null), err: null });
    patchConfig({ usage: { [dr.name]: { used: dr.used, total: dr.total, free: dr.free } } }).catch(() => {});
  } catch (e) { dr.err = e.message; }
  dr.pending = false;
  renderSide(); if (S.page === 'home') renderHome(false);
}

function renderSide() {
  $('#navHome').classList.toggle('on', S.page === 'home');
  $('#navSettings').classList.toggle('on', S.page === 'settings');
  $('#navDup').classList.toggle('on', S.page === 'duplicates');
  const count = $('#driveCount'), n = String(S.drives.length);
  if (count.textContent !== n) { count.textContent = n; count.classList.remove('bump'); void count.offsetWidth; count.classList.add('bump'); }
  count.hidden = !S.loaded;
  count.title = `${n} drive${n === '1' ? '' : 's'}`;
  $('#drives').innerHTML = S.drives.map(d => {
    const { color, emoji } = lookOf(d.name);
    const meta = d.err ? `<span class="drive-meta err">Can't connect</span>`
      : d.type === 'crypt' ? `<span class="drive-meta crypt">${ico('lock')}Encrypted, in ${esc(d.parent)}</span>`
      : checking(d) ? `<span class="drive-meta">Checking…</span>`
      : d.total == null ? `<span class="drive-meta num">${fmt(d.used)} used</span>`
      : `<span class="drive-meta num ${nearlyFull(d) ? 'warn' : ''}" ${nearlyFull(d) ? 'title="Nearly full"' : ''}>${fmt(d.free)} free of ${fmt(d.total)}</span>`;
    const bar = d.err || d.type === 'crypt' || (d.total == null && !checking(d)) ? '' : `<div class="bar ${checking(d) ? 'pending' : ''}"><i class="${nearlyFull(d) ? 'low' : ''}" data-k="s:${esc(d.name)}" data-w="${pct(d.used, d.total)}"></i></div>`;
    return `<div class="drive ${d.name === S.sel ? 'on' : ''} ${d.pending && !checking(d) ? 'refreshing' : ''} ${d.type === 'crypt' && driveOf(d.parent) ? 'nested' : ''}" role="button" tabindex="0" data-drive="${esc(d.name)}" style="--c:${color}">
      <span class="badge" style="--c:${color}">${esc(emoji)}</span>
      <span class="drive-body"><span class="drive-name">${esc(d.name)}</span>${meta}${bar}</span>
      <button class="icon-btn sm" data-dmenu="${esc(d.name)}" title="Drive options" aria-haspopup="menu">${ico('more')}</button></div>`;
  }).join('');
  growBars($('#drives'));
  const ok = S.drives.filter(d => d.total != null && !d.err), T = ok.reduce((s, d) => s + d.total, 0), U = ok.reduce((s, d) => s + d.used, 0);
  const open = S.drives.filter(noLimit);
  $('#poolMini').innerHTML = !ok.length && open.length ? `<div><b class="num">${fmt(open.reduce((s, d) => s + d.used, 0))}</b> used across ${open.length} drive${open.length === 1 ? '' : 's'}</div>`
    : S.drives.length ? `<div><b class="num">${fmt(T - U)}</b> free across ${ok.length} drive${ok.length === 1 ? '' : 's'}</div>
    <div class="pool-strip">${ok.map(d => `<i style="--c:${lookOf(d.name).color}" data-prop="flexBasis" data-k="m:${esc(d.name)}" data-w="${pct(d.used, T)}" title="${esc(d.name)}: ${fmt(d.used)} used"></i>`).join('')}</div>
    <div class="num">${fmt(U)} used of ${fmt(T)}</div>` : '';
  growBars($('#poolMini'));
}
$('#drives').addEventListener('click', e => {
  const m = e.target.closest('[data-dmenu]');
  if (m) { e.stopPropagation(); return driveMenu(m, m.dataset.dmenu); }
  const d = e.target.closest('[data-drive]'); if (d) go(d.dataset.drive);
});
$('#drives').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-drive]')) go(e.target.dataset.drive); });
$('#navHome').onclick = () => go(null);
$('#navSettings').onclick = () => { if (location.hash === '#settings') route(); else location.hash = '#settings'; };
$('#navDup').onclick = () => { if (location.hash === '#duplicates') route(); else location.hash = '#duplicates'; };
$('#bRef').onclick = () => loadDrives().catch(e => toast(e.message, 'err'));
$('#bAdd').onclick = () => addDrive();

function driveMenu(anchor, name) {
  const dr = driveOf(name), p = PROVIDERS[dr?.type];
  if (dr?.type === 'crypt') return menu(anchor, [
    { icon: 'brush', label: 'Change color and icon', run: () => editLook(name) },
    { icon: 'folder', label: `Open in ${dr.parent}`, hint: 'Shows the encrypted files as they’re stored', run: () => go(dr.parent, dr.at) },
    '-',
    { icon: 'trash', label: 'Remove encrypted folder', hint: 'The encrypted files stay where they are', danger: true, run: () => removeDrive(name) },
  ]);
  menu(anchor, [
    { icon: 'brush', label: 'Change color and icon', run: () => editLook(name) },
    { icon: 'link', label: 'Reconnect', hint: p?.oauth ? `Sign in to ${p.label} again` : 'Sign in again if the session expired', run: () => reconnect(name) },
    '-',
    { icon: 'trash', label: 'Remove drive', hint: `Your files stay on ${p?.label || 'the cloud'}`, danger: true, run: () => removeDrive(name) },
  ]);
}

// ---------- routing ----------
function go(name, p = '') {
  const h = name ? '#/' + [name, ...(p ? p.split('/') : [])].map(enc).join('/') : '#/';
  if (location.hash === h || (!name && !location.hash)) route(); else location.hash = h;
}
function route() {
  let parts = [];
  try { parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent); } catch (_) {}
  closeDrawer(); closeMenu();
  if (location.hash === '#setup' || (SETUP && !SETUP.backend)) return showSetup();   // nothing else works without rclone
  if (location.hash === '#settings') return showSettings();
  if (location.hash === '#duplicates') return showDuplicates();
  if (!parts.length) { leaveFolder(); Object.assign(S, { sel: null, page: 'home' }); S.nav++; renderSide(); renderHome(true); }
  else openDir(parts[0], parts.slice(1).join('/'));
}
addEventListener('hashchange', route);

// ---------- home ----------
function renderHome(anim) {
  const main = $('#main'); accent(main, null);
  const ok = S.drives.filter(d => d.total != null && !d.err);
  const T = ok.reduce((s, d) => s + d.total, 0), U = ok.reduce((s, d) => s + d.used, 0);
  let body;
  if (!S.loaded) body = `<div class="home"><div class="skel" style="height:34px;width:200px"></div><div class="skel" style="height:16px;margin:40px 0 50px"></div><div class="cards">${'<div class="skel" style="height:132px;border-radius:16px"></div>'.repeat(3)}</div></div>`;
  else if (!S.drives.length) body = `<div class="empty"><div class="ill">${ico('cloud')}</div><h3>Connect your first drive</h3>
    <p>Browse, upload and download across all your cloud accounts from one place.</p>
    <div class="empty-acts"><button class="btn primary" data-act="add">${ico('plus')}Add drive</button><button class="btn" data-act="sf-import">${ico('upload')}Import a setup file</button></div>
    <p class="empty-hint">Used DriveDeck on another computer? Export your setup there, in Settings, and import it here.</p></div>`;
  const open = S.drives.filter(noLimit);
  const onlyOpen = !ok.length && open.length, openUsed = open.reduce((s, d) => s + d.used, 0);
  if (S.loaded && S.drives.length) body = `<div class="home">
    <h1>All drives</h1>
    <div class="pool">
      <div class="pool-head"><div class="pool-big num">${onlyOpen ? `${fmt(openUsed)}<small>used</small>` : `${fmt(T - U)}<small>free of ${fmt(T)}</small>`}</div>
        <div class="mute num">${S.drives.some(d => d.pending && !checking(d)) ? '<span class="updating"><span class="spin"></span>Updating</span>' : ''}${onlyOpen ? `No storage limit reported for ${open.length === 1 ? 'this drive' : 'these drives'}` : `${fmt(U)} used across ${ok.length} drive${ok.length === 1 ? '' : 's'}`}</div></div>
      <div class="pool-meter">${ok.map(d => `<i style="--c:${lookOf(d.name).color}" data-prop="flexBasis" data-k="h:${esc(d.name)}" data-w="${pct(d.used, T)}" title="${esc(d.name)}: ${fmt(d.used)}"></i>`).join('')}</div>
      <div class="legend">${ok.map(d => `<span><i style="--c:${lookOf(d.name).color}"></i><span translate="no">${esc(d.name)}</span> <span class="num">${fmt(d.used)}</span></span>`).join('')}</div>
      <div class="home-acts"><button class="btn primary" data-act="auto" ${ok.length ? '' : 'disabled'} title="Uploads to the root of the drive with the most free space">${ico('upload')}Upload to the drive with most space</button></div>
    </div>
    ${importNote()}${fullNote()}
    <div class="cards">${S.drives.map(d => {
      const { color, emoji } = lookOf(d.name);
      const status = d.err ? `<div class="card-nums">Can't connect. Open the menu to reconnect.</div>`
        : d.type === 'crypt' ? `<div class="card-nums crypt">${ico('lock')}<span>Stored in ${esc(cryptPlace(d))}</span></div>`
        : checking(d) ? `<div class="bar pending"><i></i></div><div class="card-nums">Checking…</div>`
        : d.total == null ? `<div class="card-nums num"><span><b>${fmt(d.used)}</b> used</span><span>No storage limit reported</span></div>`
        : `<div class="bar lg"><i style="--c:${color}" class="${nearlyFull(d) ? 'low' : ''}" data-k="c:${esc(d.name)}" data-w="${pct(d.used, d.total)}"></i></div>
           <div class="card-nums num"><span><b>${fmt(d.used)}</b> used</span><span class="${nearlyFull(d) ? 'warn' : ''}">${nearlyFull(d) ? ico('alert') : ''}<b>${fmt(d.free)}</b> free</span></div>`;
      return `<button class="card ${d.err ? 'err' : ''} ${d.pending && !checking(d) ? 'refreshing' : ''}" style="--c:${color}" data-open="${esc(d.name)}">
        <div class="card-top"><span class="badge md" style="--c:${color}">${esc(emoji)}</span><div><b>${esc(d.name)}</b><span>${esc(PROVIDERS[d.type].label)}${d.type === 'crypt' ? '' : d.total != null && !d.err ? ' drive, ' + fmt(d.total) : ' drive'}</span></div></div>${status}</button>`;
    }).join('')}<button class="card add" data-act="add">${ico('plus')}Add drive</button></div></div>`;
  main.innerHTML = `<div class="toolbar"><button class="icon-btn menu-btn" data-act="drawer" title="Drives">${ico('menu')}</button>
    <div class="crumbs"><span class="crumb">All drives</span></div></div>
    <div class="content ${anim ? 'enter' : ''}" id="content">${body}</div>${dropHtml()}`;
  growBars(main);
}

// Drives at 90% or more, with what to do about it.
function fullNote() {
  const full = S.drives.filter(nearlyFull);
  if (!full.length) return '';
  const best = S.drives.filter(d => !d.err && d.free != null && !nearlyFull(d)).sort((a, b) => b.free - a.free)[0];
  const list = full.map(d => `<li><b>${esc(d.name)}</b> <span class="num">${Math.floor(d.used / d.total * 100)}% full, ${fmt(d.free)} left</span></li>`).join('');
  return `<div class="space-warn" role="status">${ico('alert')}<div>
      <b>${full.length === 1 ? `${esc(full[0].name)} is nearly full` : `${full.length} drives are nearly full`}</b>
      ${full.length > 1 ? `<ul>${list}</ul>` : `<p class="num">${Math.floor(full[0].used / full[0].total * 100)}% full, ${fmt(full[0].free)} left.</p>`}
      <p>${best ? `Uploads from this screen go to the drive with the most space, now ${esc(best.name)} (${fmt(best.free)} free).` : ''}${indexOn() ? ' Deleting copies of files stored twice is a quick way to free some up.' : ''}</p>
      ${indexOn() ? `<div class="space-acts"><button class="btn sm" data-act="dupes">${ico('dupes')}Find duplicates</button></div>` : ''}</div></div>`;
}

// ---------- browser ----------
// Folders seen before render straight from this cache (with their scroll position) and refresh quietly;
// the loading skeleton only appears on a folder's first visit.
const listCache = new Map(), scrollMemo = new Map();
const listKey = (drive, p) => drive + '\0' + p;
const sameList = (a, b) => a.length === b.length && a.every((f, i) => f.Path === b[i].Path && f.Size === b[i].Size && f.ModTime === b[i].ModTime);
const forget = (drive, prefix = '') => { for (const k of listCache.keys()) if (k.startsWith(listKey(drive, prefix))) listCache.delete(k); };
function leaveFolder() {
  const c = $('#content');
  if (S.sel && c) scrollMemo.set(listKey(S.sel, S.path), c.scrollTop);
  thumbsCancel();
}
async function openDir(name, p) {
  leaveFolder();
  const nav = ++S.nav, key = listKey(name, p), cached = listCache.get(key);
  if (S.focus && (S.focus.drive !== name || parentOf(S.focus.path) !== p)) S.focus = null;
  Object.assign(S, { sel: name, page: 'drive', path: p, list: cached || null, listErr: null, filter: '', picked: new Set(), anchor: null });
  renderSide(); renderBrowser(!!cached);
  if (cached) $('#content').scrollTo({ top: scrollMemo.get(key) || 0, behavior: 'instant' });
  try {
    const l = (await rc('operations/list', { fs: name + ':', remote: p })).list;
    listCache.set(key, l);
    if (nav !== S.nav || (cached && sameList(cached, l))) return;
    S.list = l;
  } catch (e) {
    if (nav !== S.nav) return;
    if (cached) return toast(`Couldn't refresh this folder: ${e.message}`, 'err');
    S.listErr = e.message;
  }
  renderFiles(!cached);
}
async function reloadList() {
  const nav = S.nav, key = listKey(S.sel, S.path);
  try {
    const l = (await rc('operations/list', { fs: S.sel + ':', remote: S.path })).list;
    listCache.set(key, l);
    if (nav === S.nav) { S.list = l; S.listErr = null; renderFiles(false); }
  } catch (e) { if (nav === S.nav) toast(e.message, 'err'); }
}

function renderBrowser(anim = false) {
  const main = $('#main'), name = S.sel, { color, emoji } = lookOf(name);
  accent(main, color);
  const parts = S.path ? S.path.split('/') : [];
  let crumbs = parts.map((s, i) => ({ label: s, p: parts.slice(0, i + 1).join('/') }));
  if (crumbs.length > 3) crumbs = [{ label: '…', p: crumbs[crumbs.length - 3].p }, ...crumbs.slice(-2)];
  main.innerHTML = `<div class="toolbar">
    <button class="icon-btn menu-btn" data-act="drawer" title="Drives">${ico('menu')}</button>
    <nav class="crumbs"><span class="badge xs" style="--c:${color}">${esc(emoji)}</span><button class="crumb" data-p="">${esc(name)}</button>${crumbs.map(c => `${ico('chev-r')}<button class="crumb" data-p="${esc(c.p)}" title="${esc(c.label)}">${esc(c.label)}</button>`).join('')}</nav>
    <label class="search">${ico('search')}<input id="q" type="text" placeholder="Filter this folder" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
    <div class="seg" data-v="${S.view}" role="group" aria-label="View"><button data-view="grid" title="Grid view" aria-pressed="${S.view === 'grid'}">${ico('grid')}</button><button data-view="list" title="List view" aria-pressed="${S.view === 'list'}">${ico('list')}</button></div>
    <button class="icon-btn" data-act="mkdir" title="New folder">${ico('folder-plus')}</button>
    <button class="btn primary" data-act="upmenu" aria-haspopup="menu">${ico('upload')}<span class="upload-label">Upload</span></button>
    <button class="icon-btn" data-act="dmenu" title="Drive options" aria-haspopup="menu">${ico('more')}</button>
    <div class="selbar" hidden></div>
  </div><div class="content" id="content"></div>${dropHtml()}`;
  $('#q').oninput = e => { S.filter = e.target.value.trim().toLowerCase(); renderFiles(false); };
  $('#q').onkeydown = e => { if (e.key === 'Escape' && e.target.value) { e.stopPropagation(); e.target.value = ''; S.filter = ''; renderFiles(false); } };
  renderFiles(anim);
}

function sorted() {
  const { key, dir } = S.sort;
  const cmp = key === 'size' ? (a, b) => a.Size - b.Size : key === 'modified' ? (a, b) => new Date(a.ModTime) - new Date(b.ModTime) : (a, b) => a.Name.localeCompare(b.Name, undefined, { numeric: true, sensitivity: 'base' });
  return S.list.filter(f => !S.filter || f.Name.toLowerCase().includes(S.filter))
    .sort((a, b) => (b.IsDir - a.IsDir) || (cmp(a, b) * dir) || a.Name.localeCompare(b.Name));
}

// Thumbnails come from the server (ffmpeg/sips, cached in ~/.drivedeck/thumbs). If that fails, the browser
// renders the original when it can: small images directly, and a video's first frame via <video preload=metadata>.
// Drives whose provider serves thumbnails always ask the server; otherwise thumbnails are only made (or
// originals shown) when "Make thumbnails on this computer" is on in settings.
const thumbUrl = (f, k) => `/_ui/thumb?fs=${enc(S.sel + ':')}&path=${enc(f.Path)}&kind=${k}&id=${enc(f.ID || '')}&v=${enc(f.ModTime + '|' + f.Size)}`;
const autoThumbs = () => S.cfg.prefs.thumbs !== false;
const nativeThumbs = () => (S.features.nativeThumbs || []).includes(driveOf(S.sel)?.type);
const serverThumbs = k => nativeThumbs() || (autoThumbs() && (k === 'video' ? S.features.ffmpeg : (S.features.ffmpeg || S.features.sips)));
const thumbState = new Map();   // url -> 'ok' | 'fail', for everything loaded this session
const mediaHtml = (tag, url, i, stage) => {
  const ok = thumbState.get(url) === 'ok', attrs = `data-i="${i}" data-stage="${stage}" data-url="${esc(url)}" ${ok ? `class="ready" src="${esc(url)}"` : `data-src="${esc(url)}"`}`;
  return tag === 'img' ? `<img decoding="async" alt="" ${attrs}>` : `<video muted playsinline preload="metadata" ${attrs}></video>`;
};
// Returns the media element markup for a file, or '' when it gets a plain icon.
function thumbHtml(f, i) {
  const k = kindOf(f); if (k !== 'image' && k !== 'video') return '';
  const e = extOf(f.Name);
  if (k === 'image' && autoThumbs() && (e === 'svg' || (e === 'gif' && f.Size < 4e6))) return mediaHtml('img', rawUrl(S.sel, f.Path), i, 'raw');
  const url = thumbUrl(f, k);
  if (serverThumbs(k) && thumbState.get(url) !== 'fail') return mediaHtml('img', url, i, 'thumb');
  return fallbackHtml(f, i) || '';
}
function fallbackHtml(f, i) {
  const k = kindOf(f), e = extOf(f.Name), raw = rawUrl(S.sel, f.Path);
  if (!autoThumbs()) return null;
  if (k === 'image' && BROWSER_IMG.has(e) && f.Size < 25e6 && thumbState.get(raw) !== 'fail') return mediaHtml('img', raw, i, 'raw');
  if (k === 'video' && BROWSER_VID.has(e) && thumbState.get(raw + '#t=1') !== 'fail') return mediaHtml('video', raw + '#t=1', i, 'raw');
  return null;
}
function thumbFailed(el) {
  const f = S.items[el.dataset.i], frame = el.parentElement;
  const next = el.dataset.stage === 'thumb' && f && fallbackHtml(f, el.dataset.i);
  el.remove();
  if (next) { frame.insertAdjacentHTML('beforeend', next); TL.queue.unshift(frame.lastElementChild); thumbsPump(); }
  else frame?.classList.remove('loading');
}
function thumbReady(el) { el.classList.add('ready'); el.parentElement?.classList.remove('loading'); }

// Thumbnails load near the viewport and at most 3 at a time, so a folder listing always gets one of the
// browser's ~6 connections to this server. Leaving a folder cancels whatever is still loading in it.
const TL = { queue: [], active: new Set(), io: null };
function thumbsWatch(root) {
  thumbsCancel();
  TL.io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { TL.io.unobserve(e.target); TL.queue.push(e.target); }
    thumbsPump();
  }, { root: $('#content'), rootMargin: '300px 0px' });
  $$('[data-src]', root).forEach(el => TL.io.observe(el));
}
function thumbsPump() {
  while (TL.active.size < 3 && TL.queue.length) {
    const el = TL.queue.shift();
    if (!el.isConnected || !el.dataset.src) continue;
    TL.active.add(el); el.src = el.dataset.src; delete el.dataset.src;
  }
}
function thumbsCancel() {
  TL.io?.disconnect(); TL.io = null; TL.queue = [];
  for (const el of TL.active) { el.dataset.cancelled = '1'; el.removeAttribute('src'); if (el.tagName === 'VIDEO') el.load(); }
  TL.active.clear();
}
function thumbSettled(el, ok) {
  if (el.dataset.cancelled) return false;
  thumbState.set(el.dataset.url, ok ? 'ok' : 'fail');
  if (TL.active.delete(el)) thumbsPump();
  return true;
}

// Google Docs, Sheets and Slides have no size: rclone lists them as the Office files they download as.
const sizeText = f => f.Size >= 0 ? fmt(f.Size) : driveOf(S.sel)?.type === 'drive' ? 'Google file' : '–';
function renderFiles(anim) {
  const c = $('#content'); if (!c) return;
  thumbsCancel();
  c.classList.toggle('enter', anim);
  if (S.listErr) {
    c.innerHTML = `<div class="empty err"><div class="ill">${ico('alert')}</div><h3>Couldn't open this folder</h3><p>${esc(explainError(S.listErr).message)}</p>
      <div class="home-acts"><button class="btn" data-act="retry">${ico('refresh')}Try again</button><button class="btn primary" data-act="reconnect">${ico('link')}Reconnect drive</button></div></div>`;
    return;
  }
  if (!S.list) {
    c.innerHTML = S.view === 'grid'
      ? `<div class="pad"><div class="grid">${'<div class="tile"><div class="frame skel"></div><div class="skel" style="height:12px;width:70%"></div></div>'.repeat(12)}</div></div>`
      : `<div class="pad">${'<div class="lrow"><span class="skel" style="width:34px;height:34px"></span><span class="skel" style="height:12px;width:40%"></span><span></span><span></span><span></span></div>'.repeat(8)}</div>`;
    return;
  }
  const items = S.items = sorted();
  for (const path of S.picked) if (!S.list.some(f => f.Path === path)) S.picked.delete(path);   // gone after a refresh
  if (!S.list.length) {
    c.innerHTML = `<div class="empty"><div class="ill">${ico('folder')}</div><h3>This folder is empty</h3><p>Drop files anywhere here, or upload them from your computer.</p>
      <button class="btn primary" data-act="upload">${ico('upload')}Upload files</button></div>`;
    return;
  }
  if (!items.length) { c.innerHTML = `<div class="empty"><div class="ill">${ico('search')}</div><h3>No matches</h3><p>Nothing in this folder matches “${esc(S.filter)}”.</p></div>`; return; }

  const acts = (f, i) => `<div class="acts">${f.IsDir ? `<button class="icon-btn" data-zip="${i}" title="Download as zip">${ico('download')}</button>`
    : `<a class="icon-btn" href="${rawUrl(S.sel, f.Path)}" download="${esc(f.Name)}" title="Download">${ico('download')}</a>`}<button class="icon-btn" data-fmenu="${i}" title="More" aria-haspopup="menu">${ico('more')}</button></div>`;
  const pickBtn = (f, i) => `<button class="pick" data-pick="${i}" role="checkbox" aria-checked="${S.picked.has(f.Path)}" aria-label="Select ${esc(f.Name)}">${ico('check')}</button>`;
  const sel = f => S.picked.has(f.Path) ? 'sel' : '';
  const clickable = f => ['folder', 'image', 'video', 'audio'].includes(kindOf(f));
  if (S.view === 'grid') {
    c.innerHTML = `<div class="pad"><div class="grid">${items.map((f, i) => {
      const k = kindOf(f), t = thumbHtml(f, i);
      return `<div class="tile ${k === 'folder' ? 'folder' : ''} ${clickable(f) ? 'clickable' : ''} ${sel(f)}" tabindex="0" draggable="true" data-i="${i}" title="${esc(f.Name)}">${pickBtn(f, i)}
        <div class="frame ${t.includes('data-src') ? 'loading' : ''}">${ico(ICON[k])}${t}${k === 'video' ? `<span class="play">${ico('play')}</span>` : ''}</div>
        <div class="name">${esc(f.Name)}</div><div class="sub num">${f.IsDir ? 'Folder' : sizeText(f)}</div>${acts(f, i)}</div>`;
    }).join('')}</div></div>`;
  } else {
    const h = (key, label) => `<button data-sort="${key}" class="${S.sort.key === key ? 'on' : ''} ${S.sort.key === key && S.sort.dir < 0 ? 'desc' : ''}">${label}${ico('chev-d')}</button>`;
    c.innerHTML = `<div class="pad list"><div class="lrow lhead"><span></span><span>${h('name', 'Name')}</span><span class="r">${h('size', 'Size')}</span><span class="r mod">${h('modified', 'Modified')}</span><span></span></div>
      ${items.map((f, i) => {
        const k = kindOf(f), t = thumbHtml(f, i);
        return `<div class="lrow ${clickable(f) ? 'clickable' : ''} ${sel(f)}" tabindex="0" draggable="true" data-i="${i}">
          <span class="lico ${k === 'folder' ? 'folder' : ''}">${ico(ICON[k])}${t}${pickBtn(f, i)}</span>
          <span class="lname" title="${esc(f.Name)}">${esc(f.Name)}</span>
          <span class="r num">${f.IsDir ? '' : sizeText(f)}</span><span class="r mod">${fmtDate(f.ModTime)}</span>${acts(f, i)}</div>`;
      }).join('')}</div>`;
  }
  thumbsWatch(c);
  markPlaying(); paintPicks();
  // Arriving from search or the duplicate finder: show the file.
  const fi = S.focus && S.sel === S.focus.drive ? items.findIndex(f => f.Path === S.focus.path) : -1;
  if (fi >= 0) {
    S.focus = null;
    const el = $(`[data-i="${fi}"]`, c);
    el.scrollIntoView({ block: 'center' }); el.classList.add('found');
    setTimeout(() => el.focus({ preventScroll: true }), 220);   // after a closing dialog has handed focus back
  }
}

// One set of delegated handlers on #main covers the toolbar, home and file views (they are re-rendered often).
const main = $('#main');
main.addEventListener('error', e => { if (e.target.matches?.('img[data-i],video[data-i]') && thumbSettled(e.target, false)) thumbFailed(e.target); }, true);
main.addEventListener('load', e => { if (e.target.matches?.('img[data-i]') && thumbSettled(e.target, true)) thumbReady(e.target); }, true);
main.addEventListener('loadeddata', e => { if (e.target.matches?.('video[data-i]') && thumbSettled(e.target, true)) thumbReady(e.target); }, true);
main.addEventListener('click', e => {
  const t = e.target;
  const act = t.closest('[data-act]')?.dataset.act;
  if (act) return ({
    add: () => addDrive(), auto: () => pickFiles('auto'), upload: () => pickFiles('here'), drawer: toggleDrawer, dupes: () => { location.hash = '#duplicates'; },
    upmenu: () => menu(t.closest('[data-act]'), [
      { icon: 'file', label: 'Upload files', run: () => pickFiles('here') },
      { icon: 'folder', label: 'Upload a folder', hint: 'Keeps its folders inside', run: () => pickFolder('here') },
    ]),
    mkdir: newFolder, dmenu: () => driveMenu(t.closest('[data-act]'), S.sel), retry: () => openDir(S.sel, S.path), reconnect: () => reconnect(S.sel),
    'clear-cache': clearThumbCache,
    'index-on': () => setIndex(true).then(() => { if (S.page === 'duplicates') loadDuplicates(); else if (S.page === 'settings') { renderSettings(false); paintCache(); paintIndex(); } }),
    'index-refresh': () => refreshIndex().then(paintIndex), 'index-clear': clearIndex, 'backup-add': () => editBackup(),
    'sf-export': exportSetup, 'sf-import': importSetup, 'sf-dismiss': dismissImport, 'sf-reconnect': () => reconnect(t.closest('[data-act]').dataset.name),
    'sf-backups': () => { location.hash = '#settings'; setTimeout(() => $('#backupSet')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120); },
    'dup-refresh': () => refreshIndex().then(loadDuplicates), 'dup-delete': deleteDuplicates, 'dup-clear': () => { DUP.picked.clear(); renderDuplicatesKeepScroll(); },
    'google-app': () => googleGuide({ saved: () => { closeModal(); renderSettings(false); paintCache(); } }), 'google-remove': removeGoogleApp,
    setup: () => { location.hash = '#setup'; },
  })[act]?.();
  const sw = t.closest('.switch[data-set]'); if (sw) return toggleSetting(sw);
  const th = t.closest('[data-theme-opt]'); if (th) return setTheme(th.dataset.themeOpt);
  const lo = t.closest('[data-lang-opt]'); if (lo) return lo.dataset.langOpt === LANG ? undefined : setLanguage(lo.dataset.langOpt);
  const open = t.closest('[data-open]'); if (open) return go(open.dataset.open);
  const crumb = t.closest('.crumb[data-p]'); if (crumb) return go(S.sel, crumb.dataset.p);
  const view = t.closest('[data-view]'); if (view) return setView(view.dataset.view);
  const sort = t.closest('[data-sort]'); if (sort) return setSort(sort.dataset.sort);
  const sb = t.closest('[data-sel]'); if (sb) return selAction(sb.dataset.sel);
  const pk = t.closest('[data-pick]'); if (pk) return pick(+pk.dataset.pick, e.shiftKey ? 'range' : 'toggle');
  const fm = t.closest('[data-fmenu]'); if (fm) return fileMenu(fm, S.items[fm.dataset.fmenu]);
  const zp = t.closest('[data-zip]'); if (zp) return downloadZip([S.items[zp.dataset.zip]]);
  if (t.closest('a[download]')) return;
  const item = t.closest('.tile[data-i],.lrow[data-i]'); if (!item) return;
  // While anything is selected, clicks select; otherwise Shift and Cmd/Ctrl start a selection.
  const i = +item.dataset.i;
  if (e.shiftKey) pick(i, 'range'); else if (e.metaKey || e.ctrlKey || S.picked.size) pick(i, 'toggle'); else activate(i);
});
main.addEventListener('mousedown', e => { if (e.shiftKey && e.target.closest('.tile[data-i],.lrow[data-i]')) e.preventDefault(); });   // no text selection
main.addEventListener('contextmenu', e => {
  const item = e.target.closest('.tile[data-i],.lrow[data-i]'); if (!item || e.target.closest('a,input')) return;
  e.preventDefault(); fileMenu($('[data-fmenu]', item), S.items[item.dataset.i]);
});
main.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('.tile[data-i],.lrow[data-i]')) activate(+e.target.dataset.i);
});
function activate(i) {
  const f = S.items[i]; if (!f) return;
  const k = kindOf(f);
  if (k === 'folder') go(S.sel, f.Path);
  else if (previewOf(f)) openViewer(i);
  else if (k === 'audio') playAudio(i);
}
function setView(v) {
  if (S.view === v) return;
  S.view = v; savePrefs();
  const seg = $('.seg', main); seg.dataset.v = v;
  $$('[data-view]', seg).forEach(b => b.setAttribute('aria-pressed', b.dataset.view === v));
  renderFiles(true);
}
function setSort(key) {
  S.sort = S.sort.key === key ? { key, dir: -S.sort.dir } : { key, dir: key === 'name' ? 1 : -1 };
  savePrefs(); renderFiles(false);
}
document.addEventListener('keydown', e => {
  if (e.key === '/' && !e.target.closest('input,textarea,dialog') && $('#q')) { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'Escape') closeMenu();
  // File shortcuts, when the folder is open and nothing else has focus.
  if (S.page !== 'drive' || !S.list || modal.open || !viewer.hidden || e.target.closest('input,textarea,select,[contenteditable]')) return;
  const one = S.picked.size === 1 && S.items.find(f => S.picked.has(f.Path));
  if (e.key === 'Escape' && S.picked.size) { S.picked.clear(); paintPicks(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); S.items.forEach(f => S.picked.add(f.Path)); paintPicks(); }
  else if (e.key === 'F2' && one) { e.preventDefault(); renameItem(one); }
  else if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && S.picked.size) { e.preventDefault(); selAction('delete'); }
});

// ---------- file actions ----------
async function newFolder() {
  const drive = S.sel, p = S.path;
  const v = await dialog({
    title: 'New folder', fields: [{ key: 'name', label: 'Folder name', required: true, placeholder: 'Untitled folder' }], ok: 'Create folder',
    onSubmit: async ({ name }) => {
      if (name.includes('/')) throw new Error('Folder names can’t contain “/”.');
      await rc('operations/mkdir', { fs: drive + ':', remote: (p ? p + '/' : '') + name });
    },
  });
  if (v) { listCache.delete(listKey(drive, p)); touchIndex(drive); }
  if (v) { toast(`Created “${v.name}”`, 'ok'); if (S.sel === drive && S.path === p) reloadList(); }
}
const parentOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const trashNote = drive => { const p = PROVIDERS[driveOf(drive)?.type]; return p?.trash || `${p?.label || 'The cloud'} may keep it in its trash, depending on your settings.`; };

// ---------- selection ----------
// Selected items are kept by path, so they stay selected when the folder re-renders or refreshes.
function pick(i, mode) {
  const f = S.items[i]; if (!f) return;
  if (mode === 'range' && S.anchor != null && S.items[S.anchor]) {
    const [a, b] = [Math.min(S.anchor, i), Math.max(S.anchor, i)];
    for (let k = a; k <= b; k++) S.picked.add(S.items[k].Path);
  } else {
    if (S.picked.has(f.Path)) S.picked.delete(f.Path); else S.picked.add(f.Path);
    S.anchor = i;
  }
  paintPicks();
}
const pickedItems = () => S.items.filter(f => S.picked.has(f.Path));
function paintPicks() {
  const c = $('#content'), bar = $('.selbar', main); if (!c || !bar) return;
  c.classList.toggle('selecting', S.picked.size > 0);
  for (const el of $$('.tile[data-i],.lrow[data-i]', c)) {
    const on = S.picked.has(S.items[el.dataset.i]?.Path);
    el.classList.toggle('sel', on); $('.pick', el)?.setAttribute('aria-checked', on);
  }
  const items = pickedItems(), n = items.length;
  bar.closest('.toolbar').classList.toggle('selecting', n > 0);
  if (!n) { bar.hidden = true; bar.dataset.n = ''; return; }
  const files = items.filter(f => !f.IsDir), size = files.reduce((t, f) => t + Math.max(0, f.Size), 0);
  const dirs = n - files.length, many = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const detail = !dirs ? fmt(size) : !files.length ? many(dirs, 'folder') : `${many(dirs, 'folder')} and ${many(files.length, 'file')} (${fmt(size)})`;
  if (bar.hidden) bar.hidden = false;
  bar.innerHTML = `<button class="icon-btn" data-sel="clear" title="Clear selection (Esc)">${ico('x')}</button>
    <div class="sel-count"><b class="num">${n} selected</b>${detail ? `<span class="num">${esc(detail)}</span>` : ''}</div>
    ${n < S.items.length ? `<button class="btn ghost sel-all" data-sel="all">Select all</button>` : ''}
    <span class="spacer"></span>
    <button class="btn" data-sel="download" title="${n === 1 && !items[0].IsDir ? 'Download' : 'Download as zip'}">${ico('download')}<span>Download</span></button>
    <button class="btn" data-sel="move" title="Move to another folder or drive">${ico('move')}<span>Move</span></button>
    <button class="btn" data-sel="copy" title="Copy to another folder or drive">${ico('copy')}<span>Copy</span></button>
    ${n === 1 ? `<button class="btn" data-sel="share" title="Create a link anyone can open">${ico('link')}<span>Share</span></button>
    <button class="btn" data-sel="rename" title="Rename (F2)">${ico('pencil')}<span>Rename</span></button>` : ''}
    <button class="btn danger-soft" data-sel="delete" title="Delete">${ico('trash')}<span>Delete</span></button>`;
}
function selAction(a) {
  const items = pickedItems();
  if (a === 'clear') { S.picked.clear(); return paintPicks(); }
  if (a === 'all') { S.items.forEach(f => S.picked.add(f.Path)); return paintPicks(); }
  if (!items.length) return;
  if (a === 'download') return items.length === 1 && !items[0].IsDir ? downloadFile(items[0]) : downloadZip(items);
  if (a === 'rename' && items.length === 1) return renameItem(items[0]);
  if (a === 'share' && items.length === 1) return shareLink(items[0]);
  if (a === 'move' || a === 'copy') return transferDialog(a, items);
  if (a === 'delete') return items.length === 1 ? deleteItem(items[0]) : deleteItems(items);
}
function fileMenu(anchor, f) {
  if (!f || !anchor) return;
  menu(anchor, [
    f.IsDir ? { icon: 'download', label: 'Download as zip', run: () => downloadZip([f]) } : { icon: 'download', label: 'Download', run: () => downloadFile(f) },
    { icon: 'link', label: 'Share link…', hint: 'Anyone with the link can open it', run: () => shareLink(f) },
    { icon: 'pencil', label: 'Rename', hint: 'F2', run: () => renameItem(f) },
    { icon: 'move', label: 'Move to…', run: () => transferDialog('move', S.picked.has(f.Path) ? pickedItems() : [f]) },
    { icon: 'copy', label: 'Copy to…', hint: 'Another folder or drive', run: () => transferDialog('copy', S.picked.has(f.Path) ? pickedItems() : [f]) },
    { icon: 'check', label: S.picked.has(f.Path) ? 'Deselect' : 'Select', run: () => pick(S.items.indexOf(f), 'toggle') },
    '-',
    { icon: 'trash', label: 'Delete', danger: true, run: () => deleteItem(f) },
  ]);
}

// ---------- downloads ----------
function downloadFile(f) {
  const a = Object.assign(document.createElement('a'), { href: rawUrl(S.sel, f.Path), download: f.Name });
  document.body.append(a); a.click(); a.remove();
}
// Folders and selections download as one zip, built by DriveDeck as it streams. The form posts into a
// hidden frame: a successful download never loads there, so a page that does load is an error to show.
function downloadZip(items) {
  const name = items.length === 1 ? items[0].Name : `${S.path.split('/').pop() || S.sel} (${items.length} items)`;
  const form = Object.assign(document.createElement('form'), { method: 'POST', action: '/_ui/zip', target: 'dlFrame', hidden: true });
  for (const [k, v] of Object.entries({ fs: S.sel + ':', paths: JSON.stringify(items.map(f => f.Path)), name }))
    form.append(Object.assign(document.createElement('input'), { type: 'hidden', name: k, value: v }));
  document.body.append(form); form.submit(); form.remove();
  toast(`Downloading “${name}.zip”. It’s zipped as it downloads, so the size shows once it’s done.`);
}
$('#dlFrame').addEventListener('load', e => {
  let msg = '';
  try { const t = e.target.contentDocument?.body?.textContent || ''; msg = JSON.parse(t).error || t; } catch (_) {}
  if (msg) toast(`Couldn’t download: ${msg}`, 'err');
});

// ---------- share links ----------
// A public link from the provider (rclone's operations/publiclink): anyone who has it can open the file or
// folder without signing in. Asking again for something already shared gives the same link back.
async function shareLink(f) {
  if (!f) return;
  const drive = S.sel, p = PROVIDERS[driveOf(drive)?.type], label = p?.label || 'the provider';
  const what = f.IsDir ? 'this folder and everything in it' : 'this file';
  const head = modalHead(`Share “${f.Name}”`, null);
  openModal(`${head}<div class="m-body"><div class="share-wait"><span class="spin"></span>Creating a link…</div></div>`, 'sm share');
  let url;
  try { url = (await rc('operations/publiclink', { fs: drive + ':', remote: f.Path })).url; }
  catch (e) {
    if (!modal.open) return;
    openModal(`${head}<div class="m-body"><div class="form-err">${ico('alert')}<span>${/support public links/i.test(e.message) ? `${esc(label)} drives can’t make share links.` : `Couldn’t create a link: ${esc(explainError(e.message).message)}`}</span></div></div>
      <div class="m-foot"><button class="btn primary" data-close autofocus>Close</button></div>`, 'sm share');
    return;
  }
  if (!url || !modal.open) return;
  openModal(`${head}<div class="m-body">
      <div class="share-row"><input class="input num" id="shareUrl" readonly value="${esc(url)}" aria-label="Link">
        <button class="btn primary" id="shareCopy" autofocus>${ico('copy')}<span>Copy link</span></button></div>
      <p class="share-note">${ico('alert')}<span>Anyone with this link can open ${what}, without signing in. Only send it to people you trust.</span></p>
      <div class="form-err" hidden></div></div>
    <div class="m-foot"><button class="btn danger-soft" id="shareStop">Stop sharing</button><button class="btn ghost" data-close style="margin-left:auto">Done</button></div>`, 'sm share');
  const input = $('#shareUrl', modal), copyBtn = $('#shareCopy', modal);
  input.onfocus = () => input.select();
  const copy = async () => {
    // The older copy command still works where the clipboard API is blocked (it needs a click either way).
    try { await navigator.clipboard.writeText(url); }
    catch (_) { input.focus(); input.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (_) {} if (!ok) return false; }
    copyBtn.innerHTML = `${ico('check')}<span>Copied</span>`; copyBtn.classList.add('copied');
    clearTimeout(copyBtn._t); copyBtn._t = setTimeout(() => { copyBtn.innerHTML = `${ico('copy')}<span>Copy link</span>`; copyBtn.classList.remove('copied'); }, 1600);
    return true;
  };
  copyBtn.onclick = () => copy().then(ok => ok || toast('Couldn’t copy. The link is selected: press Cmd/Ctrl+C.', 'err'));
  copy();   // copied straight away where the browser allows it; otherwise the button does it
  $('#shareStop', modal).onclick = async e => {
    const btn = e.currentTarget; busy(btn, true, 'Stopping…'); formError(modal, '');
    try {
      await rc('operations/publiclink', { fs: drive + ':', remote: f.Path, unlink: true });
      closeModal(); toast(`Stopped sharing “${f.Name}”. The link no longer works.`, 'ok');
    } catch (err) {
      busy(btn, false);
      formError(modal, `DriveDeck couldn’t remove the link (${explainError(err.message).message}). Turn off sharing for it on ${label}’s website instead.`);
    }
  };
}

// ---------- rename ----------
async function renameItem(f) {
  if (!f) return;
  const drive = S.sel, dir = parentOf(f.Path);
  const asking = dialog({
    title: `Rename “${f.Name}”`, fields: [{ key: 'name', label: 'New name', required: true, value: f.Name }], ok: 'Rename',
    onSubmit: async ({ name }) => {
      if (name === f.Name) return;
      if (name.includes('/')) throw new Error('Names can’t contain “/”.');
      if (S.list?.some(x => x.Name === name)) throw new Error(`There’s already something called “${name}” in this folder.`);
      const to = (dir ? dir + '/' : '') + name;
      // A folder rename is a server-side move on MEGA and Google Drive, so nothing is copied.
      if (f.IsDir) await rc('sync/move', { srcFs: `${drive}:${f.Path}`, dstFs: `${drive}:${to}`, createEmptySrcDirs: true, deleteEmptySrcDirs: true });
      else await rc('operations/movefile', { srcFs: drive + ':', srcRemote: f.Path, dstFs: drive + ':', dstRemote: to });
    },
  });
  // Select the name without its extension, ready to type over.
  setTimeout(() => { const el = $('#df0', modal), dot = f.IsDir ? -1 : f.Name.lastIndexOf('.'); el?.setSelectionRange(0, dot > 0 ? dot : f.Name.length); }, 60);
  const v = await asking;
  if (!v || v.name === f.Name) return;
  listCache.delete(listKey(drive, dir)); if (f.IsDir) forget(drive, f.Path);
  S.picked.delete(f.Path); touchIndex(drive);
  toast(`Renamed to “${v.name}”`, 'ok');
  if (S.sel === drive && S.path === dir) reloadList();
}

async function deleteItems(items) {
  const drive = S.sel, n = items.length, folders = items.filter(f => f.IsDir).length, failed = [];
  const ok = await dialog({
    title: `Delete ${n} items?`, text: `${folders ? 'Folders are deleted with everything in them. ' : ''}${trashNote(drive)}`, ok: `Delete ${n} items`, danger: true,
    onSubmit: async () => {
      const btn = $('[type=submit]', modal);
      for (const [k, f] of items.entries()) {
        if (btn?.lastChild) btn.lastChild.textContent = `Deleting ${k + 1} of ${n}`;
        try { await rc(f.IsDir ? 'operations/purge' : 'operations/deletefile', { fs: drive + ':', remote: f.Path }); S.picked.delete(f.Path); if (f.IsDir) forget(drive, f.Path); }
        catch (e) { failed.push(`${f.Name}: ${e.message}`); }
      }
    },
  });
  if (!ok) return;
  listCache.delete(listKey(drive, S.path)); touchIndex(drive);
  if (failed.length) toast(`Couldn’t delete ${failed.length} of ${n}. ${failed[0]}`, 'err'); else toast(`Deleted ${n} items`, 'ok');
  if (S.sel === drive) reloadList();
  const dr = driveOf(drive); if (dr) aboutDrive(dr);
}

async function deleteItem(f) {
  if (!f) return;
  const drive = S.sel, trash = trashNote(drive);
  const ok = await dialog({
    title: `Delete “${f.Name}”?`, text: f.IsDir ? `The folder and everything in it will be deleted. ${trash}` : trash,
    ok: 'Delete', danger: true,
    onSubmit: () => rc(f.IsDir ? 'operations/purge' : 'operations/deletefile', { fs: drive + ':', remote: f.Path }),
  });
  if (ok) listCache.delete(listKey(drive, f.Path.split('/').slice(0, -1).join('/')));
  if (ok && f.IsDir) forget(drive, f.Path);
  if (ok) { S.picked.delete(f.Path); touchIndex(drive); }
  if (ok) { toast(`Deleted “${f.Name}”`, 'ok'); if (S.sel === drive) reloadList(); const dr = driveOf(drive); if (dr) aboutDrive(dr); }
}

// ---------- uploads ----------
// Step 1 runs in this tab: each file is sent to DriveDeck on this computer (quick, but needs the tab open).
// Step 2, uploading it to the drive, runs inside DriveDeck and keeps going after the tab is closed.
// The panel merges files this tab is still sending with DriveDeck's list (/_ui/uploads, polled while busy),
// so it also shows uploads started before a reload.
let upMode = 'here';
const UP = { local: [], server: [], files: new Map(), seen: new Map(), sending: false, timer: null, collapsed: false };
const UP_ACTIVE = new Set(['waiting', 'sending', 'queued', 'uploading']);
const newId = () => crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
function pickFiles(mode) { upMode = mode; $('#file').click(); }
function pickFolder(mode) { upMode = mode; $('#folderPick').click(); }
$('#file').onchange = e => { const files = [...e.target.files]; e.target.value = ''; startUpload(files, upMode); };
// A chosen folder arrives as files with their path inside it ("Trip/Day 1/a.jpg").
$('#folderPick').onchange = e => {
  const files = [...e.target.files].map(file => ({ file, dir: parentOf(file.webkitRelativePath || '') }));
  e.target.value = ''; startUpload(files, upMode);
};
// files: Files, or { file, dir } with dir relative to the upload folder. emptyDirs: folders with nothing in them.
async function startUpload(files, mode, emptyDirs = []) {
  if (!files.length && !emptyDirs.length) return;
  let drive = S.sel, p = S.path;
  if (mode === 'auto' || !drive) {
    const best = S.drives.filter(d => !d.err && d.free != null).sort((a, b) => b.free - a.free)[0];
    if (!best) return toast('No drive is available to upload to.', 'err');
    drive = best.name; p = '';
  }
  const need = files.reduce((t, it) => t + (it.file || it).size, 0);
  const to = await roomFor(drive, need);
  if (!to) return;
  if (to !== drive) { drive = to; p = ''; }
  UP.collapsed = false;
  if (emptyDirs.length) {
    await Promise.all(emptyDirs.map(d => rc('operations/mkdir', { fs: drive + ':', remote: [p, d].filter(Boolean).join('/') }).catch(() => {})));
    listCache.delete(listKey(drive, p)); touchIndex(drive); if (!files.length && S.sel === drive && S.path === p) reloadList();
  }
  startUploadTo(files, drive, p);
}
// ---------- low space ----------
const FULL = .9;   // a drive this full (or more) gets a warning
const nearlyFull = d => d && !d.err && d.total > 0 && d.used / d.total >= FULL;
// Bytes already on their way to a drive, which its free space doesn't show yet.
const queuedFor = drive => upItems().filter(u => u.fs === drive + ':' && UP_ACTIVE.has(u.state)).reduce((t, u) => t + Math.max(0, u.size - (u.done || 0)), 0);
// Before an upload bigger than a drive's free space: offer the drive with the most room, upload anyway (its
// numbers can be a little out of date), or cancel. Resolves with the drive to upload to, or null.
function roomFor(drive, need) {
  const dr = driveOf(drive);
  if (!dr || dr.free == null || !need) return Promise.resolve(drive);
  const free = Math.max(0, dr.free - queuedFor(drive));
  if (need <= free) return Promise.resolve(drive);
  const alt = S.drives.filter(d => d.name !== drive && !d.err && d.free != null).map(d => ({ d, room: d.free - queuedFor(d.name) }))
    .sort((a, b) => b.room - a.room)[0];
  const fits = alt && alt.room >= need;
  return new Promise(resolve => {
    let answer = null;
    openModal(`${modalHead(`Not enough space on ${drive}`, null)}<div class="m-body">
        <p class="m-text">${esc(drive)} has <b class="num">${fmt(free)}</b> free${free < dr.free ? ' after the uploads already on their way' : ''}, and this upload is <b class="num">${fmt(need)}</b>. It would stop partway once the drive is full.</p>
        ${fits ? `<p class="m-text">${esc(alt.d.name)} has <b class="num">${fmt(alt.room)}</b> free, enough for all of it. It would go in the top folder of ${esc(alt.d.name)}.</p>`
          : `<p class="m-text">None of your drives has room for all of it. Free up some space, or upload fewer files at a time.</p>`}
      </div>
      <div class="m-foot"><button class="btn ghost" data-room="here" style="margin-right:auto">Upload anyway</button><button class="btn ghost" data-close>Cancel</button>
        ${fits ? `<button class="btn primary" data-room="alt" autofocus>Upload to ${esc(alt.d.name)}</button>` : ''}</div>`, 'sm');
    if (!fits) $('.m-foot [data-close]', modal).setAttribute('autofocus', '');
    $$('[data-room]', modal).forEach(b => b.onclick = () => { answer = b.dataset.room === 'alt' ? alt.d.name : drive; closeModal(); });
    modal.onclose = () => resolve(answer);
  });
}

async function sendNext() {
  if (UP.sending) return;
  UP.sending = true;
  pollUploads();
  for (let it; (it = UP.local.find(x => x.state === 'waiting'));) await sendOne(it);
  UP.sending = false;
}
function sendOne(it) {
  return new Promise(resolve => {
    it.state = 'sending';
    const x = it.xhr = new XMLHttpRequest();
    const q = new URLSearchParams({ id: it.id, fs: it.drive + ':', dir: it.dir, name: it.file.name, size: it.file.size, mtime: it.file.lastModified || 0 });
    x.open('POST', '/_ui/upload?' + q);
    x.upload.onprogress = e => { it.sent = e.loaded; renderUploads(); };
    const done = () => { UP.local.splice(UP.local.indexOf(it), 1); pollUploads(); resolve(); };
    x.onload = () => {
      if (x.status === 401) signedOut();
      if (x.status === 400) { let m = x.statusText; try { m = JSON.parse(x.responseText).error; } catch (_) {} toast(`Couldn't upload “${it.file.name}”: ${m}`, 'err'); }
      done();
    };
    x.onerror = () => { if (!UP.server.some(u => u.id === it.id)) toast(`Couldn't send “${it.file.name}” to DriveDeck. Is it still running?`, 'err'); done(); };
    x.onabort = done;
    x.send(it.file);
    renderUploads();
  });
}
async function pollUploads() {
  clearTimeout(UP.timer);
  try { const r = await api('/_ui/uploads'); if (r.ok) applyUploads((await r.json()).items); } catch (_) {}
  renderUploads();
  if (UP.local.length || UP.server.some(u => UP_ACTIVE.has(u.state))) UP.timer = setTimeout(pollUploads, 1000);
}
// When uploads finish, refresh the folders they went to and, once a drive has nothing left to upload, its usage.
function applyUploads(items) {
  const folders = new Set(), drives = new Set();
  for (const u of items) {
    const before = UP.seen.get(u.id);
    UP.seen.set(u.id, u.state);
    if (u.state === 'done' && (before ? before !== 'done' : UP.files.has(u.id))) {
      folders.add(listKey(u.fs.slice(0, -1), u.dir)); drives.add(u.fs.slice(0, -1)); UP.files.delete(u.id);
      if (u.isDir) forget(u.fs.slice(0, -1), [u.dir, u.name].filter(Boolean).join('/'));
      if (u.kind === 'move') {   // the source folder changed too
        const from = u.srcFs.slice(0, -1);
        folders.add(listKey(from, parentOf(u.srcPath))); drives.add(from);
        if (u.isDir) forget(from, u.srcPath);
      }
    }
  }
  UP.server = items;
  for (const key of folders) { if (S.page === 'drive' && key === listKey(S.sel, S.path)) reloadList(); else listCache.delete(key); }
  for (const d of drives) if (!items.some(u => u.fs === d + ':' && UP_ACTIVE.has(u.state))) { const dr = driveOf(d); if (dr) aboutDrive(dr); }
}
function upItems() {
  const ids = new Set(UP.server.map(u => u.id));
  const items = UP.server.map(u => { const l = UP.local.find(x => x.id === u.id); return l && u.state === 'sending' ? { ...u, sent: l.sent } : u; });
  for (const l of UP.local) if (!ids.has(l.id)) items.push({ id: l.id, fs: l.drive + ':', dir: l.dir, name: l.file.name, size: l.file.size, state: l.state, sent: l.sent, done: 0 });
  return items;
}
const fmtEta = s => s == null || !isFinite(s) ? '' : s < 60 ? `${Math.max(1, Math.round(s))} s left` : s < 3600 ? `${Math.round(s / 60)} min left` : `${(s / 3600).toFixed(1)} h left`;
const VERBS = { upload: ['Uploading', 'Uploaded', 'upload'], copy: ['Copying', 'Copied', 'copy'], move: ['Moving', 'Moved', 'move'] };
function upStatus(u) {
  const p = n => u.size ? Math.min(100, n / u.size * 100) : 100;
  const [doing, did, verb] = VERBS[u.kind || 'upload'], to = u.kind && u.kind !== 'upload' ? ` to ${u.fs.slice(0, -1)}` : '';
  switch (u.state) {
    case 'waiting': return { text: 'Waiting to send', pct: 0, bar: 'sending' };
    case 'sending': return { text: `Sending to DriveDeck, ${Math.floor(p(u.sent))}%`, pct: p(u.sent), bar: 'sending' };
    case 'queued': return { text: `Waiting to ${verb}`, pct: 0, bar: '' };
    case 'uploading': return !u.size ? { text: `${doing}${to}…`, pct: 100, bar: 'sending' }   // a folder whose size isn't known yet
      : { text: [`${doing}${to}, ${Math.floor(p(u.done))}%`, u.speed ? fmt(u.speed) + '/s' : '', fmtEta(u.eta)].filter(Boolean).join(', '), pct: p(u.done), bar: '' };
    case 'done': return { text: did + to, pct: 100, bar: '' };
    case 'cancelled': return { text: 'Cancelled', pct: 0, bar: '' };
    default: return { text: u.error ? `Failed: ${u.error}` : 'Failed', pct: 100, bar: '' };
  }
}
// Rows are keyed by upload id and updated in place, so progress bars animate and buttons keep focus.
function renderUploads() {
  const box = $('#uploads'), items = upItems();
  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  if (box.hidden || !box.firstChild) {
    box.hidden = false;
    box.innerHTML = `<div class="up-head"><span class="up-ico"></span><div class="up-title"><b></b><span></span></div>
      <button class="icon-btn sm" data-up="toggle" title="Collapse">${ico('chev-d')}</button><button class="icon-btn sm" data-up="close" title="Close">${ico('x')}</button>
      <div class="bar up-total"><i></i></div></div><div class="up-list"></div><div class="up-note"></div>`;
  }
  const n = st => items.filter(u => u.state === st).length;
  const active = items.filter(u => UP_ACTIVE.has(u.state)), failed = n('error'), done = n('done'), cancelled = n('cancelled');
  box.classList.toggle('collapsed', UP.collapsed);
  $('[data-up=toggle]', box).title = UP.collapsed ? 'Expand' : 'Collapse';
  $('[data-up=close]', box).hidden = active.length > 0;
  const icon = $('.up-ico', box), iconState = active.length ? 'busy' : failed ? 'err' : 'ok';
  if (icon.dataset.s !== iconState) { icon.dataset.s = iconState; icon.className = 'up-ico ' + iconState; icon.innerHTML = active.length ? '<span class="spin"></span>' : ico(failed ? 'alert' : 'check'); }
  const plural = (k, w) => nOf(k, w, w === 'copy' ? 'copies' : w + 's');
  const kinds = new Set(items.map(u => u.kind || 'upload')), only = kinds.size === 1 ? [...kinds][0] : null, things = only === 'upload' ? 'file' : 'item';
  const activeKinds = new Set(active.map(u => u.kind || 'upload')), ak = activeKinds.size === 1 ? [...activeKinds][0] : null;
  $('.up-title b', box).textContent = active.length ? (ak ? `${VERBS[ak][0]} ${plural(active.length, ak === 'upload' ? 'file' : 'item')}` : `${plural(active.length, 'transfer')} in progress`)
    : failed ? `${plural(failed, only ? VERBS[only][2] : 'transfer')} failed` : done ? (only ? `${plural(done, things)} ${VERBS[only][1].toLowerCase()}` : `${plural(done, 'transfer')} finished`) : 'Cancelled';
  const total = items.reduce((t, u) => t + (u.state === 'cancelled' ? 0 : u.size), 0);
  const moved = items.reduce((t, u) => t + (u.state === 'done' ? u.size : u.state === 'uploading' ? u.done : 0), 0);
  $('.up-title span', box).textContent = active.length ? `${fmt(moved)} of ${fmt(total)}`
    : [done && failed ? `${done} done` : '', cancelled ? `${cancelled} cancelled` : '', done && !failed && !cancelled ? 'All done' : ''].filter(Boolean).join(', ');
  const tot = $('.up-total', box); tot.hidden = !active.length; $('i', tot).style.width = pct(moved, total) + '%';

  const list = $('.up-list', box), keep = new Set();
  for (const u of items) {
    keep.add(u.id);
    let row = list.querySelector(`[data-u="${u.id}"]`);
    const drive = u.fs.slice(0, -1), { color, emoji } = lookOf(drive);
    if (!row) {
      row = document.createElement('div'); row.className = 'up'; row.dataset.u = u.id;
      row.style.setProperty('--c', color);
      row.title = `${u.srcFs ? `From ${u.srcFs.slice(0, -1)} / ${u.srcPath}\n` : ''}To ${drive}${u.dir ? ' / ' + u.dir : ''}`;
      row.innerHTML = `<span class="badge xs" style="--c:${color}">${esc(emoji)}</span><div class="up-main"><b>${esc(u.name)}</b><span class="up-st"></span></div><div class="up-acts"></div><div class="bar"><i></i></div>`;
      list.append(row);
    }
    const st = upStatus(u), canRetry = (u.state === 'error' && u.retry) || (['error', 'cancelled'].includes(u.state) && UP.files.has(u.id));
    const key = u.state + (canRetry ? '+r' : '');
    if (row.dataset.k !== key) {
      row.dataset.k = key; row.className = 'up ' + u.state;
      $('.up-acts', row).innerHTML = UP_ACTIVE.has(u.state) ? `<button class="icon-btn sm" data-up="cancel" title="Cancel">${ico('x')}</button>`
        : canRetry ? `<button class="icon-btn sm" data-up="retry" title="Try again">${ico('refresh')}</button>` : '';
    }
    $('.up-st', row).textContent = st.text;
    $('.up-st', row).title = u.state === 'error' ? st.text : '';
    $('.bar', row).className = 'bar ' + st.bar;
    $('.bar i', row).style.width = st.pct + '%';
  }
  for (const row of [...list.children]) if (!keep.has(row.dataset.u)) row.remove();
  let prev = null;   // keep rows in list order
  for (const u of items) { const row = list.querySelector(`[data-u="${u.id}"]`); if (row.previousElementSibling !== prev) list.insertBefore(row, prev ? prev.nextSibling : list.firstChild); prev = row; }

  // Always say whether it's safe to close the tab.
  const note = $('.up-note', box), sendingHere = UP.local.length > 0, cloud = items.some(u => u.state === 'queued' || u.state === 'uploading');
  const kind = sendingHere ? 'warn' : cloud ? 'safe' : '';
  if (note.dataset.k !== kind) {
    note.dataset.k = kind; note.hidden = !kind; note.className = 'up-note ' + kind;
    note.innerHTML = kind === 'warn' ? `${ico('alert')}<span>Keep this tab open until sending finishes. Closing it stops files that haven’t reached DriveDeck yet.</span><button data-up="learn">How uploads work</button>`
      : kind === 'safe' ? `${ico('check')}<span>You can close this tab. ${items.every(u => (u.kind || 'upload') === 'upload') ? 'Uploads' : 'Transfers'} continue while DriveDeck is running in your terminal.</span><button data-up="learn">How uploads work</button>` : '';
  }
}
async function upPost(id, action) {
  const r = await api(`/_ui/uploads/${id}/${action}`, { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  applyUploads(j.items);
}
$('#uploads').addEventListener('click', async e => {
  const b = e.target.closest('[data-up]'); if (!b) return;
  const id = b.closest('[data-u]')?.dataset.u;
  ({
    toggle: () => { UP.collapsed = !UP.collapsed; renderUploads(); },
    close: async () => {
      await api('/_ui/uploads/clear', { method: 'POST' }).catch(() => {});
      UP.server = UP.server.filter(u => UP_ACTIVE.has(u.state)); UP.files.clear();
      const box = $('#uploads'); box.classList.add('closing');
      setTimeout(() => { box.classList.remove('closing'); renderUploads(); }, 180);
    },
    learn: () => { UP.showHelp = true; if (location.hash === '#settings') route(); else location.hash = '#settings'; },
    cancel: async () => {
      const l = UP.local.find(x => x.id === id);
      if (l?.state === 'waiting') { UP.local.splice(UP.local.indexOf(l), 1); UP.files.delete(id); return renderUploads(); }
      await upPost(id, 'cancel').catch(() => {});
      l?.xhr?.abort();
      pollUploads();
    },
    retry: async () => {
      const s = UP.server.find(u => u.id === id);
      if (s?.retry) { await upPost(id, 'retry').catch(err => toast(err.message, 'err')); return pollUploads(); }
      const file = UP.files.get(id); if (!file || !s) return;
      await upPost(id, 'dismiss').catch(() => {});
      UP.files.delete(id);
      startUploadTo([file], s.fs.slice(0, -1), s.dir);
    },
  })[b.dataset.up]?.();
});
function startUploadTo(files, drive, base) {
  for (const it of files) {
    const file = it.file || it, dir = [base, it.file ? it.dir : ''].filter(Boolean).join('/'), id = newId();
    UP.files.set(id, file); UP.local.push({ id, file, drive, dir, state: 'waiting', sent: 0 });
  }
  if (files.length) { renderUploads(); sendNext(); }
}
// Dropped folders are read entry by entry, keeping each file's path inside them.
async function readDropped(entries) {
  const files = [], empty = [];
  const walk = async (en, dir) => {
    if (en instanceof File) return files.push({ file: en, dir });
    if (en.isFile) return files.push({ file: await new Promise((res, rej) => en.file(res, rej)), dir });
    const path = dir ? dir + '/' + en.name : en.name, reader = en.createReader(), kids = [];
    for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length;) kids.push(...batch);
    if (!kids.length) empty.push(path);
    for (const k of kids) await walk(k, path);
  };
  for (const en of entries) if (en) await walk(en, '');
  return { files, empty };
}
addEventListener('beforeunload', e => { if (UP.local.length) { e.preventDefault(); e.returnValue = ''; } });

// drag & drop onto the main pane
const dropHtml = () => `<div class="drop" id="drop"><div></div></div>`;
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
main.addEventListener('dragenter', e => {
  if (!hasFiles(e) || dragItems || !S.drives.length || !['home', 'drive'].includes(S.page)) return;
  e.preventDefault();
  if (dragDepth++ === 0) {
    const drop = $('#drop'), auto = !S.sel;
    const target = auto ? S.drives.filter(d => !d.err && d.free != null).sort((a, b) => b.free - a.free)[0]?.name : S.sel;
    if (!target) return;
    const { emoji, color } = lookOf(target);
    drop.style.setProperty('--c', color);
    $('div', drop).innerHTML = `<span class="badge" style="--c:${color}">${esc(emoji)}</span>Drop to upload to ${esc(target)}<span>${auto ? 'the drive with the most free space' : esc('/' + S.path)}</span>`;
    drop.classList.add('on');
  }
});
main.addEventListener('dragover', e => { if (hasFiles(e) && !dragItems) e.preventDefault(); });
main.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop')?.classList.remove('on'); } });
main.addEventListener('drop', e => {
  if (!hasFiles(e) || dragItems) return;
  e.preventDefault(); dragDepth = 0; $('#drop')?.classList.remove('on');
  if (!['home', 'drive'].includes(S.page)) return;
  // The entries have to be taken now: the drop's data is gone after the first await.
  const entries = [...e.dataTransfer.items].filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry?.() || i.getAsFile());
  const mode = S.sel ? 'here' : 'auto';
  readDropped(entries).then(({ files, empty }) => startUpload(files, mode, empty))
    .catch(err => toast(`Couldn’t read what was dropped: ${err.message}`, 'err'));
});

// ---------- viewer ----------
// Images, videos, PDFs and text files open here, and the arrows step through every one of them in the folder.
// PDFs use the browser's own PDF reader. Text is fetched (at most the first 2 MB) and shown as plain text with
// line numbers, never as a page, so an HTML file shows its code.
const TEXT_EXT = new Set([...KINDS.code, ...'txt text md markdown rst org log csv tsv json jsonl ndjson geojson yml yaml toml ini conf cfg env properties srt vtt nfo tex bib diff patch mjs cjs vue svelte scss sass less bat cmd ps1 lua pl r dart scala gradle gitignore dockerignore'.split(' ')]);
const TEXT_NAMES = /^(readme|license|licence|changelog|copying|authors|notice|makefile|dockerfile|procfile|gemfile|\.gitignore|\.env|\.editorconfig)$/i;
const PROSE = new Set(['txt', 'text', 'md', 'markdown', 'rst', 'org', 'nfo', 'srt', 'vtt', 'tex', '']);
const TEXT_LIMIT = 2 * 1024 * 1024;
const previewOf = f => {
  if (f.IsDir) return null;
  const k = kindOf(f), x = extOf(f.Name);
  return k === 'image' || k === 'video' ? k : x === 'pdf' ? 'pdf' : TEXT_EXT.has(x) || TEXT_NAMES.test(f.Name) ? 'text' : null;
};
const viewer = $('#viewer');
let vItems = [], vIdx = 0, vAbort = null, vWrap = false;
function openViewer(i) {
  vItems = S.items.filter(previewOf);
  vIdx = Math.max(0, vItems.indexOf(S.items[i]));
  viewer.hidden = false; viewer.classList.remove('closing');
  paintViewer();
}
function closeViewer() {
  if (viewer.hidden) return;
  vAbort?.abort();
  viewer.classList.add('closing');
  setTimeout(() => { viewer.hidden = true; viewer.innerHTML = ''; }, 170);
}
function paintViewer() {
  vAbort?.abort(); vAbort = null;
  const f = vItems[vIdx], k = previewOf(f), raw = rawUrl(S.sel, f.Path), thumb = (k === 'image' || k === 'video') && serverThumbs(k) ? thumbUrl(f, k) : '';
  const stage = k === 'image' ? (thumb ? `<img class="blur" src="${thumb}" alt="">` : '<span class="spin"></span>')
    : k === 'video' ? `<video src="${raw}" controls autoplay playsinline ${thumb ? `poster="${thumb}"` : ''}></video>`
    : k === 'pdf' ? `<iframe class="v-doc" src="${raw}" title="${esc(f.Name)}"></iframe>`
    : `<div class="v-text"><span class="spin"></span></div>`;
  viewer.innerHTML = `<div class="v-bar"><b>${esc(f.Name)}</b><span class="num">${fmt(f.Size)}</span><span class="num">${vIdx + 1} of ${vItems.length}</span>
      ${k === 'text' ? `<button class="icon-btn" data-vwrap title="Wrap long lines" aria-pressed="false">${ico('wrap')}</button>` : ''}
      ${k === 'pdf' ? `<a class="icon-btn" href="${raw}" target="_blank" rel="noopener" title="Open in a new tab">${ico('external')}</a>` : ''}
      <a class="icon-btn" href="${raw}" download="${esc(f.Name)}" title="Download">${ico('download')}</a><button class="icon-btn" data-vclose title="Close">${ico('x')}</button></div>
    <div class="v-stage ${k === 'pdf' || k === 'text' ? 'doc' : ''}">${stage}
      ${vItems.length > 1 ? `<button class="icon-btn v-nav prev" data-vstep="-1" title="Previous (←)">${ico('chev-l')}</button><button class="icon-btn v-nav next" data-vstep="1" title="Next (→)">${ico('chev-r')}</button>` : ''}</div>`;
  if (k === 'image') {
    const full = new Image(); full.alt = f.Name;
    full.onload = () => { if (vItems[vIdx] !== f) return; const st = $('.v-stage', viewer); $('img.blur, .spin', st)?.remove(); st.prepend(full); };
    full.onerror = () => { const b = $('img.blur', viewer); if (b) b.classList.remove('blur'); else $('.v-stage .spin', viewer)?.replaceWith(Object.assign(document.createElement('p'), { textContent: 'This image can’t be shown in the browser. Download it to view.' })); };
    full.src = raw;
  } else if (k === 'video') {
    $('video', viewer).onerror = () => toast('This video format can’t play in the browser. Download it to watch.', 'err');
    $('video', viewer).onplay = () => P.el.pause();   // one thing playing at a time
  } else if (k === 'text') { setWrap(PROSE.has(extOf(f.Name))); showText(f, raw); }
}
// Reads up to TEXT_LIMIT bytes: a range request where rclone supports it, and the reading stops there anyway.
async function showText(f, raw) {
  const ctl = vAbort = new AbortController(), box = $('.v-text', viewer);
  const say = msg => { if (vAbort === ctl) box.innerHTML = `<p class="v-msg">${esc(msg)}</p>`; };
  try {
    const r = await api(raw, { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` }, signal: ctl.signal });
    if (!r.ok) throw new Error(r.status === 404 ? 'It’s no longer there.' : `${r.status} ${r.statusText}`);
    const total = Number(/\/(\d+)$/.exec(r.headers.get('content-range') || '')?.[1]) || Math.max(f.Size, 0);
    const reader = r.body.getReader(), parts = []; let got = 0;
    while (got < TEXT_LIMIT) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; }
    reader.cancel().catch(() => {});
    let bytes = new Uint8Array(got), at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; }
    const cut = total > TEXT_LIMIT || got > TEXT_LIMIT;
    if (got > TEXT_LIMIT) bytes = bytes.subarray(0, TEXT_LIMIT);
    if (vAbort !== ctl) return;
    if (!bytes.length) return say('This file is empty.');
    if (bytes.subarray(0, 8000).includes(0)) return say('This file doesn’t look like text, so it can’t be shown here. Download it to open it.');
    if (cut) { const nl = bytes.lastIndexOf(10); if (nl > 0) bytes = bytes.subarray(0, nl); }   // never ends mid-line or mid-character
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { text = new TextDecoder('windows-1252').decode(bytes); }
    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    let note = cut ? `Showing the first ${fmt(TEXT_LIMIT)} of ${fmt(total)}. Download the file to see all of it.` : '';
    if (extOf(f.Name) === 'json' && !cut && text.length > 200 && !text.trim().includes('\n')) {
      try { text = JSON.stringify(JSON.parse(text), null, 2); note = 'Spaced out for reading. The file itself is on one line.'; } catch (_) {}
    }
    const lines = text.replace(/\n$/, '').split('\n');
    box.style.setProperty('--gut', String(lines.length).length + 'ch');
    box.innerHTML = `${note ? `<div class="v-note">${esc(note)}</div>` : ''}<pre class="v-code" tabindex="0">${lines.map(l => `<i>${esc(l)}</i>`).join('')}</pre>`;
  } catch (e) { if (e.name !== 'AbortError') say(`Couldn’t open this file: ${e.message}`); }
}
function setWrap(on) {
  vWrap = on;
  $('.v-text', viewer)?.classList.toggle('wrap', on);
  $('[data-vwrap]', viewer)?.setAttribute('aria-pressed', on);
}
viewer.addEventListener('click', e => {
  if (e.target.closest('[data-vclose]') || e.target.classList.contains('v-stage')) return closeViewer();
  const s = e.target.closest('[data-vstep]'); if (s) step(+s.dataset.vstep);
  if (e.target.closest('[data-vwrap]')) setWrap(!vWrap);
});
const step = d => { vIdx = (vIdx + d + vItems.length) % vItems.length; paintViewer(); };
// Swipe left or right for the next or previous file (phones hide the arrows over PDFs and text). Not over
// unwrapped text, where a sideways swipe scrolls the long lines.
let swipe = null;
viewer.addEventListener('touchstart', e => {
  const t = e.touches[0];
  swipe = e.touches.length === 1 && vItems.length > 1 && !(e.target.closest('.v-code') && !vWrap) && !e.target.closest('video') ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
viewer.addEventListener('touchend', e => {
  if (!swipe) return;
  const t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y; swipe = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
}, { passive: true });
document.addEventListener('keydown', e => {
  if (viewer.hidden) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
  // Select all picks just the text being read, not the whole page.
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && $('.v-code', viewer)) { e.preventDefault(); getSelection().selectAllChildren($('.v-code', viewer)); }
});

// ---------- audio player ----------
// A player bar that stays while you browse. Its queue is the audio files of the folder a track was started
// from, in the order shown there. The browser plays common formats straight from rclone; the rest are
// converted by ffmpeg on DriveDeck (/_ui/audio/stream), which also takes over when a direct play fails
// (ALAC inside .m4a, for example). Converted streams have no length of their own, so the length comes from
// /_ui/audio and seeking restarts the conversion at the new point.
const AUDIO_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus', weba: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff', caf: 'audio/x-caf' };
const P = { el: new Audio(), queue: [], idx: -1, drive: null, info: null, offset: 0, converted: false, duration: null, error: null, dragging: false };
const player = $('#player');
const audioQs = (drive, f) => `fs=${enc(drive + ':')}&path=${enc(f.Path)}`;
const canDirect = f => { const t = AUDIO_TYPES[extOf(f.Name)]; return !!t && P.el.canPlayType(t) !== ''; };
const track = () => P.queue[P.idx];
const nowPos = () => P.offset + (P.el.currentTime || 0);
const coverUrl = f => `/_ui/thumb?${audioQs(P.drive, f)}&kind=audio&id=${enc(f.ID || '')}&v=${enc(f.ModTime + '|' + f.Size)}`;
const fmtTime = s => {
  if (s == null || !isFinite(s)) return '–:––';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};

function playAudio(i) {
  const f = S.items[i];
  if (track() && P.drive === S.sel && track().Path === f.Path) return togglePlay();
  P.queue = S.items.filter(x => kindOf(x) === 'audio'); P.drive = S.sel;
  startTrack(P.queue.indexOf(f));
}
async function startTrack(idx, converted = null) {
  const f = P.queue[idx]; if (!f) return;
  const again = P.idx === idx;
  Object.assign(P, { idx, offset: 0, error: null, converted: converted ?? !canDirect(f) });
  if (!again) Object.assign(P, { info: null, duration: null });
  const fresh = player.hidden;
  if (P.converted && !S.features.ffmpeg) {
    P.el.pause(); P.el.removeAttribute('src'); P.el.load();
    P.error = 'This format needs ffmpeg to play. You can install it from Settings, under Set up tools.';
  } else { setSrc(0); P.el.play().catch(() => {}); }
  paintPlayer(fresh); markPlaying();
  if (!again && S.features.ffmpeg) {
    try {
      const r = await api(`/_ui/audio?${audioQs(P.drive, f)}`);
      if (r.ok && track() === f) { P.info = await r.json(); if (P.duration == null || P.converted) P.duration = P.info.duration; paintPlayer(); }
    } catch (_) {}
  }
}
function setSrc(t) {
  const f = track();
  P.offset = P.converted ? t : 0;
  P.el.src = P.converted ? `/_ui/audio/stream?${audioQs(P.drive, f)}${t ? '&t=' + t.toFixed(2) : ''}` : rawUrl(P.drive, f.Path);
  if (!P.converted && t) P.el.currentTime = t;
}
function seekTo(t) {
  if (!(P.duration > 0) || !track()) return;
  t = Math.max(0, Math.min(t, P.duration - 0.25));
  if (P.converted) { setSrc(t); P.el.play().catch(() => {}); } else P.el.currentTime = t;
  paintTime();
}
function togglePlay() {
  if (!track() || P.error) return;
  if (P.el.paused) { if (P.el.ended) seekTo(0); P.el.play().catch(() => {}); } else P.el.pause();
}
function skip(d) {
  if (d < 0 && nowPos() > 3) return seekTo(0);
  const i = P.idx + d;
  if (i >= 0 && i < P.queue.length) startTrack(i);
}
function closePlayer() {
  P.el.pause(); P.el.removeAttribute('src'); P.el.load();
  Object.assign(P, { queue: [], idx: -1, info: null, error: null });
  document.body.classList.remove('has-player', 'audio-paused');
  player.classList.add('closing');
  setTimeout(() => { if (!track()) { player.hidden = true; player.classList.remove('closing'); } }, 180);
  markPlaying();
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
}

function paintPlayer(fresh) {
  const f = track(); if (!f) return;
  const { color, emoji } = lookOf(P.drive);
  if (fresh || !$('.pl-meta', player)) {
    player.innerHTML = `<div class="pl-art"><span>${esc(emoji)}</span><img alt="" hidden></div>
      <div class="pl-meta"><b class="pl-title"></b><span class="pl-sub"></span></div>
      <div class="pl-ctrls">
        <button class="icon-btn" data-pl="prev" title="Previous">${ico('prev')}</button>
        <button class="pl-play" data-pl="toggle" title="Play">${ico('play')}<span class="spin"></span></button>
        <button class="icon-btn" data-pl="next" title="Next">${ico('next')}</button>
        <button class="icon-btn pl-close" data-pl="close" title="Close player">${ico('x')}</button>
      </div>
      <div class="pl-seek"><span class="num pl-cur">0:00</span><input type="range" min="0" max="1000" value="0" aria-label="Position in track"><span class="num pl-dur">–:––</span></div>`;
    player.hidden = false; player.classList.remove('closing');
    document.body.classList.add('has-player');
  }
  accent(player, color);
  const title = P.info?.title || f.Name.replace(/\.[^.]+$/, ''), sub = P.error || P.info?.artist || P.info?.album || `${P.drive}, ${P.idx + 1} of ${P.queue.length}`;
  $('.pl-title', player).textContent = title; $('.pl-title', player).title = f.Name;
  const subEl = $('.pl-sub', player); subEl.textContent = sub; subEl.classList.toggle('err', !!P.error);
  $('.pl-art > span', player).textContent = emoji;
  const img = $('.pl-art img', player), cover = P.info?.cover ? coverUrl(f) : '';
  if (img.dataset.src !== cover) {
    img.hidden = true; img.dataset.src = cover;
    if (cover) { img.onload = () => { if (img.dataset.src === cover) img.hidden = false; }; img.src = cover; } else img.removeAttribute('src');
  }
  $('[data-pl=prev]', player).disabled = P.idx === 0 && P.duration == null;
  $('[data-pl=next]', player).disabled = P.idx >= P.queue.length - 1;
  paintState(); paintTime(); mediaSession();
}
function paintState() {
  if (player.hidden) return;
  const playing = !P.el.paused && !P.error;
  const btn = $('.pl-play', player);
  $('use', btn).setAttribute('href', playing ? '#i-pause' : '#i-play');
  btn.title = playing ? 'Pause' : 'Play'; btn.disabled = !!P.error;
  document.body.classList.toggle('audio-paused', !playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}
function paintTime() {
  if (player.hidden || !track()) return;
  const cur = nowPos(), d = P.duration, r = $('.pl-seek input', player);
  r.disabled = !(d > 0) || !!P.error;
  if (!P.dragging) {
    const v = d > 0 ? Math.min(1000, cur / d * 1000) : 0;
    r.value = v; r.style.setProperty('--p', v / 10 + '%');
    $('.pl-cur', player).textContent = fmtTime(cur);
  }
  $('.pl-dur', player).textContent = fmtTime(d);
}
function mediaSession() {
  const f = track(); if (!f || !('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: P.info?.title || f.Name.replace(/\.[^.]+$/, ''), artist: P.info?.artist || P.drive, album: P.info?.album || '',
    artwork: P.info?.cover ? [{ src: coverUrl(f), sizes: '720x720', type: 'image/jpeg' }] : [],
  });
}
if ('mediaSession' in navigator) {
  const on = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (_) {} };
  on('play', togglePlay); on('pause', togglePlay);
  on('previoustrack', () => skip(-1)); on('nexttrack', () => skip(1));
  on('seekto', e => seekTo(e.seekTime));
}

// The file playing in the open folder gets moving bars in place of its icon.
function markPlaying() {
  $$('.eq', main).forEach(el => { el.parentElement.classList.remove('playing'); el.remove(); });
  const f = track(); if (!f || S.page !== 'drive' || S.sel !== P.drive || !S.items) return;
  const i = S.items.findIndex(x => x.Path === f.Path); if (i < 0) return;
  const box = $(`.tile[data-i="${i}"] .frame, .lrow[data-i="${i}"] .lico`, main); if (!box) return;
  box.classList.add('playing'); box.insertAdjacentHTML('beforeend', '<span class="eq"><i></i><i></i><i></i></span>');
}

const A = P.el;
A.addEventListener('loadedmetadata', () => { if (!P.converted && isFinite(A.duration)) { P.duration = A.duration; paintTime(); } });
A.addEventListener('timeupdate', paintTime);
A.addEventListener('play', paintState);
A.addEventListener('pause', paintState);
A.addEventListener('waiting', () => player.classList.add('buffering'));
for (const ev of ['playing', 'pause', 'canplay', 'error']) A.addEventListener(ev, () => player.classList.remove('buffering'));
A.addEventListener('ended', () => { if (P.idx < P.queue.length - 1) skip(1); else paintState(); });
A.addEventListener('error', () => {
  if (!track() || !A.getAttribute('src')) return;
  // The browser claimed it could play this but couldn't: let ffmpeg convert it instead.
  if (!P.converted && S.features.ffmpeg) return startTrack(P.idx, true);
  P.error = P.converted ? 'Couldn’t play this file. It may be damaged, or in a format ffmpeg can’t read.' : 'Your browser can’t play this format. Install ffmpeg (Settings, Set up tools) to play it.';
  paintPlayer(); paintState();
});
player.addEventListener('click', e => {
  const b = e.target.closest('[data-pl]'); if (!b) return;
  ({ prev: () => skip(-1), next: () => skip(1), toggle: togglePlay, close: closePlayer })[b.dataset.pl]();
});
player.addEventListener('input', e => {
  if (!e.target.matches('.pl-seek input')) return;
  P.dragging = true;
  e.target.style.setProperty('--p', e.target.value / 10 + '%');
  $('.pl-cur', player).textContent = fmtTime(e.target.value / 1000 * P.duration);
});
player.addEventListener('change', e => {
  if (!e.target.matches('.pl-seek input')) return;
  P.dragging = false; seekTo(e.target.value / 1000 * P.duration);
});
document.addEventListener('keydown', e => {
  if (e.key !== ' ' || !track() || !viewer.hidden || modal.open || e.target.closest('input,textarea,select,button,a,[contenteditable]')) return;
  e.preventDefault(); togglePlay();
});

// ---------- move and copy ----------
// The picker chooses a drive and folder. Within one drive the provider moves or copies on its side; between
// drives rclone streams the files through this computer. Both run in the transfers queue, so they show in
// the same panel as uploads and carry on after the tab is closed.
const touchIndex = drive => api('/_ui/index/touch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drive }) }).catch(() => {});
const nOf = (k, w, many = w + 's') => `${k} ${k === 1 ? w : many}`;
const whatOf = items => items.length === 1 ? `“${items[0].Name}”` : nOf(items.length, 'item');
// "Photo.jpg" -> "Photo (2).jpg", the first name not in taken (which it's added to).
function freeName(name, taken, isDir) {
  const dot = isDir ? -1 : name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let n = 2, out;
  while (taken.has(out = `${base} (${n})${ext}`)) n++;
  taken.add(out); return out;
}

function transferDialog(kind, items, at = {}) {
  if (!items?.length) return;
  const src = S.sel, srcDir = S.path;
  const st = { kind, drive: at.drive || src, path: at.path ?? (at.drive && at.drive !== src ? '' : srcDir), dirs: null, making: false };
  const cache = new Map();
  // A folder can't go inside itself, and a move into the folder it's already in does nothing.
  const inside = (drive, p) => drive === src && items.some(f => f.IsDir && (p === f.Path || p.startsWith(f.Path + '/')));
  const why = () => inside(st.drive, st.path) ? 'A folder can’t go inside itself.' : st.kind === 'move' && st.drive === src && st.path === srcDir ? 'The items are already in this folder.' : '';
  openModal(`<div class="m-head"><div><h2 class="pk-title"></h2><p class="pk-sub"></p></div>
      <div class="seg text pk-kind" role="radiogroup" aria-label="Move or copy" style="--n:2"><button role="radio" data-kind="move">Move</button><button role="radio" data-kind="copy">Copy</button></div>
      <button class="icon-btn" data-close title="Close">${ico('x')}</button></div>
    <div class="m-body pk">
      <div class="pk-drives">${S.drives.map(d => { const { color, emoji } = lookOf(d.name); return `<button class="pk-drive" data-drive="${esc(d.name)}" style="--c:${color}"><span class="badge xs" style="--c:${color}">${esc(emoji)}</span><span><b>${esc(d.name)}</b><small class="num">${d.free != null ? fmt(d.free) + ' free' : PROVIDERS[d.type]?.label || ''}</small></span></button>`; }).join('')}</div>
      <div class="pk-crumbs"></div>
      <div class="pk-list"></div>
      <div class="form-err" hidden></div>
    </div>
    <div class="m-foot"><span class="left pk-note"></span><button class="btn ghost" data-pk="mkdir">${ico('folder-plus')}New folder</button><button class="btn primary" data-pk="go" autofocus></button></div>`, 'picker');
  const root = $('.pk', modal);
  const paint = () => {
    const kindWord = st.kind === 'move' ? 'Move' : 'Copy', same = st.drive === src, dest = driveOf(st.drive);
    $('.pk-title', modal).textContent = `${kindWord} ${whatOf(items)}`;
    $('.pk-sub', modal).textContent = `From ${src}${srcDir ? ' / ' + srcDir : ''}`;
    const seg = $('.pk-kind', modal); seg.style.setProperty('--i', st.kind === 'move' ? 0 : 1);
    $$('[data-kind]', seg).forEach(b => b.setAttribute('aria-checked', b.dataset.kind === st.kind));
    $$('.pk-drive', root).forEach(b => b.setAttribute('aria-pressed', b.dataset.drive === st.drive));
    accent(modal, lookOf(st.drive).color);
    const parts = st.path ? st.path.split('/') : [];
    $('.pk-crumbs', root).innerHTML = `<button data-pkpath="">${esc(st.drive)}</button>` + parts.map((x, i) => `${ico('chev-r')}<button data-pkpath="${esc(parts.slice(0, i + 1).join('/'))}">${esc(x)}</button>`).join('');
    const list = $('.pk-list', root);
    list.innerHTML = (st.making ? `<form class="pk-new"><span class="pk-ico">${ico('folder-plus')}</span><input class="input" placeholder="New folder name" maxlength="255"><button class="btn sm primary">Create</button></form>` : '')
      + (!st.dirs ? '<div class="pk-row skel"></div>'.repeat(4)
        : !st.dirs.length ? `<p class="pk-empty">No folders here. You can ${st.kind} into this folder, or create a new one.</p>`
        : st.dirs.map(d => { const no = inside(st.drive, d.Path); return `<button class="pk-row" data-pkpath="${esc(d.Path)}" ${no ? 'disabled title="A folder can’t go inside itself."' : ''}><span class="pk-ico">${ico('folder')}</span><span>${esc(d.Name)}</span>${ico('chev-r')}</button>`; }).join(''));
    if (st.making) { const f = $('.pk-new', list), input = $('input', f); input.focus(); f.onsubmit = e => { e.preventDefault(); makeFolder(input.value.trim()); }; input.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); st.making = false; paint(); } }; }
    $('.pk-note', modal).textContent = same ? `Happens on ${PROVIDERS[dest?.type]?.label || 'the drive'}’s side, so nothing is downloaded.`
      : `Files are downloaded to this computer and uploaded to ${st.drive}, so this uses your internet both ways.`;
    const go = $('[data-pk=go]', modal), reason = why();
    go.innerHTML = `${ico(st.kind === 'move' ? 'move' : 'copy')}${kindWord} here`; go.disabled = !!reason; go.title = reason;
  };
  const load = async () => {
    const key = st.drive + '\0' + st.path, want = key;
    st.dirs = cache.get(key) || null; paint();
    if (st.dirs) return;
    try {
      const l = (await rc('operations/list', { fs: st.drive + ':', remote: st.path, opt: { dirsOnly: true } })).list;
      l.sort((a, b) => a.Name.localeCompare(b.Name, undefined, { numeric: true, sensitivity: 'base' }));
      cache.set(key, l);
      if (want === st.drive + '\0' + st.path) { st.dirs = l; paint(); }
    } catch (e) { formError(root, e.message); st.dirs = []; paint(); }
  };
  const makeFolder = async name => {
    if (!name) return;
    if (name.includes('/')) return formError(root, 'Folder names can’t contain “/”.');
    try {
      const p = (st.path ? st.path + '/' : '') + name;
      await rc('operations/mkdir', { fs: st.drive + ':', remote: p });
      cache.delete(st.drive + '\0' + st.path); listCache.delete(listKey(st.drive, st.path)); touchIndex(st.drive);
      Object.assign(st, { making: false, path: p }); formError(root, ''); load();
    } catch (e) { formError(root, e.message); }
  };
  // Asks what to do with items whose names are already taken: 'skip', 'both', 'replace', or null to go back.
  const askClash = clash => new Promise(resolve => {
    const list = $('.pk-list', root), dirs = clash.some(f => f.IsDir);
    list.innerHTML = `<div class="pk-clash">${ico('alert')}<div><b>${clash.length === 1 ? `“${esc(clash[0].Name)}” is already in this folder.` : `${clash.length} items with the same names are already in this folder.`}</b>
      <p>${clash.length > 1 ? esc(clash.slice(0, 4).map(f => f.Name).join(', ') + (clash.length > 4 ? ', …' : '')) + '. ' : ''}What should happen to ${clash.length === 1 ? 'it' : 'them'}?</p>
      <div class="pk-clash-acts"><button class="btn" data-c="skip">Skip ${clash.length === 1 ? 'it' : 'them'}</button><button class="btn" data-c="both">Keep both</button><button class="btn danger-soft" data-c="replace" title="${dirs ? 'Folders are merged: files with the same names are replaced' : ''}">${dirs ? 'Merge and replace' : 'Replace'}</button><button class="btn ghost" data-c="back">Back</button></div></div></div>`;
    list.onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; list.onclick = null; resolve(b.dataset.c === 'back' ? null : b.dataset.c); };
  });
  const start = async () => {
    const btn = $('[data-pk=go]', modal), same = st.drive === src, dest = driveOf(st.drive);
    formError(root, ''); busy(btn, true, 'Checking…');
    try {
      // Does it fit? A move within one drive takes no extra space.
      if (!(st.kind === 'move' && same) && dest?.free != null) {
        let need = 0;
        for (const f of items) need += f.IsDir ? (await rc('operations/size', { fs: `${src}:${f.Path}` })).bytes : Math.max(0, f.Size);
        if (need > dest.free) throw new Error(`Not enough space on ${st.drive}: this needs ${fmt(need)}, and it has ${fmt(dest.free)} free.`);
      }
      const taken = new Set((await rc('operations/list', { fs: st.drive + ':', remote: st.path })).list.map(f => f.Name));
      const clash = items.filter(f => taken.has(f.Name));
      let plan = items.map(f => [f, f.Name]);
      if (clash.length) {
        busy(btn, false);
        const choice = await askClash(clash);
        if (!choice) return paint();
        if (choice === 'skip') plan = plan.filter(([f]) => !taken.has(f.Name));
        if (choice === 'both') plan = plan.map(([f, n]) => [f, taken.has(n) ? freeName(n, taken, f.IsDir) : n]);
        busy(btn, true, 'Starting…');
      }
      if (!plan.length) { closeModal(); return toast('Nothing to do: every item is already there.'); }
      const r = await api('/_ui/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: st.kind, fs: st.drive + ':', dir: st.path, items: plan.map(([f, name]) => ({ srcFs: src + ':', srcPath: f.Path, isDir: f.IsDir, size: Math.max(0, f.Size), name })) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      UP.collapsed = false; applyUploads(j.items); pollUploads();
      S.picked.clear(); paintPicks();
      closeModal();
      toast(`${st.kind === 'move' ? 'Moving' : 'Copying'} ${whatOf(plan.map(([f]) => f))} to ${st.drive}${st.path ? ' / ' + st.path : ''}`);
    } catch (e) { busy(btn, false); paint(); formError(root, e.message); }
  };
  modal.addEventListener('click', e => {
    const t = e.target;
    const k = t.closest('[data-kind]'); if (k) { st.kind = k.dataset.kind; return paint(); }
    const d = t.closest('[data-drive]'); if (d && d.closest('.pk-drives')) { Object.assign(st, { drive: d.dataset.drive, path: '', making: false }); return load(); }
    const p = t.closest('[data-pkpath]'); if (p && !p.disabled) { Object.assign(st, { path: p.dataset.pkpath, making: false }); return load(); }
    const a = t.closest('[data-pk]')?.dataset.pk;
    if (a === 'mkdir') { st.making = !st.making; paint(); }
    else if (a === 'go') start();
  });
  load();
  $(`.pk-drive[data-drive="${CSS.escape(st.drive)}"]`, root)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Dragging files: onto a folder in this view, or onto a drive in the sidebar, opens the picker there.
let dragItems = null;
const dragTargets = () => $$('.drop-target').forEach(el => el.classList.remove('drop-target'));
main.addEventListener('dragstart', e => {
  const el = e.target.closest?.('.tile[data-i],.lrow[data-i]'); if (!el) return;
  const f = S.items[el.dataset.i];
  dragItems = S.picked.has(f.Path) ? pickedItems() : [f];
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('application/x-drivedeck', String(dragItems.length));
  const ghost = Object.assign(document.createElement('div'), { className: 'drag-ghost', textContent: dragItems.length === 1 ? f.Name : `${dragItems.length} items` });
  document.body.append(ghost); e.dataTransfer.setDragImage(ghost, 18, 18); setTimeout(() => ghost.remove());
});
main.addEventListener('dragend', () => { dragItems = null; dragTargets(); });
const folderUnder = e => { const el = e.target.closest?.('.tile[data-i],.lrow[data-i]'), f = el && S.items[el.dataset.i]; return f?.IsDir && !dragItems.includes(f) ? { el, f } : null; };
main.addEventListener('dragover', e => {
  if (!dragItems) return;
  const hit = folderUnder(e); dragTargets();
  if (hit) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; hit.el.classList.add('drop-target'); }
});
main.addEventListener('drop', e => {
  if (!dragItems) return;
  const hit = folderUnder(e), items = dragItems; dragTargets(); dragItems = null;
  if (hit) { e.preventDefault(); transferDialog('move', items, { drive: S.sel, path: hit.f.Path }); }
});
$('#drives').addEventListener('dragover', e => {
  const d = dragItems && e.target.closest('[data-drive]'); if (!d) return;
  e.preventDefault(); e.dataTransfer.dropEffect = d.dataset.drive === S.sel ? 'move' : 'copy';
  dragTargets(); d.classList.add('drop-target');
});
$('#drives').addEventListener('dragleave', e => { const d = e.target.closest('[data-drive]'); if (d && !d.contains(e.relatedTarget)) d.classList.remove('drop-target'); });
$('#drives').addEventListener('drop', e => {
  const d = dragItems && e.target.closest('[data-drive]'); if (!d) return;
  e.preventDefault(); const items = dragItems; dragItems = null; dragTargets();
  transferDialog(d.dataset.drive === S.sel ? 'move' : 'copy', items, { drive: d.dataset.drive, path: '' });
});

// ---------- search ----------
// Search covers every drive through DriveDeck's index (lib/search.js), so results appear as you type.
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$('#bSearch kbd').textContent = isMac ? '⌘K' : 'Ctrl K';
$('#bSearch').onclick = () => openSearch();
const SR = { q: '', results: [], total: 0, status: [], sel: 0, timer: null, poll: null };
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const indexOn = () => S.cfg.prefs.index !== false;
function openSearch() {
  closeDrawer();
  openModal(`<div class="sr-head">${ico('search')}<input id="srIn" type="text" placeholder="Search all drives" autocomplete="off" spellcheck="false" aria-label="Search all drives"><kbd>Esc</kbd></div><div class="sr-body" id="srBody"></div><div class="sr-foot" id="srFoot"></div>`, 'palette');
  const input = $('#srIn', modal);
  input.value = SR.q; setTimeout(() => { input.focus(); input.select(); }, 20);
  input.oninput = () => { SR.q = input.value; clearTimeout(SR.timer); SR.timer = setTimeout(runSearch, 110); };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); SR.sel = Math.max(0, Math.min(SR.results.length - 1, SR.sel + (e.key === 'ArrowDown' ? 1 : -1))); paintSearchSel(true); }
    else if (e.key === 'Enter' && SR.results[SR.sel]) openResult(SR.results[SR.sel]);
  };
  modal.onclose = () => { clearTimeout(SR.poll); clearTimeout(SR.timer); };
  runSearch();
}
async function runSearch() {
  clearTimeout(SR.poll);
  let j = { results: [], total: 0, status: [] };
  try { const r = await api('/_ui/search?q=' + enc(SR.q.trim())); if (r.ok) j = await r.json(); } catch (_) {}
  if (!modal.open || !modal.classList.contains('palette')) return;
  Object.assign(SR, { results: j.results, total: j.total, status: j.status, sel: 0 });
  paintSearch();
  if (j.status.some(s => s.building)) SR.poll = setTimeout(runSearch, 1500);
}
// Wraps the matched words of a name in <mark>. Accents are ignored, as in the search itself ("cafe" marks "Café").
const foldChar = ch => { const f = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); return f.length === 1 ? f : ch.toLowerCase(); };
function marked(name, q) {
  const low = [...name].map(foldChar).join(''), on = new Array(name.length).fill(false);
  if (low.length !== name.length) return esc(name);   // a letter changed length when folded: don't risk marking the wrong part
  for (const w of [...q].map(foldChar).join('').split(/\s+/).filter(Boolean)) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) for (let k = i; k < i + w.length; k++) on[k] = true;
  let out = '', open = false;
  for (let i = 0; i < name.length; i++) { if (on[i] !== open) { out += on[i] ? '<mark>' : '</mark>'; open = on[i]; } out += esc(name[i]); }
  return out + (open ? '</mark>' : '');
}
function paintSearch() {
  const body = $('#srBody', modal), foot = $('#srFoot', modal); if (!body) return;
  const q = SR.q.trim(), building = SR.status.filter(s => s.building), items = SR.status.reduce((t, s) => t + s.count, 0);
  const built = SR.status.filter(s => s.built), oldest = built.length ? Math.min(...built.map(s => s.built)) : null;
  foot.innerHTML = !indexOn() ? '' : building.length ? `<span class="spin"></span>Indexing ${esc(building.map(s => s.drive).join(', '))}…`
    : built.length ? `${items.toLocaleString()} items on ${nOf(built.length, 'drive')}, updated ${ago(oldest)}<button class="link" data-act="index-refresh">Update now</button>` : '';
  if (!indexOn()) {
    body.innerHTML = `<div class="sr-empty">${ico('search')}<b>Search is turned off</b><p>Searching all drives needs DriveDeck’s list of your file names. You can turn it on in Settings.</p><button class="btn" data-act="index-on">Turn on search</button></div>`;
    return;
  }
  if (!q) {
    body.innerHTML = `<div class="sr-empty">${ico('search')}<b>Find any file, on any drive</b><p>${built.length ? 'Type part of a name. Results show which drive and folder each file is in.' : 'DriveDeck is listing your files for the first time. Results appear as each drive finishes.'}</p></div>`;
    return;
  }
  if (!SR.results.length) {
    body.innerHTML = `<div class="sr-empty">${ico('search')}<b>No files match “${esc(q)}”</b><p>${building.length ? 'Some drives are still being indexed, so try again in a moment.' : 'Search looks at file and folder names.'}</p></div>`;
    return;
  }
  body.innerHTML = SR.results.map((r, i) => {
    const { color, emoji } = lookOf(r.drive), dir = parentOf(r.path), k = kindOf({ Name: r.name, IsDir: r.isDir });
    return `<button class="sr-row" data-r="${i}" role="option"><span class="sr-ico ${k === 'folder' ? 'folder' : ''}" style="--c:${color}">${ico(ICON[k])}</span>
      <span class="sr-main"><b>${marked(r.name, q)}</b><span class="sr-where"><span class="badge xs" style="--c:${color}">${esc(emoji)}</span>${esc(r.drive)}${dir ? ' / ' + esc(dir) : ''}</span></span>
      <span class="sr-meta num">${r.isDir ? 'Folder' : r.size >= 0 ? fmt(r.size) : ''}<small>${r.mtime ? fmtDate(r.mtime) : ''}</small></span></button>`;
  }).join('') + (SR.total > SR.results.length ? `<p class="sr-more">Showing ${SR.results.length} of ${SR.total.toLocaleString()} matches. Type more to narrow it down.</p>` : '');
  paintSearchSel(false);
}
function paintSearchSel(scroll) {
  $$('.sr-row', modal).forEach(el => el.setAttribute('aria-selected', +el.dataset.r === SR.sel));
  if (scroll) $(`.sr-row[data-r="${SR.sel}"]`, modal)?.scrollIntoView({ block: 'nearest' });
}
modal.addEventListener('click', e => {
  if (!modal.classList.contains('palette')) return;
  const row = e.target.closest('.sr-row'); if (row) return openResult(SR.results[row.dataset.r]);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'index-refresh') refreshIndex().then(runSearch);
  if (act === 'index-on') setIndex(true).then(runSearch);
});
modal.addEventListener('mousemove', e => { const row = e.target.closest?.('.sr-row'); if (row && +row.dataset.r !== SR.sel) { SR.sel = +row.dataset.r; paintSearchSel(false); } });
// Opens a folder result, or a file's folder with the file highlighted.
function openResult(r) {
  if (!r) return;
  closeModal();
  if (r.isDir) return go(r.drive, r.path);
  S.focus = { drive: r.drive, path: r.path };
  go(r.drive, parentOf(r.path));
}
async function refreshIndex() { await api('/_ui/index/refresh', { method: 'POST' }).catch(() => {}); }
async function setIndex(on) {
  await patchConfig({ prefs: { index: on } }).catch(e => toast(e.message, 'err'));
  if (on) sendDrivesToIndex();
}
const sendDrivesToIndex = () => api('/_ui/index', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drives: S.drives.filter(d => d.type !== 'crypt').map(d => d.name) }) }).catch(() => {});
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && S.page !== 'setup' && S.page !== 'signedout') {
    e.preventDefault();
    if (modal.open && modal.classList.contains('palette')) closeModal(); else if (!modal.open) openSearch();
  }
});

// ---------- duplicates ----------
// Built from the search index: files stored more than once across all drives, largest waste first.
// One copy of each file always stays: the last unticked box in a group can't be ticked.
const DUP = { data: null, min: 1024 * 1024, picked: new Set(), timer: null };
const dupKey = it => it.drive + ':' + it.path;   // drive names can't contain ':'
async function showDuplicates() {
  leaveFolder(); Object.assign(S, { sel: null, page: 'duplicates' }); S.nav++;
  renderSide(); renderDuplicates(true); loadDuplicates();
}
async function loadDuplicates() {
  clearTimeout(DUP.timer);
  try { const r = await api('/_ui/duplicates?min=' + DUP.min); DUP.data = await r.json(); } catch (e) { DUP.data = { error: e.message, groups: [], status: [] }; }
  if (S.page !== 'duplicates') return;
  const live = new Set(DUP.data.groups.flatMap(g => g.items.map(dupKey)));
  for (const k of DUP.picked) if (!live.has(k)) DUP.picked.delete(k);
  renderDuplicates(false);
  if (DUP.data.status?.some(s => s.building)) DUP.timer = setTimeout(loadDuplicates, 2000);
}
function renderDuplicates(anim) {
  const main = $('#main'); accent(main, null);
  const d = DUP.data, building = d?.status?.filter(s => s.building) || [], built = d?.status?.filter(s => s.built) || [];
  const sizes = [[0, 'Any size'], [1, '1 MB'], [10, '10 MB'], [100, '100 MB']].map(([m, l]) => [m * 1024 * 1024, l]);
  let body;
  if (!indexOn()) body = `<div class="empty"><div class="ill">${ico('dupes')}</div><h3>Duplicates needs the search index</h3><p>DriveDeck finds duplicates in its list of your file names, which is turned off.</p><button class="btn primary" data-act="index-on">Turn on search index</button></div>`;
  else if (!d) body = `<div class="dups">${'<div class="skel" style="height:118px;border-radius:16px;margin-bottom:12px"></div>'.repeat(3)}</div>`;
  else if (!d.groups.length) body = `<div class="empty"><div class="ill">${ico('dupes')}</div><h3>${building.length ? 'Looking through your drives…' : 'No duplicates found'}</h3>
    <p>${building.length ? `Indexing ${esc(building.map(s => s.drive).join(', '))}. Results appear here when it’s done.` : `None of your files${DUP.min ? ` over ${fmt(DUP.min)}` : ''} are stored more than once.`}</p></div>`;
  else body = `<div class="dups">${d.groups.map((g, gi) => {
    const k = kindOf({ Name: g.name, IsDir: false }), ticked = g.items.filter(it => DUP.picked.has(dupKey(it))).length;
    return `<section class="dup" style="--d:${Math.min(gi, 12) * 30}ms"><div class="dup-head"><span class="dup-ico">${ico(ICON[k])}</span>
      <div class="dup-name"><b title="${esc(g.name)}">${esc(g.name)}</b><span class="num">${fmt(g.size)} each, ${g.items.length} copies</span></div>
      <span class="tag ${g.exact ? 'rec' : ''}" title="${g.exact ? 'The files’ checksums match, so their contents are identical.' : 'Same name and size. MEGA doesn’t provide checksums, so the contents can’t be compared.'}">${g.exact ? 'Identical' : 'Same name and size'}</span></div>
      ${g.items.map(it => {
        const { color, emoji } = lookOf(it.drive), key = dupKey(it), on = DUP.picked.has(key), last = !on && ticked === g.items.length - 1;
        return `<div class="dup-row ${on ? 'on' : ''}"><label><input type="checkbox" data-dup="${esc(key)}" ${on ? 'checked' : ''} ${last ? 'disabled title="Keep at least one copy"' : ''}>
          <span class="badge xs" style="--c:${color}">${esc(emoji)}</span><span class="dup-path"><b>${esc(it.drive)}</b>${esc(parentOf(it.path) ? ' / ' + parentOf(it.path) : '')}</span></label>
          <span class="mute num">${it.mtime ? fmtDate(it.mtime) : ''}</span><button class="icon-btn sm" data-dupopen="${esc(key)}" title="Show in folder">${ico('folder')}</button></div>`;
      }).join('')}</section>`;
  }).join('')}${d.count > d.groups.length ? `<p class="mute">Showing the ${d.groups.length} biggest of ${d.count.toLocaleString()}.</p>` : ''}</div>`;
  const picked = d ? d.groups.flatMap(g => g.items.filter(it => DUP.picked.has(dupKey(it))).map(() => g.size)) : [];
  main.innerHTML = `<div class="toolbar"><button class="icon-btn menu-btn" data-act="drawer" title="Drives">${ico('menu')}</button><div class="crumbs"><span class="crumb">Duplicates</span></div></div>
    <div class="content ${anim ? 'enter' : ''}" id="content"><div class="dup-page">
      <div class="dup-top"><div><h1>Duplicates</h1>
        <p>${d?.groups?.length ? `${nOf(d.count, 'file')} ${d.count === 1 ? 'is' : 'are'} stored more than once. Deleting the extra copies would free <b class="num">${fmt(d.wasted)}</b>.` : 'Files stored more than once, across all your drives.'}</p>
        ${indexOn() && built.length ? `<p class="dup-status">${building.length ? '<span class="spin"></span>Updating the index…' : `Based on the search index, updated ${ago(Math.min(...built.map(s => s.built)))}.`} <button class="link" data-act="dup-refresh">Update now</button></p>` : ''}</div>
        <label class="select-wrap" title="Ignore files smaller than this"><select class="input" data-dupmin aria-label="Smallest file size">${sizes.map(([v, l]) => `<option value="${v}" ${v === DUP.min ? 'selected' : ''}>${v ? 'Over ' + l : l}</option>`).join('')}</select>${ico('chev-d')}</label></div>
      ${body}</div></div>
    <div class="dup-bar" ${picked.length ? '' : 'hidden'}><span><b class="num">${nOf(picked.length, 'copy', 'copies')}</b> selected, <span class="num">${fmt(picked.reduce((a, b) => a + b, 0))}</span></span>
      <button class="btn ghost" data-act="dup-clear">Clear</button><button class="btn danger" data-act="dup-delete">${ico('trash')}Delete ${picked.length === 1 ? 'copy' : 'copies'}</button></div>`;
}
async function deleteDuplicates() {
  const d = DUP.data, targets = d.groups.flatMap(g => g.items.filter(it => DUP.picked.has(dupKey(it))).map(it => ({ ...it, size: g.size })));
  if (!targets.length) return;
  const drives = [...new Set(targets.map(t => t.drive))], failed = [];
  const ok = await dialog({
    title: `Delete ${nOf(targets.length, 'copy', 'copies')}?`, ok: 'Delete', danger: true,
    text: `This frees ${fmt(targets.reduce((t, x) => t + x.size, 0))}. One copy of each file stays. ${drives.length === 1 ? trashNote(drives[0]) : 'Your drives may keep deleted files in their trash.'}`,
    onSubmit: async () => {
      const btn = $('[type=submit]', modal);
      for (const [k, t] of targets.entries()) {
        if (btn?.lastChild) btn.lastChild.textContent = `Deleting ${k + 1} of ${targets.length}`;
        try { await rc('operations/deletefile', { fs: t.drive + ':', remote: t.path }); DUP.picked.delete(dupKey(t)); }
        catch (e) { failed.push(`${t.path}: ${e.message}`); }
      }
    },
  });
  if (!ok) return;
  const gone = new Set(targets.map(dupKey).filter(k => !DUP.picked.has(k)));
  for (const g of d.groups) g.items = g.items.filter(it => !gone.has(dupKey(it)));
  d.groups = d.groups.filter(g => g.items.length > 1);
  d.wasted = d.groups.reduce((t, g) => t + g.size * (g.items.length - 1), 0); d.count = d.groups.length;
  for (const dr of drives) { touchIndex(dr); forget(dr); const x = driveOf(dr); if (x) aboutDrive(x); }
  if (failed.length) toast(`Couldn’t delete ${failed.length}. ${failed[0]}`, 'err'); else toast(`Deleted ${nOf(gone.size, 'copy', 'copies')}`, 'ok');
  renderDuplicates(false);
}
main.addEventListener('change', e => {
  if (e.target.matches('[data-dup]')) { const k = e.target.dataset.dup; if (e.target.checked) DUP.picked.add(k); else DUP.picked.delete(k); renderDuplicatesKeepScroll(); }
  if (e.target.matches('select[data-dupmin]')) { DUP.min = +e.target.value; DUP.data = null; renderDuplicates(false); loadDuplicates(); }
});
function renderDuplicatesKeepScroll() { const top = $('#content')?.scrollTop || 0; renderDuplicates(false); $('#content').scrollTop = top; }
main.addEventListener('click', e => {
  const o = e.target.closest('[data-dupopen]'); if (!o) return;
  const k = o.dataset.dupopen, drive = k.slice(0, k.indexOf(':')), path = k.slice(k.indexOf(':') + 1);
  S.focus = { drive, path }; go(drive, parentOf(path));
});

// ---------- drive appearance ----------
function lookHtml(st) {
  return `<div class="field"><span>Color</span></div><div class="swatches" role="radiogroup" aria-label="Color">
    ${COLORS.map(c => `<button type="button" class="sw" role="radio" style="--c:${c}" data-color="${c}" aria-checked="${c === st.color}" title="${c}"></button>`).join('')}
    <label class="sw custom" title="Custom color" style="--c:${st.color}" aria-checked="${!COLORS.includes(st.color)}"><input type="color" value="${st.color}"></label></div>
    <div class="field"><span>Icon</span></div><div class="emojis" role="radiogroup" aria-label="Icon">
    ${EMOJIS.map(e => `<button type="button" class="emo" role="radio" data-emoji="${e}" aria-checked="${e === st.emoji}">${e}</button>`).join('')}</div>
    <div class="emo-custom"><input class="input" id="emoIn" maxlength="16" placeholder="😀" value="${EMOJIS.includes(st.emoji) ? '' : esc(st.emoji)}" aria-label="Custom emoji"><span class="mute">or type any emoji</span></div>`;
}
// Wires the color/emoji pickers inside root; st is mutated, onChange repaints previews.
function wireLook(root, st, onChange) {
  const paint = () => {
    $$('.sw[data-color]', root).forEach(b => b.setAttribute('aria-checked', b.dataset.color === st.color));
    const custom = $('.sw.custom', root); custom.setAttribute('aria-checked', !COLORS.includes(st.color)); custom.style.setProperty('--c', st.color);
    $$('.emo', root).forEach(b => b.setAttribute('aria-checked', b.dataset.emoji === st.emoji));
    root.style.setProperty('--pick', st.color);
    accent(modal, st.color);
    onChange();
  };
  const bump = () => { const b = $('.look .badge', root); if (b) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); } };
  root.addEventListener('click', e => {
    const c = e.target.closest('[data-color]'); if (c) { st.color = c.dataset.color; paint(); bump(); }
    const m = e.target.closest('[data-emoji]'); if (m) { st.emoji = m.dataset.emoji; $('#emoIn', root).value = ''; paint(); bump(); }
  });
  $('.sw.custom input', root).oninput = e => { st.color = e.target.value.toLowerCase(); paint(); };
  $('#emoIn', root).oninput = e => {
    const g = [...new Intl.Segmenter().segment(e.target.value.trim())].map(s => s.segment).filter(s => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s));
    if (g.length) { st.emoji = g[g.length - 1]; e.target.value = st.emoji; paint(); bump(); }
  };
  paint();
}
const lookPreview = (st, name, sub) => `<div class="look"><span class="badge lg" style="--c:${st.color}">${esc(st.emoji)}</span><div><div class="look-name">${esc(name)}</div><div class="look-sub">${esc(sub)}</div></div></div>`;
const paintPreview = (root, st, name) => {
  const b = $('.look .badge', root); b.style.setProperty('--c', st.color); b.textContent = st.emoji;
  if (name != null) $('.look-name', root).textContent = name;
};

function editLook(name) {
  const st = { ...lookOf(name) }, dr = driveOf(name);
  openModal(`${modalHead('Color and icon', 'Pick how this drive looks across DriveDeck.')}
    <div class="m-body" id="lookRoot">${lookPreview(st, name, PROVIDERS[dr?.type]?.label + ' drive')}${lookHtml(st)}<div class="form-err" hidden></div></div>
    <div class="m-foot"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" id="lookSave">Save</button></div>`);
  const root = $('#lookRoot', modal);
  wireLook(root, st, () => paintPreview(root, st));
  $('[data-cancel]', modal).onclick = closeModal;
  $('#lookSave', modal).onclick = async e => {
    busy(e.currentTarget, true, 'Save');
    try { await patchConfig({ drives: { [name]: st } }); closeModal(); toast('Saved', 'ok'); renderSide(); if (S.page === 'drive' && S.sel === name) renderBrowser(); else if (S.page === 'home') renderHome(false); }
    catch (err) { busy(e.currentTarget, false); formError(root, err.message); }
  };
}

// ---------- add / reconnect / remove ----------
function addDrive(type) {
  if (!type) {
    openModal(`${modalHead('Add a drive', 'Choose where your files live.')}
      <div class="m-body"><div class="providers">
        ${Object.entries(PROVIDERS).map(([k, p]) => `<button class="prov" data-type="${k}" style="--pc:${p.color}" ${k === 'crypt' && !S.drives.some(d => d.type !== 'crypt') ? 'disabled title="Add a drive first"' : ''}><span class="mark">${p.icon ? ico(p.icon) : esc(p.mark)}</span><span><b>${esc(p.label)}</b><small>${esc(p.blurb)}</small></span></button>`).join('')}
        ${COMING_SOON.map(([label, mark]) => `<button class="prov" disabled><span class="soon">Soon</span><span class="mark">${esc(mark)}</span><span><b>${esc(label)}</b><small>Coming in a later version</small></span></button>`).join('')}
      </div></div>`);
    $('.prov[data-type]', modal).focus();
    $('.providers', modal).onclick = e => { const b = e.target.closest('[data-type]'); if (b) addDrive(b.dataset.type); };
    return;
  }
  const p = PROVIDERS[type];
  if (type === 'crypt') return addCryptDrive();
  if (p.oauth) return addOAuthDrive(type);
  let n = S.drives.filter(d => d.type === type).length + 1;
  while (S.remotes.includes(type + n)) n++;
  const used = new Set(S.drives.map(d => lookOf(d.name).color));
  const usedEmoji = new Set(S.drives.map(d => lookOf(d.name).emoji));
  const st = { color: COLORS.find(c => !used.has(c)) || COLORS[0], emoji: DEFAULT_EMOJIS.find(e => !usedEmoji.has(e)) || EMOJIS[0] };
  const fields = [{ key: 'name', label: 'Drive name', hint: 'letters, numbers, - and _', value: type + n }, ...p.fields];
  openModal(`${modalHead(`Connect ${p.label}`, null, true)}
    <form class="m-body" id="addForm">
      ${lookPreview(st, type + n, p.label + ' drive')}
      <div class="form-err" hidden></div>
      ${fields.map((f, i) => fieldHtml(f, 'af' + i)).join('')}
      ${lookHtml(st)}
    </form>
    <div class="m-foot"><span class="left">${esc(p.note || '')}</span><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit" form="addForm">Add drive</button></div>`);
  const form = $('#addForm', modal);
  form.style.animation = 'enter .25s var(--ease)';
  $('#af1', modal).setAttribute('autofocus', ''); setTimeout(() => $('#af1', modal).focus(), 30);
  const nameIn = $('#af0', modal);
  wireLook(form, st, () => paintPreview(form, st, nameIn.value.trim() || 'Untitled'));
  nameIn.oninput = () => paintPreview(form, st, nameIn.value.trim() || 'Untitled');
  $('[data-back]', modal).onclick = () => addDrive();
  $('[data-cancel]', modal).onclick = closeModal;
  form.onsubmit = async e => {
    e.preventDefault();
    const vals = fields.map((f, i) => { const el = $('#af' + i, modal); return f.type === 'password' ? el.value : el.value.trim(); });
    const bad = i => { const el = $('#af' + i, modal); el.classList.remove('bad'); void el.offsetWidth; el.classList.add('bad'); el.focus(); };
    const name = vals[0];
    if (!/^[\w-]+$/.test(name)) { formError(form, 'Use only letters, numbers, - and _ in the drive name.'); return bad(0); }
    if (S.remotes.includes(name)) { formError(form, `There is already a remote called “${name}” in your rclone config.`); return bad(0); }
    for (let i = 1; i < fields.length; i++) if (fields[i].required && !vals[i]) { formError(form, `Enter your ${fields[i].label.toLowerCase()}.`); return bad(i); }
    formError(form, '');
    const parameters = {};
    p.fields.forEach((f, i) => { if (vals[i + 1]) parameters[f.key] = vals[i + 1]; });
    const btn = $('[type=submit]', modal);
    busy(btn, true, 'Connecting…');
    try {
      await rc('config/create', { name, type, parameters, opt: { obscure: true } });
      await rc('operations/about', { fs: name + ':' }); // verifies the login works
      await patchConfig({ drives: { [name]: st } });
      closeModal(); toast(`Added ${name}`, 'ok');
      await loadDrives(); go(name);
    } catch (err) {
      try { await rc('config/delete', { name }); } catch (_) {}
      busy(btn, false); formError(form, `Couldn't connect: ${err.message}`); $('.form-err', form).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };
}

// ---------- encrypted folders ----------
// An rclone crypt remote over a folder of another drive. New folders are created empty; an existing one is
// opened, and checked against the password by listing it and reading the first byte of a file. No salt
// (rclone's second password) is set, so the password alone is enough to open the files with rclone anywhere.
function addCryptDrive() {
  const parents = S.drives.filter(d => d.type !== 'crypt' && !d.err);
  let n = 1; while (S.remotes.includes(n === 1 ? 'vault' : 'vault' + n)) n++;
  const used = new Set(S.drives.map(d => lookOf(d.name).color));
  const st = { color: COLORS.find(c => !used.has(c)) || COLORS[0], emoji: '🔒' };
  const g = { name: n === 1 ? 'vault' : 'vault' + n, parent: (S.drives.find(d => d.name === S.sel && d.type !== 'crypt') || parents[0])?.name, folder: 'Encrypted', names: true };
  const plainConfig = !S.about?.configEncrypted;
  openModal(`${modalHead('Add an encrypted folder', null, true)}
    <form class="m-body" id="addForm" autocomplete="off">
      ${lookPreview(st, g.name, 'Encrypted folder')}
      <p class="m-text mute">Files are encrypted on this computer before they’re uploaded, so the drive only ever stores scrambled data. Use the same folder and password to open an encrypted folder you made before.</p>
      <div class="form-err" hidden></div>
      ${fieldHtml({ label: 'Name', hint: 'letters, numbers, - and _', value: g.name }, 'cName')}
      <div class="field"><span>Stored in</span><span class="crypt-where"><label class="select-wrap"><select class="input" id="cParent" aria-label="Drive">${parents.map(d => `<option value="${esc(d.name)}" ${d.name === g.parent ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>${ico('chev-d')}</label>
        <input class="input" id="cFolder" value="${esc(g.folder)}" aria-label="Folder" spellcheck="false" placeholder="Folder"></span></div>
      ${fieldHtml({ label: 'Password', type: 'password', hint: 'at least 10 characters' }, 'cPass')}
      ${fieldHtml({ label: 'Password again', type: 'password' }, 'cPass2')}
      <div class="set-row slim"><div><b>Encrypt file and folder names too</b><p>Otherwise the names stay readable on the drive, and only what’s inside the files is hidden.</p></div>
        <button type="button" class="switch" role="switch" aria-checked="true" id="cNames" aria-label="Encrypt file and folder names"><i></i></button></div>
      <p class="set-note warn">${ico('alert')}<span>If you forget the password, nobody can open these files, not even you. Keep it in a password manager.</span></p>
      ${plainConfig ? `<p class="set-note">${ico('alert')}<span>The password is saved in your rclone config, scrambled but not encrypted, like your other sign-ins. To protect it, encrypt the config: run <code>rclone config</code>, then choose <b>s</b>.</span></p>` : ''}
      ${lookHtml(st)}
    </form>
    <div class="m-foot"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit" form="addForm">${ico('lock')}Add encrypted folder</button></div>`);
  const form = $('#addForm', modal), nameIn = $('#cName', modal);
  form.style.animation = 'enter .25s var(--ease)';
  setTimeout(() => nameIn.focus(), 30);
  wireLook(form, st, () => paintPreview(form, st, nameIn.value.trim() || 'Untitled'));
  nameIn.oninput = () => paintPreview(form, st, nameIn.value.trim() || 'Untitled');
  $('[data-back]', modal).onclick = () => addDrive();
  $('[data-cancel]', modal).onclick = closeModal;
  const sw = $('#cNames', modal);
  sw.onclick = () => { g.names = !g.names; sw.setAttribute('aria-checked', g.names); };
  form.onsubmit = async e => {
    e.preventDefault();
    const name = nameIn.value.trim(), parent = $('#cParent', modal).value, folder = $('#cFolder', modal).value.trim().replace(/^\/+|\/+$/g, '');
    const pass = $('#cPass', modal).value, pass2 = $('#cPass2', modal).value;
    const bad = (id, msg) => { formError(form, msg); const el = $('#' + id, modal); el.classList.remove('bad'); void el.offsetWidth; el.classList.add('bad'); el.focus(); };
    if (!/^[\w-]+$/.test(name)) return bad('cName', 'Use only letters, numbers, - and _ in the name.');
    if (S.remotes.includes(name)) return bad('cName', `There is already a remote called “${name}” in your rclone config.`);
    if (!folder) return bad('cFolder', 'Choose a folder for the encrypted files. Using a whole drive isn’t supported here.');
    if (pass.length < 10) return bad('cPass', 'Use a password of at least 10 characters.');
    if (pass !== pass2) return bad('cPass2', 'The two passwords don’t match.');
    formError(form, '');
    const btn = $('[type=submit]', modal); busy(btn, true, 'Checking…');
    try {
      let existing = null;
      try { existing = (await rc('operations/list', { fs: parent + ':', remote: folder })).list; }
      catch (err) { if (!/not found|doesn.t exist/i.test(err.message)) throw err; }
      await rc('config/create', { name, type: 'crypt', parameters: { remote: `${parent}:${folder}`, password: pass, filename_encryption: g.names ? 'standard' : 'off', directory_name_encryption: g.names ? 'true' : 'false' }, opt: { obscure: true, nonInteractive: true } });
      try {
        if (existing?.length) {
          const wrong = `Nothing in ${parent}/${folder} could be opened with this password. Check the password and the “encrypt names” setting, and that the folder was encrypted with DriveDeck or rclone.`;
          const inside = (await rc('operations/list', { fs: name + ':', remote: '', opt: { recurse: true, filesOnly: true } })).list;
          if (!inside.length) throw new Error(wrong);
          // A wrong password fails while the file is read, after the response has started. (An empty file
          // has nothing to read, so one with something in it is used.)
          const sample = inside.find(f => f.Size > 0);
          const ok = !sample || await api(rawUrl(name, sample.Path), { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(20000) })
            .then(async r => r.ok && (await r.arrayBuffer()).byteLength > 0).catch(() => false);
          if (!ok) throw new Error(wrong);
        } else await rc('operations/mkdir', { fs: name + ':', remote: '' });
      } catch (err) { await rc('config/delete', { name }).catch(() => {}); throw err; }
      await patchConfig({ drives: { [name]: st } }).catch(() => {});
      closeModal(); toast(existing?.length ? `Opened ${name}` : `Added ${name}. Files you put in it are encrypted.`, 'ok');
      await loadDrives(); go(name);
    } catch (err) {
      busy(btn, false); formError(form, err.message); $('.form-err', form).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };
}

async function reconnect(name) {
  const dr = driveOf(name), p = PROVIDERS[dr?.type];
  if (!p) return;
  if (p.oauth) return reconnectOAuth(name);
  const v = await dialog({
    title: `Reconnect ${name}`, text: 'Signs in again with the saved password. Use this if the drive stopped responding.',
    fields: p.reconnect.fields, ok: 'Reconnect',
    onSubmit: async vals => {
      const parameters = { ...p.reconnect.reset };
      for (const [k, val] of Object.entries(vals)) if (val) parameters[k] = val;
      await rc('config/update', { name, parameters, opt: { nonInteractive: true } });
      await rc('operations/about', { fs: name + ':' });
    },
  });
  if (!v) return;
  toast(`Reconnected ${name}`, 'ok');
  if (dr) await aboutDrive(dr);
  if (S.sel === name) openDir(name, S.path);
}

async function removeDrive(name) {
  const dr = driveOf(name), p = PROVIDERS[dr?.type];
  const ok = await dialog({
    title: `Remove ${name}?`, ok: dr?.type === 'crypt' ? 'Remove encrypted folder' : 'Remove drive', danger: true,
    text: dr?.type === 'crypt'
      ? `DriveDeck will forget this encrypted folder and its password. The encrypted files stay in ${cryptPlace(dr)}. To open them again, add an encrypted folder there with the same password.`
      : `DriveDeck will forget this drive and its sign-in. Your files stay on ${p?.label || 'the cloud'}.`,
    onSubmit: async () => { await rc('config/delete', { name }); await patchConfig({ drives: { [name]: null } }).catch(() => {}); },
  });
  if (!ok) return;
  toast(`Removed ${name}`, 'ok'); forget(name);
  if (S.sel === name) go(null);
  loadDrives().catch(e => toast(e.message, 'err'));
}

// ---------- Google sign-in ----------
// rclone runs the sign-in (lib/oauth.js): DriveDeck opens Google's page in a new tab, waits until rclone has
// the token, then saves it to the drive. The token itself never reaches this page.
// Google needs an app to sign in with: the user's own (set up once with the guide below, recommended) or
// rclone's shared one, which rclone is retiring during 2026.
const SHARED_RETIRING = 'rclone is retiring its shared Google app during 2026';
async function oauthApi(path, body) {
  const r = await api('/_ui/oauth/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
  return j;
}
// Turns Google's error messages into something the user can act on. Returns { message, link?, again? },
// where again means signing in again should fix it.
function explainError(msg) {
  const project = /project[= ](\d+)/.exec(msg)?.[1];
  if (/has not been used in project|accessNotConfigured|SERVICE_DISABLED/i.test(msg))
    return { message: 'The Google Drive API isn’t turned on for your Google app. Turn it on, wait a minute, then try again.',
      link: { href: 'https://console.cloud.google.com/apis/library/drive.googleapis.com' + (project ? '?project=' + project : ''), label: 'Turn on the Drive API' } };
  if (/invalid_grant|expired or revoked/i.test(msg)) return { message: 'Google signed this drive out, so it needs to sign in again.', again: true };
  if (/rateLimitExceeded|userRateLimitExceeded|Error 429|Quota exceeded/i.test(msg))
    return { message: 'Google is limiting requests right now. Wait a minute and try again. Your own Google app has limits of its own, so it’s rarely slowed down by other people.' };
  if (/Error 401|Invalid Credentials/i.test(msg)) return { message: 'Google didn’t accept this drive’s sign-in, so it needs to sign in again.', again: true };
  return { message: msg.split('\n')[0].replace(/googleapi: /, '') };
}
const shortClient = id => id.replace(/\.apps\.googleusercontent\.com$/, '').replace(/^(.{14}).+$/, '$1…');

// Runs a sign-in in the modal. o: { backend, client: 'own' | 'shared' | 'remote', remote, title, save(jobId), back() }
// save stores the sign-in and closes the modal; if it throws, the error is shown with Try again.
function oauthSignIn(o) {
  // The tab has to open during the click, or the browser blocks it. It shows Google's page once rclone is ready.
  const p = PROVIDERS[o.backend], site = p.site;
  const win = window.open('', '_blank');
  if (win) {
    try { win.document.title = `${site} sign-in`; win.document.body.innerHTML = `<p style="font:15px system-ui,sans-serif;padding:24px;color:#6b7280">Opening ${esc(site)}…</p>`; } catch (_) {}
    win.opener = null;
  }
  let job = null, timer = null, over = false;
  const closeTab = () => { try { if (win && !win.closed) win.close(); } catch (_) {} };
  const end = () => { over = true; clearTimeout(timer); closeTab(); };
  const leave = () => { if (job && !over) oauthApi(job.id + '/cancel', {}).catch(() => {}); end(); o.back ? o.back() : closeModal(); };

  const paint = (phase, err) => {
    const own = o.client === 'own' || (o.client === 'remote' && o.ownClient);
    const mark = `<div class="signin-mark ${phase}" style="--pc:${p.color}">${phase === 'error' ? ico('alert') : phase === 'save' ? ico('check') : `<span>${esc(p.mark)}</span>`}</div>`;
    const body = phase === 'error'
      ? `${mark}<h3>${esc(err.title)}</h3><p>${esc(err.message)}</p>${err.link ? `<a class="btn" href="${esc(err.link.href)}" target="_blank" rel="noopener">${ico('link')}${esc(err.link.label)}</a>` : ''}`
      : phase === 'save'
      ? `${mark}<h3>Signed in</h3><p>Saving the sign-in and checking the drive…</p>`
      : `${mark}<h3>${win ? `Finish signing in on ${site}’s page` : `Sign in on ${site}’s page`}</h3>
         <p>${win ? `A ${site} tab opened. Choose your account and allow access, then come back to this tab.` : `Your browser blocked the new tab. Open ${site}’s page to choose your account and allow access.`}</p>
         ${own ? `<p class="signin-hint">${ico('alert')}<span>Google will say it hasn’t verified this app. That’s expected for your own app: choose <b>Advanced</b>, then <b>Go to DriveDeck</b>.</span></p>` : ''}
         ${job?.url ? `<a class="btn ${win ? '' : 'primary'}" href="${esc(job.url)}" target="_blank" rel="noopener">${ico('link')}${win ? `Open ${site}’s page again` : `Open ${site}’s page`}</a>` : ''}`;
    const foot = phase === 'error'
      ? `<button class="btn ghost" data-leave>${o.back ? 'Back' : 'Close'}</button><button class="btn primary" data-retry>${ico('refresh')}${err.again ? 'Sign in again' : 'Try again'}</button>`
      : `<span class="left">${phase === 'save' ? '' : `<span class="waiting"><span class="spin"></span>Waiting for ${site}</span>`}</span><button class="btn ghost" data-leave ${phase === 'save' ? 'disabled' : ''}>Cancel</button>`;
    openModal(`${modalHead(o.title, null)}<div class="m-body"><div class="signin">${body}</div></div><div class="m-foot">${foot}</div>`, 'sm');
    accent(modal, o.accent || null);
    $('[data-leave]', modal).onclick = leave;
    const retry = $('[data-retry]', modal);
    if (retry) retry.onclick = () => err.again ? oauthSignIn(o) : save();
    modal.onclose = () => { if (job && !over) oauthApi(job.id + '/cancel', {}).catch(() => {}); end(); };
  };
  const save = async () => {
    paint('save');
    try { over = true; await o.save(job.id); }
    catch (e) {
      over = false;
      const x = explainError(e.message);
      paint('error', { title: 'Couldn’t connect the drive', message: x.message, link: x.link, again: e.status === 404 || x.again });
    }
  };
  const poll = async () => {
    if (over) return;
    try { job = await oauthApi(job.id); }
    catch (e) { end(); return paint('error', { title: 'Sign-in didn’t finish', message: e.message, again: true }); }
    if (over) return;
    if (job.state === 'waiting') { timer = setTimeout(poll, 1000); return; }
    closeTab();
    if (job.state === 'done') return save();
    end();
    paint('error', { title: 'Sign-in didn’t finish', message: job.error || 'The sign-in was cancelled.', again: true });
  };
  paint('start');
  oauthApi('start', { backend: o.backend, client: o.client, remote: o.remote }).then(j => {
    job = j;
    if (over) { oauthApi(j.id + '/cancel', {}).catch(() => {}); return; }
    try { if (win && !win.closed) win.location.href = j.url; } catch (_) {}
    paint('wait'); poll();
  }).catch(e => { end(); paint('error', { title: 'Couldn’t start the sign-in', message: e.message, again: true }); });
}

function addOAuthDrive(type) {
  const p = PROVIDERS[type], prefix = p.prefix || type;
  let n = S.drives.filter(d => d.type === type).length + 1;
  while (S.remotes.includes(prefix + n)) n++;
  const used = new Set(S.drives.map(d => lookOf(d.name).color)), usedEmoji = new Set(S.drives.map(d => lookOf(d.name).emoji));
  const g = {
    name: prefix + n, client: type === 'drive' ? 'own' : 'shared',
    st: { color: COLORS.find(c => !used.has(c)) || COLORS[0], emoji: DEFAULT_EMOJIS.find(e => !usedEmoji.has(e)) || EMOJIS[0] },
  };
  const form = () => {
    const app = S.cfg.google;
    openModal(`${modalHead(`Connect ${p.label}`, null, true)}
      <form class="m-body" id="addForm">
        ${lookPreview(g.st, g.name, p.label + ' drive')}
        <div class="form-err" hidden></div>
        ${fieldHtml({ label: 'Drive name', hint: 'letters, numbers, - and _', value: g.name }, 'af0')}
        ${type === 'drive' ? `<div class="field"><span>Sign in with</span></div>
        <div class="choices" role="radiogroup" aria-label="Sign in with">
          <button type="button" class="choice" role="radio" data-client="own"><span class="dot"></span>
            <span><b>Your own Google app</b><span class="tag rec">Recommended</span>
            <small>Only you use it, so other people can’t slow it down. ${app ? '' : 'Set it up once, in about 10 minutes.'}</small></span></button>
          <button type="button" class="choice" role="radio" data-client="shared"><span class="dot"></span>
            <span><b>rclone’s shared app</b><small>No setup, but ${SHARED_RETIRING}, and it can be slow when many people use it.</small></span></button>
        </div>
        <div class="own-app" ${app ? '' : 'hidden'}>${ico('check')}<span>Your app <code title="${esc(app?.clientId || '')}">${esc(app ? shortClient(app.clientId) : '')}</code> is set up.</span><button type="button" class="link" data-guide>Change</button></div>` : ''}
        ${lookHtml(g.st)}
      </form>
      <div class="m-foot"><span class="left">${esc(p.site)} asks you to allow access to your files.</span><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit" form="addForm"></button></div>`);
    const root = $('#addForm', modal), nameIn = $('#af0', modal);
    const paintChoice = () => {
      $$('.choice', root).forEach(b => b.setAttribute('aria-checked', b.dataset.client === g.client));
      const own = $('.own-app', root); if (own) own.hidden = !(g.client === 'own' && S.cfg.google);
      $('[type=submit]', modal).innerHTML = g.client === 'own' && !S.cfg.google ? `${ico('settings')}Set up your Google app` : `${ico('link')}Continue with ${esc(p.site)}`;
    };
    paintChoice();
    const choices = $('.choices', root);
    if (choices) choices.onclick = e => { const b = e.target.closest('[data-client]'); if (b) { g.client = b.dataset.client; paintChoice(); } };
    wireLook(root, g.st, () => paintPreview(root, g.st, nameIn.value.trim() || 'Untitled'));
    nameIn.oninput = () => { g.name = nameIn.value.trim(); paintPreview(root, g.st, g.name || 'Untitled'); };
    $('[data-back]', modal).onclick = () => addDrive();
    $('[data-cancel]', modal).onclick = closeModal;
    const guide = $('[data-guide]', root); if (guide) guide.onclick = () => googleGuide({ back: form, saved: form });
    setTimeout(() => nameIn.focus(), 30);
    root.onsubmit = e => {
      e.preventDefault();
      g.name = nameIn.value.trim();
      const bad = () => { nameIn.classList.remove('bad'); void nameIn.offsetWidth; nameIn.classList.add('bad'); nameIn.focus(); };
      if (!/^[\w-]+$/.test(g.name)) { formError(root, 'Use only letters, numbers, - and _ in the drive name.'); return bad(); }
      if (S.remotes.includes(g.name)) { formError(root, `There is already a remote called “${g.name}” in your rclone config.`); return bad(); }
      if (g.client === 'own' && !S.cfg.google) return googleGuide({ back: form, saved: form });
      const name = g.name, st = g.st;
      oauthSignIn({
        backend: type, client: g.client, title: `Connect ${p.label}`, back: form, accent: st.color,
        save: async id => {
          const r = await oauthApi(id + '/save', { name, create: true });
          try {
            if (r.question) await answerQuestions(name, r.question, st.color);
            await rc('operations/about', { fs: name + ':' });   // checks the drive answers
          } catch (err) { await rc('config/delete', { name }).catch(() => {}); throw err; }
          await patchConfig({ drives: { [name]: st } }).catch(() => {});
          closeModal(); toast(`Added ${name}`, 'ok');
          await loadDrives(); go(name);
        },
      });
    };
  };
  form();
}

// After signing in, some providers need a choice rclone can't make alone (OneDrive: which drive or library
// to use). rclone asks one question at a time; each is shown here, with its suggested answer picked.
async function answerQuestions(name, q, color) {
  for (let n = 0; q && n < 12; n++) {
    const result = await askQuestion(name, q, color);
    if (result === null) throw new Error('The setup was cancelled, so the drive wasn’t added.');
    const r = await api('/_ui/drive-question', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, state: q.state, result }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    q = j.question;
  }
}
function askQuestion(name, q, color) {
  return new Promise(resolve => {
    const bool = q.type === 'bool' || (!q.examples.length && /^(true|false)$/.test(String(q.default)));
    const opts = bool ? [{ value: 'true', help: 'Yes' }, { value: 'false', help: 'No' }] : q.examples;
    let pick = String(q.default ?? '');
    if (opts.length && !opts.some(o => o.value === pick)) pick = opts[0].value;
    // rclone's help can run over several lines; the first is the question, the rest is detail.
    const [lead, ...more] = String(q.help || 'Choose an option').split('\n').filter(Boolean);
    openModal(`${modalHead(`Set up ${name}`, null)}<form class="m-body" id="qForm">
        <p class="m-text"><b>${esc(lead)}</b></p>${more.length ? `<p class="m-text mute q-more">${esc(more.join(' '))}</p>` : ''}
        ${q.error ? `<div class="form-err">${ico('alert')}<span>${esc(q.error)}</span></div>` : ''}
        ${opts.length ? `<div class="choices" role="radiogroup" aria-label="${esc(lead)}">${opts.map(o => `<button type="button" class="choice" role="radio" data-v="${esc(o.value)}" aria-checked="${o.value === pick}"><span class="dot"></span>
            <span><b>${esc(o.help || o.value)}</b>${o.help && o.value.length < 40 && o.value !== o.help && !bool ? `<small>${esc(o.value)}</small>` : ''}</span></button>`).join('')}</div>`
          : fieldHtml({ label: 'Answer', value: pick }, 'qIn')}
      </form>
      <div class="m-foot"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit" form="qForm" autofocus>Continue</button></div>`, 'sm');
    accent(modal, color || null);
    let answer = null;
    const list = $('.choices', modal);
    if (list) list.onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; pick = b.dataset.v; $$('[data-v]', list).forEach(x => x.setAttribute('aria-checked', x === b)); };
    // Closing the dialog cancels; an answer keeps it open, showing progress, until the next step paints.
    modal.onclose = () => resolve(null);
    const finish = () => { modal.onclose = null; resolve(answer); };
    $('#qForm', modal).onsubmit = e => {
      e.preventDefault(); answer = list ? pick : $('#qIn', modal).value.trim();
      busy($('[type=submit]', modal), true, 'Saving…'); $('[data-cancel]', modal).disabled = true; finish();
    };
    $('[data-cancel]', modal).onclick = () => { answer = null; finish(); };
  });
}

async function reconnectOAuth(name) {
  const dr = driveOf(name), p = PROVIDERS[dr.type];
  const cfg = await rc('config/get', { name }).catch(() => ({}));
  const ownClient = !!cfg.client_id;
  openModal(`${modalHead(`Reconnect ${name}`, null)}
    <div class="m-body"><p class="m-text">Opens ${esc(p.site)} so you can sign in to this drive again. Use this if ${esc(p.site)} signed it out or it stopped responding.</p>
    ${ownClient || dr.type !== 'drive' ? '' : `<p class="m-text mute">This drive uses rclone’s shared app, and ${SHARED_RETIRING}. To switch it to your own Google app, remove the drive and add it again. Your files stay on Google Drive.</p>`}</div>
    <div class="m-foot"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" id="goGoogle" autofocus>${ico('link')}Continue with ${esc(p.site)}</button></div>`, 'sm');
  $('[data-cancel]', modal).onclick = closeModal;
  $('#goGoogle', modal).onclick = () => oauthSignIn({
    backend: dr.type, client: 'remote', remote: name, ownClient, title: `Reconnect ${name}`, accent: lookOf(name).color,
    save: async id => {
      await oauthApi(id + '/save', { name, create: false });
      await rc('operations/about', { fs: name + ':' });
      closeModal(); toast(`Reconnected ${name}`, 'ok');
      await aboutDrive(dr);
      if (S.sel === name) openDir(name, S.path);
    },
  });
}

// ---------- your own Google app ----------
// A step-by-step guide through Google Cloud Console. Each step opens the right console page; the client ID
// and secret it ends with are saved in ~/.drivedeck/config.json and used for every Google Drive added after.
const GCP = 'https://console.cloud.google.com/';
// In Bangla a step is looked up as one sentence (its key is the text without tags); the bold goes, the chips stay.
const guideText = t => { if (LANG !== 'bn') return t; const bn = window.I18N_BN?.[t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()]; return bn ? esc(bn).replace(/\[\[(.+?)\]\]/g, '[[$1]]') : t; };
const GUIDE = [
  { title: 'Create a project', url: GCP + 'projectcreate', text: 'Sign in with your Google account, name the project [[DriveDeck]] and choose <b>Create</b>. It’s free and doesn’t need a card.' },
  { title: 'Turn on the Google Drive API', url: GCP + 'apis/library/drive.googleapis.com', text: 'Check that your new project is selected at the top of the page, then choose <b>Enable</b>.' },
  { title: 'Set up the sign-in screen', url: GCP + 'auth/overview', text: 'Choose <b>Get started</b>. Name the app [[DriveDeck]] and pick your email. For <b>Audience</b>, choose <b>External</b>. Add your email as the contact, agree to the policy and choose <b>Create</b>.' },
  { title: 'Allow access to Drive', url: GCP + 'auth/scopes', text: 'Choose <b>Add or remove scopes</b>. Under <b>Manually add scopes</b>, paste [[https://www.googleapis.com/auth/drive]], choose <b>Add to table</b>, then <b>Update</b> and <b>Save</b>.' },
  { title: 'Publish the app', url: GCP + 'auth/audience', text: 'Under <b>Publishing status</b>, choose <b>Publish app</b> and confirm. Otherwise Google signs you out every 7 days. Google’s review isn’t needed for an app only you use.' },
  { title: 'Create a client', url: GCP + 'auth/clients/create', text: 'For <b>Application type</b>, choose <b>Desktop app</b>, name it [[DriveDeck]] and choose <b>Create</b>. Copy the client ID and secret into the boxes below, or download the JSON file. Google may not show the secret again.' },
];
const guideSeen = new Set();
const chip = v => `<button type="button" class="chip" data-copy="${esc(v)}" title="Copy">${esc(v)}${ico('copy')}</button>`;

// o: { back, saved } run after Back/Cancel and after saving. Without back, Cancel just closes the modal.
function googleGuide(o = {}) {
  const app = S.cfg.google;
  openModal(`${modalHead('Set up your Google app', 'About 10 minutes, once. Google Drive then signs in with an app only you use.', !!o.back)}
    <form class="m-body" id="guideForm">
      <ol class="guide">
        ${GUIDE.map((s, i) => `<li class="${guideSeen.has(i) ? 'seen' : ''}" data-step="${i}"><div class="guide-head"><b>${esc(s.title)}</b>
          <a class="btn sm" href="${s.url}" target="_blank" rel="noopener" data-open-step="${i}">Open${ico('link')}</a></div>
          <p ${LANG === 'bn' ? 'translate="no"' : ''}>${guideText(s.text).replace(/\[\[(.+?)\]\]/g, (_, v) => chip(v))}</p></li>`).join('')}
        <li class="last"><div class="guide-head"><b>Paste your client here</b>
          <label class="btn sm" title="The client_secret_….json file from step 6">${ico('upload')}Use JSON file<input type="file" id="gFile" accept=".json,application/json" hidden></label></div>
          <div class="form-err" hidden></div>
          ${fieldHtml({ label: 'Client ID', hint: 'from step 6', value: app?.clientId }, 'gId')}
          ${fieldHtml({ label: 'Client secret', hint: 'usually starts with GOCSPX-', value: app?.clientSecret }, 'gSecret')}
        </li>
      </ol>
    </form>
    <div class="m-foot"><span class="left">Saved on this computer only.</span><button class="btn ghost" data-cancel>${o.back ? 'Back' : 'Cancel'}</button><button class="btn primary" type="submit" form="guideForm">Save</button></div>`);
  const root = $('#guideForm', modal), idIn = $('#gId', root), secIn = $('#gSecret', root);
  if (o.back) $('[data-back]', modal).onclick = o.back;
  $('[data-cancel]', modal).onclick = o.back || closeModal;
  root.addEventListener('click', e => {
    const a = e.target.closest('[data-open-step]'); if (!a) return;
    guideSeen.add(+a.dataset.openStep); a.closest('li').classList.add('seen');
  });
  const bad = (el, msg) => { formError(root, msg); el.classList.remove('bad'); void el.offsetWidth; el.classList.add('bad'); el.focus(); };
  $('#gFile', root).onchange = async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      if (j.web) return formError(root, 'This file is for a Web application client. Create a client of type Desktop app instead (step 6).');
      const c = j.installed; if (!c?.client_id) throw new Error();
      idIn.value = c.client_id; secIn.value = c.client_secret || ''; formError(root, '');
      if (!secIn.value) bad(secIn, 'The file has no client secret. Copy it from the client’s page in Google Cloud.');
    } catch (_) { formError(root, 'That doesn’t look like the JSON file Google Cloud gives you for a client.'); }
  };
  root.onsubmit = async e => {
    e.preventDefault();
    const clientId = idIn.value.trim(), clientSecret = secIn.value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) return bad(idIn, /^GOCSPX-/.test(clientId) ? 'That’s the client secret. The client ID ends in .apps.googleusercontent.com.' : 'Paste the client ID from step 6. It ends in .apps.googleusercontent.com.');
    if (!/^[\w-]{10,100}$/.test(clientSecret) || /googleusercontent/.test(clientSecret)) return bad(secIn, 'Paste the client secret from step 6. It usually starts with GOCSPX-.');
    const btn = $('[type=submit]', modal); busy(btn, true, 'Saving');
    try { await patchConfig({ google: { clientId, clientSecret } }); }
    catch (err) { busy(btn, false); return formError(root, err.message); }
    toast('Your Google app is saved', 'ok');
    o.saved ? o.saved() : closeModal();
  };
}

async function removeGoogleApp() {
  const ok = await dialog({
    title: 'Remove your Google app?', ok: 'Remove', danger: true,
    text: 'DriveDeck forgets the client ID and secret. Google Drives you already added keep working, because each drive keeps its own copy. To use the app again later, paste it in again.',
    onSubmit: () => patchConfig({ google: null }),
  });
  if (ok) { toast('Removed your Google app', 'ok'); renderSettings(false); paintCache(); }
}

// ---------- settings ----------
const CACHE_LIMITS = [[250, '250 MB'], [500, '500 MB'], [1024, '1 GB'], [2048, '2 GB'], [5120, '5 GB'], [10240, '10 GB'], [0, 'No limit']].map(([m, l]) => [m * 1024 * 1024, l]);
const NATIVE_NAMES = { drive: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox' };
let cacheInfo = null;
async function showSettings() {
  leaveFolder(); Object.assign(S, { sel: null, page: 'settings' }); S.nav++;
  renderSide(); renderSettings(!UP.showHelp);
  if (UP.showHelp) {
    UP.showHelp = false;
    const sec = $('#uploadsHelp'); sec.scrollIntoView({ block: 'start' }); sec.classList.add('flash');
  }
  loadBackups();
  await refreshCache();
  paintIndex();
}
let indexTimer = null;
async function paintIndex() {
  clearTimeout(indexTimer);
  let j = null;
  try { const r = await api('/_ui/index'); if (r.ok) j = await r.json(); } catch (_) {}
  const el = $('#indexInfo'); if (!el || !j) return;
  const built = j.status.filter(s => s.built), building = j.status.filter(s => s.building), count = j.status.reduce((t, s) => t + s.count, 0);
  el.innerHTML = !indexOn() ? 'Turned off. Searching all drives and finding duplicates need it.'
    : building.length ? `<span class="spin"></span> Indexing ${esc(building.map(s => s.drive).join(', '))}…`
    : built.length ? `${count.toLocaleString()} items on ${nOf(built.length, 'drive')}, ${fmt(j.size)}. Updated ${ago(Math.min(...built.map(s => s.built)))}.` : 'Not built yet.';
  if (building.length && S.page === 'settings') indexTimer = setTimeout(paintIndex, 1500);
}
// ---------- backups ----------
// The list lives in DriveDeck (lib/backups.js); this page shows it, polling while a backup runs.
const BK = { items: [], timer: null };
const EVERY_TEXT = { 0: 'Only when you run it', 1: 'Every hour', 6: 'Every 6 hours', 24: 'Every day' };
const homeDir = () => S.local?.home || '';
const tildePath = p => homeDir() && p.startsWith(homeDir()) ? '~' + p.slice(homeDir().length) : p;
const baseName = p => p.split(/[\\/]/).filter(Boolean).pop() || p;
async function backupApi(path = '', method = 'GET', body) {
  const r = await api('/_ui/backups' + path, { method, ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  BK.items = j.items || [];
  return j;
}
async function loadBackups() {
  if (!S.local) S.local = await api('/_ui/local').then(r => r.json()).catch(() => null);
  try { await backupApi(); } catch (e) { const el = $('#backupList'); if (el) el.innerHTML = `<p class="set-note">${esc(e.message)}</p>`; return; }
  paintBackups();
}
function paintBackups() {
  clearTimeout(BK.timer);
  const el = $('#backupList'); if (!el || S.page !== 'settings') return;
  if (!BK.items.length) { el.innerHTML = `<p class="backups-empty">No backups yet. Add one to keep a copy of a folder, like Documents or Photos, on one of your drives.</p>`; return; }
  el.innerHTML = BK.items.map(b => {
    const [drive, ...rest] = b.dst.split(':'), dir = rest.join(':'), l = b.last, pr = b.progress;
    const when = t => `${fmtDate(t)}${new Date(t).toDateString() === new Date().toDateString() ? '' : ', ' + TIME.format(new Date(t))}`;
    const status = b.state === 'running'
      ? `<div class="bk-run"><div class="bar"><i style="width:${pr?.totalBytes ? pct(pr.bytes, pr.totalBytes) : 0}%"></i></div>
          <span class="num">${!pr ? 'Starting…' : pr.totalFiles ? `Copying ${Math.min(pr.files + 1, pr.totalFiles)} of ${nOf(pr.totalFiles, 'file')}, ${fmt(pr.bytes)} of ${fmt(pr.totalBytes)}` : `Checking what’s changed${pr.checks ? ` (${pr.checks.toLocaleString()} files so far)` : '…'}`}</span></div>`
      : b.paused ? `<p class="bk-last warn">${ico('alert')}<span>Paused: this backup was imported, and its folder ${esc(b.src)} isn’t on this computer. Choose the folder to back up.</span></p>`
      : b.state === 'queued' ? `<p class="bk-last">Waiting for another backup to finish</p>`
      : !l ? `<p class="bk-last">Hasn’t run yet</p>`
      : l.ok ? `<p class="bk-last ok">${ico('check')}<span><span>${when(l.end)}</span><span>: </span><span>${l.files ? `${nOf(l.files, 'file')} copied (${fmt(l.bytes)})` : 'already up to date'}</span>${l.deleted ? `<span>, ${nOf(l.deleted, 'file')} deleted from the backup</span>` : ''}</span></p>`
      : `<p class="bk-last err">${ico('alert')}<span><span>${when(l.end || l.start)}</span><span>: </span><span>${esc(l.error)}</span></span></p>`;
    const next = b.next && b.state === 'idle' ? `Next ${b.next - Date.now() < 60000 ? 'in a moment' : fmtDate(b.next) === fmtDate(Date.now()) ? 'at ' + TIME.format(new Date(b.next)) : 'on ' + fmtDate(b.next) + ', ' + TIME.format(new Date(b.next))}` : '';
    const { color, emoji } = lookOf(drive);
    return `<div class="bk" data-bk="${b.id}">
      <div class="bk-route"><span class="bk-src" title="${esc(b.src)}">${ico('folder')}<span>${esc(tildePath(b.src))}</span></span>${ico('chev-r')}
        <span class="bk-dst"><span class="badge sm" style="--c:${color}">${esc(emoji)}</span><span>${esc(drive)}${dir ? ' / ' + esc(dir) : ''}</span></span></div>
      <div class="bk-meta"><span>${esc(EVERY_TEXT[b.every])}</span>${b.mirror ? '<span>, mirrored</span>' : ''}${next ? `<span>. </span><span>${esc(next)}</span>` : ''}</div>
      ${status}
      <div class="bk-acts">${b.paused ? `<button class="btn sm" data-bkact="edit">${ico('folder')}Choose folder</button>` : b.state === 'idle' ? `<button class="btn sm" data-bkact="run">${ico('refresh')}Back up now</button>` : `<button class="btn sm" data-bkact="stop">${ico('x')}Stop</button>`}
        <button class="icon-btn sm" data-bkact="menu" title="Backup options" aria-haspopup="menu">${ico('more')}</button></div>
    </div>`;
  }).join('');
  if (BK.items.some(b => b.state !== 'idle')) BK.timer = setTimeout(() => backupApi().then(paintBackups).catch(() => {}), 1500);
}
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-bkact]'); if (!btn) return;
  const b = BK.items.find(x => x.id === btn.closest('[data-bk]').dataset.bk); if (!b) return;
  const act = btn.dataset.bkact;
  if (act === 'edit') editBackup(b);
  if (act === 'run' || act === 'stop') backupApi(`/${b.id}/${act}`, 'POST').then(paintBackups).catch(err => toast(err.message, 'err'));
  if (act === 'menu') menu(btn, [
    { icon: 'pencil', label: 'Edit', run: () => editBackup(b) },
    { icon: 'folder', label: `Open in ${b.dst.split(':')[0]}`, run: () => go(b.dst.split(':')[0], b.dst.split(':').slice(1).join(':')) },
    '-',
    { icon: 'trash', label: 'Remove backup', hint: 'Files already backed up stay on the drive', danger: true, run: () => removeBackup(b) },
  ]);
});
async function removeBackup(b) {
  const ok = await dialog({ title: 'Remove this backup?', text: `DriveDeck stops backing up ${tildePath(b.src)}. Files already backed up stay in ${b.dst.replace(':', ' / ')}.`, ok: 'Remove backup', danger: true,
    onSubmit: () => backupApi('/' + b.id, 'DELETE') });
  if (ok) { toast('Removed the backup', 'ok'); paintBackups(); }
}
// The editor. Choosing a folder opens a picker in the same dialog, which comes back here when done.
function editBackup(b = null, draft = null) {
  const drives = S.drives.filter(d => !d.err);
  const g = draft || (b ? { src: b.paused ? '' : b.src, drive: b.dst.split(':')[0], dir: b.dst.split(':').slice(1).join(':'), every: b.every, mirror: b.mirror }
    : { src: '', drive: (drives.find(d => d.name === S.sel) || drives.slice().sort((x, y) => (y.free ?? -1) - (x.free ?? -1))[0])?.name, dir: '', every: 24, mirror: false, autoDir: true });
  const paint = () => {
    openModal(`${modalHead(b ? 'Edit backup' : 'Add a backup', null)}<form class="m-body" id="bkForm">
        <div class="form-err" hidden></div>
        <div class="field"><span>Folder on this computer</span></div>
        <button type="button" class="pickbox ${g.src ? '' : 'empty'}" data-pick="src">${ico('folder')}<span>${g.src ? esc(tildePath(g.src)) : 'Choose a folder…'}</span>${ico('chev-r')}</button>
        <div class="field"><span>Back up to</span></div>
        <button type="button" class="pickbox" data-pick="dst"><span class="badge sm" style="--c:${lookOf(g.drive).color}">${esc(lookOf(g.drive).emoji)}</span><span>${esc(g.drive)}${g.dir ? ' / ' + esc(g.dir) : ' (top folder)'}</span>${ico('chev-r')}</button>
        <div class="field"><span>How often</span></div>
        <div class="seg text wide" role="radiogroup" aria-label="How often" style="--n:4;--i:${[0, 1, 6, 24].indexOf(g.every)}">${[[0, 'When I ask'], [1, 'Hourly'], [6, 'Every 6 hours'], [24, 'Daily']].map(([v, l]) => `<button type="button" role="radio" data-every="${v}" aria-checked="${g.every === v}">${l}</button>`).join('')}</div>
        <div class="set-row slim"><div><b>Mirror</b><p>Also delete from the backup what you delete from this folder, so the two always match.</p></div>
          <button type="button" class="switch" role="switch" aria-checked="${g.mirror}" id="bkMirror" aria-label="Mirror"><i></i></button></div>
        <p class="set-note warn" id="bkWarn" ${g.mirror ? '' : 'hidden'}>${ico('alert')}<span>Deleting something here deletes it from the backup at the next run, so a mistake can’t be undone from the backup. Without mirroring, nothing in the backup is ever deleted.</span></p>
      </form>
      <div class="m-foot"><span class="left">Runs only while DriveDeck is running.</span><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit" form="bkForm">${b ? 'Save' : `${ico('refresh')}Save and back up now`}</button></div>`);
    const form = $('#bkForm', modal);
    $('[data-cancel]', modal).onclick = closeModal;
    $('[data-pick=src]', modal).onclick = () => folderPicker({ title: 'Choose a folder to back up', local: true, start: g.src || homeDir(), back: paint,
      done: p => { g.src = p; if (g.autoDir) g.dir = 'Backups/' + baseName(p); paint(); } });
    $('[data-pick=dst]', modal).onclick = () => folderPicker({ title: 'Choose where to back up to', drive: g.drive, start: g.dir, back: paint, suggest: g.src ? baseName(g.src) : '',
      done: (p, drive) => { g.drive = drive; g.dir = p; g.autoDir = false; paint(); } });
    const seg = $('.seg', form);
    seg.onclick = e => { const x = e.target.closest('[data-every]'); if (!x) return; g.every = +x.dataset.every; seg.style.setProperty('--i', [0, 1, 6, 24].indexOf(g.every)); $$('[data-every]', seg).forEach(y => y.setAttribute('aria-checked', y === x)); };
    $('#bkMirror', modal).onclick = e => { g.mirror = !g.mirror; e.currentTarget.setAttribute('aria-checked', g.mirror); $('#bkWarn', modal).hidden = !g.mirror; };
    form.onsubmit = async e => {
      e.preventDefault();
      if (!g.src) return formError(form, 'Choose the folder on this computer to back up.');
      const btn = $('[type=submit]', modal); busy(btn, true, 'Saving…');
      try {
        const body = { src: g.src, dst: `${g.drive}:${g.dir}`, every: g.every, mirror: g.mirror };
        if (b) await backupApi('/' + b.id, 'PATCH', body);
        else { const before = new Set(BK.items.map(x => x.id)); await backupApi('', 'POST', body); const added = BK.items.find(x => !before.has(x.id)); if (added) await backupApi(`/${added.id}/run`, 'POST'); }
        closeModal(); toast(b ? 'Saved the backup' : 'Backing up now. You can keep using DriveDeck.', 'ok'); paintBackups();
      } catch (err) { busy(btn, false); formError(form, err.message); }
    };
  };
  paint();
}
// Picks a folder on this computer (local) or on a drive. Folders can be created on a drive as you go.
function folderPicker(o) {
  const st = { path: o.start || '', drive: o.drive, data: null, err: null };
  const crumbs = () => {
    if (o.local) {
      const sep = st.data?.sep || '/', parts = (st.data?.path || '').split(sep).filter(Boolean);
      const root = st.data?.path?.startsWith(sep) ? sep : (parts.shift() || '') + sep;
      const steps = [[root, root]]; parts.forEach((x, i) => steps.push([x, root + parts.slice(0, i + 1).join(sep)]));
      return steps.map(([label, path]) => `<button type="button" class="crumb" data-go="${esc(path)}">${esc(label)}</button>`).join(ico('chev-r'));
    }
    const parts = st.path.split('/').filter(Boolean);
    return [`<button type="button" class="crumb" data-go="">${esc(st.drive)}</button>`, ...parts.map((x, i) => `<button type="button" class="crumb" data-go="${esc(parts.slice(0, i + 1).join('/'))}">${esc(x)}</button>`)].join(ico('chev-r'));
  };
  const load = async () => {
    st.data = null; st.err = null; paint();
    try {
      if (o.local) { st.data = await api('/_ui/local?path=' + enc(st.path)).then(r => r.json()); st.path = st.data.path; st.err = st.data.error; }
      else {
        const l = await rc('operations/list', { fs: st.drive + ':', remote: st.path, opt: { dirsOnly: true } }).catch(e => { if (/not found/i.test(e.message)) return { list: [], missing: true }; throw e; });
        st.data = { dirs: l.list.map(f => f.Name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })), missing: l.missing };
      }
    } catch (e) { st.data = { dirs: [] }; st.err = e.message; }
    paint();
  };
  const paint = () => {
    const d = st.data;
    openModal(`${modalHead(o.title, null, true)}<div class="m-body picker-body">
        ${o.local ? `<div class="pk-drives">${[['Home', homeDir()], ...(S.local?.roots || []).map(r => [r, r])].map(([l, p]) => `<button type="button" class="pk-drive" aria-pressed="${st.path === p}" data-go="${esc(p)}">${esc(l)}</button>`).join('')}</div>`
          : `<div class="pk-drives">${S.drives.filter(x => !x.err).map(x => `<button type="button" class="pk-drive" aria-pressed="${x.name === st.drive}" style="--c:${lookOf(x.name).color}" data-drive="${esc(x.name)}"><span class="badge xs" style="--c:${lookOf(x.name).color}">${esc(lookOf(x.name).emoji)}</span>${esc(x.name)}</button>`).join('')}</div>`}
        <div class="pk-crumbs">${crumbs()}</div>
        <div class="pk-list">${!d ? '<div class="pk-wait"><span class="spin"></span></div>'
          : st.err ? `<p class="pk-empty">${esc(st.err)}</p>`
          : d.missing ? `<p class="pk-empty">This folder doesn’t exist yet. It’s created when the first backup runs.</p>`
          : d.dirs.length ? d.dirs.map(n => `<button type="button" class="pk-row" data-into="${esc(n)}">${ico('folder')}<span>${esc(n)}</span>${ico('chev-r')}</button>`).join('')
          : `<p class="pk-empty">No folders in here.</p>`}</div>
        ${o.local ? '' : `<div class="pk-new"><input class="input" id="pkNew" placeholder="New folder name" value="${esc(o.suggest && !d?.dirs?.includes(o.suggest) ? o.suggest : '')}" spellcheck="false"><button type="button" class="btn" data-new>${ico('folder-plus')}Use new folder</button></div>`}
      </div>
      <div class="m-foot"><span class="left pick-sel" title="${esc(st.path)}">${esc(o.local ? tildePath(st.path) : `${st.drive}${st.path ? ' / ' + st.path : ''}`)}</span><button class="btn ghost" data-back2>Back</button><button class="btn primary" data-choose ${st.err ? 'disabled' : ''}>Choose this folder</button></div>`);
    const body = $('.picker-body', modal);
    body.onclick = e => {
      const goTo = e.target.closest('[data-go]'), into = e.target.closest('[data-into]'), dr = e.target.closest('[data-drive]');
      if (goTo) { st.path = goTo.dataset.go; load(); }
      else if (into) { st.path = o.local ? (st.data.path.endsWith(st.data.sep) ? st.data.path : st.data.path + st.data.sep) + into.dataset.into : [st.path, into.dataset.into].filter(Boolean).join('/'); load(); }
      else if (dr) { st.drive = dr.dataset.drive; st.path = ''; load(); }
    };
    const nb = $('[data-new]', modal);
    if (nb) nb.onclick = () => { const n = $('#pkNew', modal).value.trim(); if (!n || /[\/\\]/.test(n)) return $('#pkNew', modal).focus(); o.done([st.path, n].filter(Boolean).join('/'), st.drive); };
    $('[data-back]', modal).onclick = $('[data-back2]', modal).onclick = () => o.back();
    $('[data-choose]', modal).onclick = () => o.done(st.path, st.drive);
  };
  load();
}

async function clearIndex() {
  const ok = await dialog({ title: 'Clear the search index?', text: 'DriveDeck builds it again in the background, which lists every file on your drives once more.', ok: 'Clear index', danger: true,
    onSubmit: async () => { await api('/_ui/index', { method: 'DELETE' }); } });
  if (ok) { toast('Search index cleared', 'ok'); if (indexOn()) sendDrivesToIndex(); paintIndex(); }
}
async function refreshCache() {
  try { const r = await api('/_ui/cache'); if (r.ok) cacheInfo = await r.json(); } catch (_) {}
  paintCache();
}
function paintCache() {
  const box = $('#cacheBox'); if (!box || !cacheInfo) return;
  const { bytes, files, max } = cacheInfo;
  box.innerHTML = `<div class="cache-num num">${fmt(bytes)}<small>${max ? `of ${fmt(max)}` : 'used, no limit'}</small></div>
    <div class="mute num">${files.toLocaleString()} thumbnail${files === 1 ? '' : 's'}</div>
    ${max ? `<div class="bar lg"><i data-k="cache" data-w="${pct(bytes, max)}"></i></div>` : ''}`;
  growBars(box);
  $('[data-act=clear-cache]', main)?.toggleAttribute('disabled', !files);
}
// ---------- setup files ----------
// Everything DriveDeck needs on another computer in one password-locked file (lib/setup-file.js). Export
// chooses what goes in. Import opens the file, shows what's inside to choose from, then reloads the page;
// the home screen then checks each imported drive and offers Reconnect for any whose sign-in didn't carry over.
const SF_KEY = 'drivedeck-imported';
const typeLabel = t => PROVIDERS[t]?.label || `rclone remote (${t})`;
async function sfApi(path, body) {
  const r = await api('/_ui/setup-file/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok && path === 'export') return r;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
// Drives with the ones stored in them (encrypted folders) right after, one level in.
function nestDrives(list) {
  const names = new Set(list.map(d => d.name)), out = [];
  const add = (d, depth) => { if (depth > 8 || out.includes(d)) return; out.push(Object.assign(d, { depth })); list.filter(c => c.parent === d.name).forEach(c => add(c, depth + 1)); };
  list.filter(d => !d.parent || !names.has(d.parent)).forEach(d => add(d, 0));
  return out;
}
// A row with a checkbox. extra goes under the name (a note, or the choice for a name that's taken).
const sfRow = ({ key, on = true, disabled = false, badge = '', title, sub = '', extra = '', depth = 0, keep = false }) => `
  <div class="sf-row ${disabled ? 'off' : ''}" style="--depth:${depth}">
    <label><input type="checkbox" data-sf="${esc(key)}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${badge}
      <span class="sf-main"><b ${keep ? 'translate="no"' : ''}>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span></label>${extra}</div>`;
const driveBadge = (name, look) => { const l = look || lookOf(name); return `<span class="badge sm" style="--c:${esc(l.color)}">${esc(l.emoji)}</span>`; };
// Checking a drive checks the drive it's stored in; unchecking a drive unchecks what's stored in it.
function wireNesting(root, rows) {
  root.addEventListener('change', e => {
    const box = e.target.closest('input[data-sf]'); if (!box) return;
    const row = rows.find(d => 'd:' + d.name === box.dataset.sf); if (!row) return;
    const set = (name, v) => { const b = $(`input[data-sf="${CSS.escape('d:' + name)}"]`, root); if (b && !b.disabled) b.checked = v; };
    if (box.checked) for (let p = row.parent, i = 0; p && i < 9; p = rows.find(d => d.name === p)?.parent, i++) set(p, true);
    else { const drop = n => rows.filter(d => d.parent === n).forEach(d => { set(d.name, false); drop(d.name); }); drop(row.name); }
  });
}
const checkPasswords = (form, a, b) => {
  const bad = (el, msg) => { formError(form, msg); el.classList.remove('bad'); void el.offsetWidth; el.classList.add('bad'); el.focus(); return false; };
  if (a.value.length < 10) return bad(a, 'Use a password of at least 10 characters.');
  if (b && a.value !== b.value) return bad(b, 'The two passwords don’t match.');
  return true;
};

async function exportSetup() {
  let dump;
  try { dump = await rc('config/dump'); } catch (e) { return toast(e.message, 'err'); }
  await backupApi().catch(() => {});
  const parentIn = n => { const m = /^([^:/\\]{1,64}):/.exec(String(dump[n].remote || '')); return m && dump[m[1]] ? m[1] : null; };
  const rows = nestDrives(Object.keys(dump).map(n => ({ name: n, type: dump[n].type, parent: parentIn(n) })));
  if (!rows.length) return toast('Add a drive first. There’s nothing to export yet.', 'err');
  openModal(`${modalHead('Export setup', 'Save your drives and settings in one file, to set up DriveDeck on another computer')}
    <form class="m-body" id="sfForm" autocomplete="off">
      <div class="form-err" hidden></div>
      <div class="field"><span>Drives and their sign-ins</span></div>
      <div class="sf-list">${rows.map(d => sfRow({ key: 'd:' + d.name, badge: driveBadge(d.name), title: d.name, keep: true, depth: d.depth,
        sub: d.type === 'crypt' ? `Encrypted folder, with its password` : typeLabel(d.type) })).join('')}</div>
      <div class="field"><span>Also include</span></div>
      <div class="sf-list">
        ${sfRow({ key: 'settings', title: 'Settings', sub: 'Theme, language, thumbnails and search' })}
        ${S.cfg.google ? sfRow({ key: 'google', title: 'Your Google app', sub: 'For adding more Google Drives' }) : ''}
        ${sfRow({ key: 'backups', title: 'Backups', sub: '', disabled: !BK.items.length, on: !!BK.items.length })}
      </div>
      ${fieldHtml({ label: 'Password for the file', type: 'password', hint: 'at least 10 characters' }, 'sfPass')}
      ${fieldHtml({ label: 'Password again', type: 'password' }, 'sfPass2')}
      <p class="set-note warn">${ico('alert')}<span>This file holds the sign-ins to every drive in it, so anyone with the file and its password can open those accounts. Don’t send the two together. If you forget the password, the file can’t be opened: export a new one.</span></p>
    </form>
    <div class="m-foot"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit" form="sfForm">${ico('download')}Export</button></div>`);
  const form = $('#sfForm', modal);
  $('[data-cancel]', modal).onclick = closeModal;
  wireNesting(form, rows);
  const chosen = () => rows.filter(d => $(`input[data-sf="${CSS.escape('d:' + d.name)}"]`, form).checked).map(d => d.name);
  const paintCount = () => {
    const names = new Set(chosen()), n = BK.items.filter(b => names.has(b.dst.split(':')[0])).length;
    const box = $('input[data-sf=backups]', form), sub = box.closest('label').querySelector('.sf-main > span') || box.closest('label').querySelector('.sf-main').appendChild(document.createElement('span'));
    sub.textContent = !BK.items.length ? 'No backups set up' : n ? `Backs up ${nOf(n, 'folder')} on this computer` : 'None of your backups go to the drives chosen above';
    if (box.disabled && n) box.checked = true;   // back on once a backup's drive is chosen again
    box.disabled = !n; if (!n) box.checked = false;
    box.closest('.sf-row').classList.toggle('off', !n);
  };
  form.addEventListener('change', paintCount); paintCount();
  setTimeout(() => $('#sfPass', modal).focus(), 30);
  form.onsubmit = async e => {
    e.preventDefault();
    const drives = chosen();
    if (!drives.length) return formError(form, 'Choose at least one drive to export.');
    if (!checkPasswords(form, $('#sfPass', modal), $('#sfPass2', modal))) return;
    formError(form, '');
    const btn = $('[type=submit]', modal); busy(btn, true, 'Encrypting…');
    try {
      const opt = k => !!$(`input[data-sf=${k}]`, form)?.checked;
      const r = await sfApi('export', { password: $('#sfPass', modal).value, drives, settings: opt('settings'), google: opt('google'), backups: opt('backups') });
      const file = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'drivedeck-setup.drivedeck';
      const url = URL.createObjectURL(await r.blob()), a = document.createElement('a');
      a.href = url; a.download = file; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      closeModal(); toast(`Saved ${file} to your downloads`, 'ok');
    } catch (err) { busy(btn, false); formError(form, err.message); }
  };
}

function importSetup() {
  let text = '';
  openModal(`${modalHead('Import setup', 'Set up drives from a file exported with DriveDeck on another computer')}
    <form class="m-body" id="sfOpen" autocomplete="off">
      <div class="form-err" hidden></div>
      <div class="field"><span>Setup file</span></div>
      <label class="pickbox empty" id="sfBox" tabindex="0">${ico('file')}<span>Choose a file, or drop it here…</span>${ico('chev-r')}<input type="file" id="sfFile" accept=".drivedeck,application/json" hidden></label>
      ${fieldHtml({ label: 'Password', type: 'password' }, 'sfPass')}
      <p class="set-note">${ico('lock')}<span>Nothing changes yet. Next, you choose what to import.</span></p>
    </form>
    <div class="m-foot"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit" form="sfOpen">Open</button></div>`, 'sm');
  const form = $('#sfOpen', modal), box = $('#sfBox', modal);
  $('[data-cancel]', modal).onclick = closeModal;
  const take = async f => {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return formError(form, 'This file is too big to be a DriveDeck setup file.');
    text = await f.text(); formError(form, '');
    box.classList.remove('empty'); box.querySelector('span').textContent = f.name;
    $('#sfPass', modal).focus();
  };
  $('#sfFile', modal).onchange = e => take(e.target.files[0]);
  box.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#sfFile', modal).click(); } };
  form.ondragover = e => { e.preventDefault(); box.classList.add('drop'); };
  form.ondragleave = () => box.classList.remove('drop');
  form.ondrop = e => { e.preventDefault(); box.classList.remove('drop'); take(e.dataTransfer.files[0]); };
  setTimeout(() => box.focus(), 30);
  form.onsubmit = async e => {
    e.preventDefault();
    if (!text) return formError(form, 'Choose the setup file first.');
    if (!$('#sfPass', modal).value) return checkPasswords(form, $('#sfPass', modal));
    const btn = $('[type=submit]', modal); busy(btn, true, 'Unlocking…');
    try { importChoices(await sfApi('open', { file: text, password: $('#sfPass', modal).value })); }
    catch (err) { busy(btn, false); formError(form, err.message); }
  };
}

const HOW_TEXT = { both: n => `Add it as ${n}-2`, replace: () => 'Replace the one here' };
function importChoices(pv) {
  let started = false;
  const rows = nestDrives(pv.drives.map(d => ({ ...d })));
  const drivesHtml = rows.map(d => {
    const same = d.here === 'same', clash = !!d.here && !same;
    const extra = clash ? `<div class="sf-clash"><span>Another drive called ${esc(d.name)} is already here.</span>
        <label class="select-wrap"><select class="input sm" data-how="${esc(d.name)}" aria-label="What to do with ${esc(d.name)}">${Object.entries(HOW_TEXT).map(([v, t]) => `<option value="${v}">${esc(t(d.name))}</option>`).join('')}</select>${ico('chev-d')}</label></div>` : '';
    if (d.runsCommand) return sfRow({ key: 'd:' + d.name, badge: driveBadge(d.name, d.look), title: d.name, keep: true, depth: d.depth, on: false, disabled: true,
      sub: 'Runs a program on this computer, so it can’t be imported. Add it with rclone config.' });
    return sfRow({ key: 'd:' + d.name, badge: driveBadge(d.name, d.look), title: d.name, keep: true, depth: d.depth, on: !same, disabled: same, extra,
      sub: same ? 'Already here' : d.type === 'crypt' ? 'Encrypted folder' : typeLabel(d.type) });
  }).join('');
  const bk = pv.backups;
  const bkHtml = bk.length ? `<ul class="sf-bk">${bk.map(b => `<li><span translate="no">${esc(b.here ? tildePath(b.here) : b.src)}</span> ${ico('chev-r')} <span translate="no">${esc(b.dst.replace(':', ' / '))}</span>
      ${b.here ? '' : `<em>Folder not found on this computer. It’s added paused until you choose it.</em>`}</li>`).join('')}</ul>` : '';
  const when = pv.created ? DATE_Y.format(new Date(pv.created)) : '';
  openModal(`${modalHead('Import setup', [when && `Exported ${when}`, pv.made?.host && `from ${pv.made.host}`].filter(Boolean).join(' ') || null)}
    <form class="m-body" id="sfForm">
      <div class="form-err" hidden></div>
      <div class="field"><span>Drives</span></div>
      <div class="sf-list">${drivesHtml}</div>
      ${pv.settings || pv.google || bk.length ? `<div class="field"><span>Also import</span></div><div class="sf-list">
        ${pv.settings ? sfRow({ key: 'settings', title: 'Settings', sub: 'Theme, language, thumbnails and search. Replaces these settings here.' }) : ''}
        ${pv.google ? sfRow({ key: 'google', title: 'Your Google app', sub: pv.google.differs ? 'Replaces the Google app set up here' : 'For adding more Google Drives', on: !pv.google.differs }) : ''}
        ${bk.length ? sfRow({ key: 'backups', title: 'Backups', sub: nOf(bk.length, 'backup'), extra: bkHtml }) : ''}</div>` : ''}
      <p class="set-note">${ico('link')}<span>Sign-ins are copied as they are, without signing in again. Afterwards DriveDeck checks each drive, and you can reconnect any that need it.</span></p>
    </form>
    <div class="m-foot"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit" form="sfForm">Import</button></div>`);
  const form = $('#sfForm', modal);
  modal.onclose = () => { if (!started) sfApi('close', { id: pv.id }).catch(() => {}); };
  $('[data-cancel]', modal).onclick = closeModal;
  wireNesting(form, rows);
  const paint = () => {
    const n = rows.filter(d => $(`input[data-sf="${CSS.escape('d:' + d.name)}"]`, form).checked).length;
    $('[type=submit]', modal).textContent = n ? `Import ${nOf(n, 'drive')}` : 'Import';
    $$('.sf-clash', form).forEach(el => { el.hidden = !el.closest('.sf-row').querySelector('input').checked; });
  };
  form.addEventListener('change', paint); paint();
  form.onsubmit = async e => {
    e.preventDefault();
    const opt = k => !!$(`input[data-sf=${k}]`, form)?.checked;
    const drives = Object.fromEntries(rows.filter(d => $(`input[data-sf="${CSS.escape('d:' + d.name)}"]`, form).checked)
      .map(d => [d.name, $(`select[data-how="${CSS.escape(d.name)}"]`, form)?.value || 'add']));
    if (!Object.keys(drives).length && !opt('settings') && !opt('google') && !opt('backups')) return formError(form, 'Choose something to import.');
    const btn = $('[type=submit]', modal); busy(btn, true, 'Importing…'); started = true;
    try {
      const r = await sfApi('import', { id: pv.id, drives, settings: opt('settings'), google: opt('google'), backups: opt('backups') });
      // The page reloads to pick up the new settings and language; the home screen then shows how it went.
      try { sessionStorage.setItem(SF_KEY, JSON.stringify({ at: Date.now(), names: r.added.map(x => x.name), skipped: r.skipped, paused: r.backups.paused, backups: r.backups.added })); } catch (_) {}
      location.href = '/';
    } catch (err) { started = false; busy(btn, false); formError(form, err.message); }
  };
}

// What the last import did, on the home screen until dismissed: each imported drive's connection, with
// Reconnect for the ones that can't connect.
let IMPORTED = (() => { try { const v = JSON.parse(sessionStorage.getItem(SF_KEY)); return v && Date.now() - v.at < 864e5 ? v : null; } catch (_) { return null; } })();
function importNote() {
  if (!IMPORTED) return '';
  const shown = IMPORTED.names.map(driveOf).filter(Boolean), drives = shown.filter(d => d.type !== 'crypt');
  const bad = drives.filter(d => d.err), wait = drives.filter(d => !d.err && (d.pending || checking(d)));
  const n = shown.length, skipped = (IMPORTED.skipped || []).filter(s => s.why !== 'already here');
  const head = !n ? 'Imported your setup'
    : wait.length ? `Imported ${nOf(n, 'drive')}. Checking the connection to ${wait.length === 1 ? wait[0].name : nOf(wait.length, 'drive')}…`
    : bad.length ? `${bad.length === 1 ? `${bad[0].name} can’t connect` : `${bad.length} imported drives can’t connect`}`
    : `Imported ${nOf(n, 'drive')}, and ${n === 1 ? 'it’s' : 'all are'} connected`;
  const kind = bad.length && !wait.length ? 'warn' : !wait.length ? 'ok' : '';
  return `<div class="import-note ${kind}" role="status">${wait.length ? '<span class="spin"></span>' : ico(bad.length ? 'alert' : 'check')}<div>
      <b>${esc(head)}</b>
      ${bad.length && !wait.length ? `<p>The sign-in didn’t carry over, or the provider signed the other computer out. Reconnecting signs in again. Your files aren’t affected.</p>
        <ul class="import-bad">${bad.map(d => `<li>${driveBadge(d.name)}<b translate="no">${esc(d.name)}</b><span>${esc(PROVIDERS[d.type].label)}</span><button class="btn sm" data-act="sf-reconnect" data-name="${esc(d.name)}">${ico('link')}Reconnect</button></li>`).join('')}</ul>` : ''}
      ${skipped.length ? `<p><span>Not imported:</span> ${skipped.map(s => `<span translate="no">${esc(s.name)}</span> (<span>${esc(s.why)}</span>)`).join(', ')}</p>` : ''}
      ${IMPORTED.paused ? `<p>${IMPORTED.paused === 1 ? 'One imported backup is' : `${IMPORTED.paused} imported backups are`} paused until you choose ${IMPORTED.paused === 1 ? 'its folder' : 'their folders'} on this computer. <button class="link" data-act="sf-backups">Choose in Settings</button></p>` : ''}
    </div><button class="icon-btn sm" data-act="sf-dismiss" title="Dismiss">${ico('x')}</button></div>`;
}
function dismissImport() {
  try { sessionStorage.removeItem(SF_KEY); } catch (_) {}
  IMPORTED = null;
  renderHome(false);
}

function renderSettings(anim) {
  const main = $('#main'); accent(main, null);
  const f = S.features, auto = autoThumbs(), max = S.cfg.prefs.cacheMax ?? 1024 * 1024 * 1024;
  const native = (f.nativeThumbs || []).map(t => NATIVE_NAMES[t] || t);
  const tools = f.ffmpeg ? 'ffmpeg is installed, so both photos and videos get thumbnails.'
    : f.sips ? 'ffmpeg isn’t installed. Photos still get thumbnails using macOS, but videos need ffmpeg.'
    : 'ffmpeg isn’t installed, so photos and videos are shown from the original files where the browser can.';
  const ab = S.about || {};
  const themes = [['auto', 'Match system'], ['light', 'Light'], ['dark', 'Dark']];
  main.innerHTML = `<div class="toolbar"><button class="icon-btn menu-btn" data-act="drawer" title="Drives">${ico('menu')}</button>
    <div class="crumbs"><span class="crumb">Settings</span></div></div>
    <div class="content ${anim ? 'enter' : ''}" id="content"><div class="settings">
    <section>
      <h2>Thumbnails</h2>
      <div class="set-row">
        <div><b>Make thumbnails on this computer</b><p>When a drive doesn’t provide thumbnails itself, DriveDeck reads part of each photo or video to make one. Turn this off to save bandwidth. Those files then show an icon instead.</p></div>
        <button class="switch" role="switch" aria-checked="${auto}" data-set="thumbs" aria-label="Make thumbnails on this computer"><i></i></button>
      </div>
      <div class="set-row"><div><b>Thumbnails from your provider</b><p>${esc(native.join(', ').replace(/, ([^,]*)$/, ' and $1'))} supply their own thumbnails, so DriveDeck always uses those first. MEGA doesn’t share its thumbnails with rclone, so MEGA drives depend on the setting above.</p></div></div>
      <div class="set-row ${auto ? '' : 'off'}" id="toolsRow"><div><b>Thumbnail tools</b><p>${tools}</p></div>${f.ffmpeg ? '' : `<button class="btn" data-act="setup">${ico('download')}Install ffmpeg</button>`}</div>
    </section>
    <section>
      <h2>Thumbnail cache</h2>
      <div class="cache" id="cacheBox"><div class="skel" style="height:30px;width:120px"></div></div>
      <div class="set-row"><div><b>Maximum size</b><p>When the cache is full, the thumbnails you haven’t looked at for the longest are removed first.</p></div>
        <label class="select-wrap"><select class="input" data-set="cacheMax" aria-label="Maximum cache size">${CACHE_LIMITS.map(([v, l]) => `<option value="${v}" ${v === max ? 'selected' : ''}>${l}</option>`).join('')}</select>${ico('chev-d')}</label></div>
      <div class="set-row"><div><b>Clear cache</b><p>Frees the space now. Thumbnails are made again as you browse, which takes time and downloads part of each file again.</p></div>
        <button class="btn" data-act="clear-cache">${ico('trash')}Clear cache</button></div>
      <p class="set-note">${ico('alert')}<span>Thumbnails are stored unencrypted on this computer, including ones from end-to-end encrypted drives like MEGA.</span></p>
    </section>
    <section id="searchSet">
      <h2>Search</h2>
      <div class="set-row"><div><b>Keep a search index</b><p>A list of the names of every file on your drives, so searching all drives and finding duplicates is instant. It’s stored unencrypted on this computer and kept up to date in the background.</p></div>
        <button class="switch" role="switch" aria-checked="${indexOn()}" data-set="index" aria-label="Keep a search index"><i></i></button></div>
      <div class="set-row ${indexOn() ? '' : 'off'}" id="indexRow"><div><b>Index</b><p id="indexInfo">…</p></div>
        <div class="set-acts"><button class="btn ghost" data-act="index-clear">Clear</button><button class="btn" data-act="index-refresh">${ico('refresh')}Update now</button></div></div>
    </section>
    <section id="backupSet">
      <h2>Backups</h2>
      <p class="set-intro">Copy folders from this computer to a drive, when you ask or on a schedule. Backups only add and update files unless you choose to mirror, and they run while DriveDeck is running.</p>
      <div id="backupList" class="backups"><div class="skel" style="height:64px;border-radius:12px"></div></div>
      <div class="set-acts left"><button class="btn" data-act="backup-add" ${S.drives.some(d => !d.err) ? '' : 'disabled title="Add a drive first"'}>${ico('plus')}Add a backup</button></div>
    </section>
    <section id="setupFileSet">
      <h2>Move to another computer</h2>
      <p class="set-intro">Save your drives with their sign-ins, colors, settings and backups in one file locked with a password. Import it into DriveDeck on another computer to set everything up there at once.</p>
      <div class="set-row"><div><b>Export setup</b><p>Saves a file you can copy to the other computer, on a USB stick for example.</p></div>
        <button class="btn" data-act="sf-export">${ico('download')}Export…</button></div>
      <div class="set-row"><div><b>Import setup</b><p>Adds the drives from a setup file. You choose what to import, and drives already here are kept.</p></div>
        <button class="btn" data-act="sf-import">${ico('upload')}Import…</button></div>
    </section>
    <section id="uploadsHelp">
      <h2>Uploads</h2>
      <ol class="set-steps">
        <li><b>Sending to DriveDeck.</b> Your browser copies each file to DriveDeck on this computer. Keep the tab open until this part finishes. It’s usually quick.</li>
        <li><b>Uploading to your drive.</b> DriveDeck then uploads the file in the background. You can close the tab; open DriveDeck again to check on progress.</li>
      </ol>
      <p class="set-note">${ico('alert')}<span>Uploads stop if you quit DriveDeck (Ctrl+C or closing its terminal), and may fail if your computer sleeps. Files that didn’t finish need to be uploaded again.</span></p>
      <dl class="about"><dt>Files waiting to upload</dt><dd><code>${esc(ab.uploads || '–')}</code> (deleted once uploaded)</dd></dl>
    </section>
    <section id="googleApp">
      <h2>Google Drive</h2>
      <div class="set-row"><div><b>Your Google app</b><p>${S.cfg.google
        ? `Google Drives you add sign in with your app <code title="${esc(S.cfg.google.clientId)}">${esc(shortClient(S.cfg.google.clientId))}</code>. Drives you already added keep the app they were added with.`
        : `Not set up yet. Set it up so Google Drive doesn’t depend on rclone’s shared app, which rclone is retiring during 2026.`}</p></div>
        <div class="set-acts">${S.cfg.google ? `<button class="btn ghost" data-act="google-remove">Remove</button>` : ''}<button class="btn" data-act="google-app">${ico('settings')}${S.cfg.google ? 'Change' : 'Set up'}</button></div></div>
    </section>
    <section>
      <h2>Appearance</h2>
      <div class="set-row"><div><b>Language</b><p>Bangla is a first translation and may read awkwardly in places.</p></div>
        <div class="seg text" role="radiogroup" aria-label="Language" translate="no" style="--n:2;--i:${LANG === 'bn' ? 1 : 0}"><button role="radio" data-lang-opt="en" aria-checked="${LANG === 'en'}" lang="en">English</button><button role="radio" data-lang-opt="bn" aria-checked="${LANG === 'bn'}" lang="bn">বাংলা</button></div></div>
      <div class="set-row"><div><b>Theme</b></div>
        <div class="seg text" role="radiogroup" aria-label="Theme" style="--n:3;--i:${themes.findIndex(t => t[0] === S.theme)}">${themes.map(([v, l]) => `<button role="radio" data-theme-opt="${v}" aria-checked="${S.theme === v}">${l}</button>`).join('')}</div></div>
    </section>
    <section>
      <h2>About</h2>
      <dl class="about">
        <dt>rclone</dt><dd>${esc(ab.rclone || '–')} <button class="link" data-act="setup">Set up tools</button></dd>
        <dt>Drive sign-ins</dt><dd><code>${esc(ab.rcloneConfig || '–')}</code></dd>
        <dt>Colors, icons and settings</dt><dd><code>${esc(ab.settings || '–')}</code></dd>
        <dt>Thumbnail cache</dt><dd><code>${esc(ab.thumbs || '–')}</code></dd>
        <dt>Search index</dt><dd><code>${esc(ab.index || '–')}</code></dd>
        <dt>Backups</dt><dd><code>${esc(ab.backups || '–')}</code></dd>
      </dl>
    </section></div></div>`;
  paintCache();
}
async function toggleSetting(sw) {
  const on = sw.getAttribute('aria-checked') !== 'true';
  sw.setAttribute('aria-checked', on);
  $('#toolsRow')?.classList.toggle('off', !on);
  if (sw.dataset.set === 'index') $('#indexRow')?.classList.toggle('off', !on);
  try { await patchConfig({ prefs: { [sw.dataset.set]: on } }); thumbState.clear(); if (sw.dataset.set === 'index') { if (on) sendDrivesToIndex(); paintIndex(); } }
  catch (e) { sw.setAttribute('aria-checked', !on); toast(e.message, 'err'); }
}
main.addEventListener('change', async e => {
  if (!e.target.matches('select[data-set=cacheMax]')) return;
  try { await patchConfig({ prefs: { cacheMax: +e.target.value } }); await refreshCache(); }
  catch (err) { toast(err.message, 'err'); }
});
function setTheme(v) {
  S.theme = v; applyTheme(); savePrefs();
  const seg = $('.seg.text', main); if (!seg) return;
  seg.style.setProperty('--i', ['auto', 'light', 'dark'].indexOf(v));
  $$('[data-theme-opt]', seg).forEach(b => b.setAttribute('aria-checked', b.dataset.themeOpt === v));
}
async function clearThumbCache() {
  const size = cacheInfo ? fmt(cacheInfo.bytes) : 'all';
  const ok = await dialog({
    title: 'Clear thumbnail cache?',
    text: `This deletes ${size} of saved thumbnails. They’ll be made again as you browse, which takes a while and downloads part of each photo and video again.`,
    ok: 'Clear cache', danger: true,
    onSubmit: async () => {
      const r = await api('/_ui/cache', { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      cacheInfo = j;
    },
  });
  if (!ok) return;
  thumbState.clear();
  toast('Thumbnail cache cleared', 'ok');
  paintCache();
}

// ---------- setup ----------
// Shown on first run when a tool is missing (always when rclone is, since nothing works without it),
// and from Settings > Set up tools. Installs run on this computer only after the user confirms.
let SETUP = null, setupTimer = null;
const setupOpen = new Set();   // "install it yourself" sections the user opened
async function refreshSetup(action, body) {
  const r = await api('/_ui/setup' + (action ? '/' + action : ''), action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  SETUP = j; S.features.ffmpeg = j.tools.ffmpeg.found;
  return j;
}
const needsSetup = () => SETUP && (!SETUP.tools.rclone.found || (!S.cfg.prefs.setupDone && !SETUP.tools.ffmpeg.found));
async function showSetup() {
  leaveFolder(); Object.assign(S, { sel: null, page: 'setup' }); S.nav++;
  renderSide();
  if (!SETUP) await refreshSetup().catch(() => {});
  renderSetup(true);
  if (SETUP?.job?.state === 'running') pollSetup();
}
function pollSetup() {
  clearTimeout(setupTimer);
  setupTimer = setTimeout(async () => {
    const before = SETUP?.job?.state;
    await refreshSetup().catch(() => {});
    if (S.page === 'setup') renderSetup(false);
    const j = SETUP?.job;
    if (j?.state === 'running') return pollSetup();
    if (before === 'running' && j) toast(j.state === 'done' ? `${SETUP.tools[j.tool].label} is installed` : `Couldn't install ${SETUP.tools[j.tool].label}. The details are below.`, j.state === 'done' ? 'ok' : 'err');
  }, 800);
}
function renderSetup(anim) {
  const main = $('#main'); accent(main, null);
  const st = SETUP, blocking = !st?.tools.rclone.found;
  document.body.classList.toggle('setup-mode', blocking);
  if (!st) { main.innerHTML = `<div class="content"><div class="empty err"><div class="ill">${ico('alert')}</div><h3>Can't check this computer</h3><p>DriveDeck couldn't look for the tools it needs.</p><button class="btn" data-setup="check">${ico('refresh')}Try again</button></div></div>`; return; }
  const logEl = $('.log', main), stick = !logEl || logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8;
  const busy = st.job?.state === 'running';
  const card = (key, t) => {
    const running = busy && st.job.tool === key, lastJob = st.job?.tool === key && st.job.state !== 'done' ? st.job : null;
    const state = t.found ? `Installed, ${esc(t.version)}` : running ? 'Installing…' : 'Not installed';
    const steps = `<ol class="steps-list">${t.steps.map(x => `<li><span>${esc(x.text)}</span>${x.cmd ? `<div class="cmd"><code>${esc(x.cmd)}</code><button class="icon-btn sm" data-copy="${esc(x.cmd)}" title="Copy">${ico('copy')}</button></div>` : ''}${x.url ? ` <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url.replace(/^https:\/\//, ''))}</a>` : ''}</li>`).join('')}</ol>`;
    return `<section class="tool ${t.found ? 'ok' : 'missing'} ${t.required ? 'required' : ''}" data-tool="${key}">
      <div class="tool-head">
        <span class="tool-ico">${t.found ? ico('check') : running ? '<span class="spin"></span>' : ico(t.required ? 'alert' : 'download')}</span>
        <div><b>${esc(t.label)}</b><span class="tag ${t.required ? 'req' : ''}">${t.required ? 'Required' : 'Optional'}</span><p>${esc(t.why)}</p></div>
        <span class="tool-state">${state}</span>
      </div>
      ${t.found ? `<div class="tool-body"><span class="tool-path">${esc(t.path)}</span></div>` : `<div class="tool-body">
        ${t.command ? `<div class="tool-actions"><button class="btn primary" data-install="${key}" ${busy ? 'disabled' : ''}>${ico('download')}Install with ${esc(st.installer.label)}</button>
          <span class="mute">Runs <code>${esc(t.command)}</code></span></div>` : ''}
        <details data-open-key="${key}" ${!t.command || setupOpen.has(key) ? 'open' : ''}><summary>${t.command ? 'Or install it yourself' : 'How to install it'}</summary>${steps}</details>
      </div>`}
      ${lastJob ? `<div class="tool-body"><pre class="log">${esc(lastJob.log.join('\n'))}</pre>
        ${lastJob.state === 'error' ? `<p class="tool-err">${ico('alert')}<span>The install didn't finish (exit code ${lastJob.code}). Check the output above, or install it yourself and choose Check again.</span></p>` : ''}</div>` : ''}
    </section>`;
  };
  const platform = { darwin: 'Mac', win32: 'Windows PC' }[st.platform] || 'computer';
  main.innerHTML = `<div class="toolbar"><button class="icon-btn menu-btn" data-act="drawer" title="Drives">${ico('menu')}</button>
    <div class="crumbs"><span class="crumb">Set up tools</span></div></div>
    <div class="content ${anim ? 'enter' : ''}" id="content"><div class="setup">
      <div class="setup-hero"><span class="logo">${ico('cloud')}</span>
        <h1>${blocking ? 'Set up DriveDeck' : 'Tools on this ' + platform}</h1>
        <p>${blocking ? `DriveDeck works with a free tool called rclone, which isn’t on this ${platform} yet. Install it below and you’re ready to go.` : 'DriveDeck uses these free tools. Everything required is installed.'}</p></div>
      ${Object.entries(st.tools).map(([k, t]) => card(k, t)).join('')}
      <div class="setup-foot">
        <span class="mute">${blocking ? 'Installed it yourself? Choose Check again.' : ''}</span>
        <button class="btn ghost" data-setup="check" ${busy ? 'disabled' : ''}>${ico('refresh')}Check again</button>
        <button class="btn primary" data-setup="done" ${st.tools.rclone.found && st.backend && !busy ? '' : 'disabled'}>${S.loaded ? 'Done' : 'Continue to DriveDeck'}</button>
      </div>
    </div></div>`;
  const log = $('.log', main); if (log && stick) log.scrollTop = log.scrollHeight;
}
async function copyText(btn) {
  try { await navigator.clipboard.writeText(btn.dataset.copy); }
  catch (_) { return toast('Couldn’t copy. Select the text and copy it instead.', 'err'); }
  const use = $('use', btn); use?.setAttribute('href', '#i-check'); btn.classList.add('copied');
  setTimeout(() => { use?.setAttribute('href', '#i-copy'); btn.classList.remove('copied'); }, 1400);
}
modal.addEventListener('click', e => { const cp = e.target.closest('[data-copy]'); if (cp) copyText(cp); });
function confirmInstall(key) {
  const t = SETUP.tools[key], inst = SETUP.installer;
  openModal(`${modalHead(`Install ${t.label}?`, null)}
    <div class="m-body"><p class="m-text">DriveDeck will run this command on your computer using ${esc(inst.label)}:</p>
      <div class="cmd"><code>${esc(t.command)}</code></div>
      <p class="m-text mute">${inst.kind === 'winget' ? 'This accepts the winget source and package agreements for you. ' : ''}It can take a few minutes. You can watch the progress here.</p></div>
    <div class="m-foot"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" id="doInstall" autofocus>${ico('download')}Install</button></div>`, 'sm');
  $('[data-cancel]', modal).onclick = closeModal;
  $('#doInstall', modal).onclick = async () => {
    closeModal();
    try { await refreshSetup('install', { tool: key }); renderSetup(false); pollSetup(); }
    catch (e) { toast(e.message, 'err'); }
  };
}
main.addEventListener('click', async e => {
  const t = e.target;
  const ins = t.closest('[data-install]'); if (ins) return confirmInstall(ins.dataset.install);
  const cp = t.closest('[data-copy]'); if (cp) return copyText(cp);
  const act = t.closest('[data-setup]')?.dataset.setup;
  if (act === 'check') {
    const b = t.closest('[data-setup]'); busy(b, true, 'Checking…');
    try { const was = SETUP?.tools.rclone.found; await refreshSetup('check'); if (!was && SETUP.tools.rclone.found) toast('rclone found', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
    if (S.page === 'setup') renderSetup(false);
  } else if (act === 'done') {
    await patchConfig({ prefs: { setupDone: true } }).catch(() => {});
    document.body.classList.remove('setup-mode');
    go(null);
    if (!S.loaded) { pollUploads(); loadDrives().catch(err => toast(err.message, 'err')); }
  }
});
main.addEventListener('toggle', e => {
  const d = e.target; if (!d.matches?.('details[data-open-key]')) return;
  d.open ? setupOpen.add(d.dataset.openKey) : setupOpen.delete(d.dataset.openKey);
}, true);

// ---------- mobile drawer ----------
function toggleDrawer() { const open = !$('#side').classList.contains('open'); $('#side').classList.toggle('open', open); $('#scrim').classList.toggle('on', open); }
function closeDrawer() { $('#side').classList.remove('open'); $('#scrim').classList.remove('on'); }
$('#scrim').onclick = closeDrawer;

// ---------- boot ----------
(async () => {
  try {
    const r = await api('/_ui/config');
    if (r.status === 401) return;
    const c = await r.json();
    S.cfg = { drives: c.drives || {}, prefs: c.prefs || {}, usage: c.usage || {}, google: c.google }; S.features = c.features || {}; S.about = c.about || {};
    // The language saved in DriveDeck wins over this browser's copy (another browser may have changed it).
    // Reloads only if the copy was saved, so a browser that blocks storage can't loop.
    const want = c.prefs?.lang || 'en';
    if (want !== LANG) { try { localStorage.setItem('drivedeck-lang', want); if (localStorage.getItem('drivedeck-lang') === want) location.reload(); } catch (_) {} }
    if (c.prefs?.view) S.view = c.prefs.view;
    if (c.prefs?.sort) S.sort = c.prefs.sort;
    if (c.prefs?.theme) S.theme = c.prefs.theme;
  } catch (_) {}
  applyTheme();
  await refreshSetup().catch(() => {});   // if this fails, carry on: loading drives below shows any real problem
  if (S.page === 'signedout') return;
  if (needsSetup()) history.replaceState(null, '', '#setup');
  route();
  if (SETUP && !SETUP.backend) return;   // the setup screen takes over until rclone is installed
  pollUploads();
  try { await loadDrives(); }
  catch (e) { $('#main').innerHTML = `<div class="content"><div class="empty err"><div class="ill">${ico('alert')}</div><h3>Can't reach rclone</h3><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">${ico('refresh')}Try again</button></div></div>`; }
})();
