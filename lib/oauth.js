'use strict';
// Signing in to providers that use OAuth (Google Drive, Dropbox and OneDrive). rclone does the work: `rclone authorize`
// runs a small web server on 127.0.0.1:53682 that the provider sends the browser back to, and prints the token
// once the user allows access. The token stays in this process until it's saved to the rclone config;
// the page only ever sees the sign-in link and how far along the sign-in is.
const { spawn } = require('child_process');
const crypto = require('crypto');

const LINK = /http:\/\/127\.0\.0\.1:53682\/auth\?state=[\w-]+/;
const LINK_WAIT = 20 * 1000;        // rclone prints the link almost at once
const SIGN_IN_WAIT = 10 * 60 * 1000; // the user has this long to finish on the provider's page
const KEEP_TOKEN = 15 * 60 * 1000;   // a token waits this long to be saved, so "Try again" needs no new sign-in

// rclone prints the result between "--->" and "<---End paste": either the token JSON itself or, in newer
// versions, base64 of a JSON object whose "token" field holds it.
function parseToken(text) {
  const m = /--->\s*([\s\S]*?)\s*<---End paste/.exec(text);
  if (!m) return null;
  let v = m[1].trim();
  if (!v.startsWith('{')) v = Buffer.from(v, 'base64').toString('utf8');
  try {
    let o = JSON.parse(v);
    if (typeof o.token === 'string') o = JSON.parse(o.token);
    else if (o.token && typeof o.token === 'object') o = o.token;
    return o.access_token || o.refresh_token ? JSON.stringify(o) : null;
  } catch (_) { return null; }
}

const SITE = { drive: 'Google', dropbox: 'Dropbox', onedrive: 'Microsoft' };
function explain(out, backend) {
  const site = SITE[backend] || 'The provider';
  if (/address already in use|bind:/i.test(out)) return 'Another sign-in is already waiting on this computer. Close any other rclone sign-in, then try again.';
  if (/access_denied/.test(out)) return backend === 'drive' ? 'Google didn’t allow access. If you use your own Google app, check that it’s published (step 5 of the guide), then try again.' : `${site} didn’t allow access. Please try again.`;
  if (/invalid_client|unauthorized_client/.test(out)) return backend === 'drive' ? 'Google didn’t accept the app’s client ID or secret. Check them in Settings, under Google Drive.' : `${site} didn’t accept rclone’s app. Updating rclone usually fixes this.`;
  if (/invalid_grant/.test(out)) return `${site} rejected the sign-in. Please try again.`;
  const line = out.split('\n').filter(l => /error|fail/i.test(l)).pop();
  return line ? line.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d \w+\s*:\s*/, '') : 'The sign-in didn’t finish.';
}

module.exports = function createOAuth({ rclone, env }) {
  const jobs = new Map();
  let current = null;   // rclone's sign-in server uses a fixed port, so one sign-in runs at a time

  const view = j => ({ id: j.id, state: j.state, url: j.url, error: j.error });
  const stop = (j, state, error = null) => {
    if (j.state !== 'starting' && j.state !== 'waiting') return;
    Object.assign(j, { state, error });
    clearTimeout(j.timer);
    try { j.proc.kill(); } catch (_) {}
  };
  const exited = j => j && j.proc.exitCode === null && j.proc.signalCode === null
    ? new Promise(r => j.proc.once('close', r)) : Promise.resolve();

  return {
    // client: { id, secret } for the user's own app (Google only), or null for rclone's own app.
    async start(backend, client) {
      if (current) { stop(current, 'cancelled'); await exited(current); }
      const j = { id: crypto.randomUUID(), backend, client, state: 'starting', url: null, error: null, token: null, out: '' };
      const argv = ['authorize', backend, ...(client ? [client.id, client.secret] : []), '--auth-no-open-browser'];
      j.proc = spawn(rclone(), argv, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      jobs.set(j.id, j); current = j;
      let ready;
      const linked = new Promise(r => { ready = r; });
      const feed = d => {
        if (j.out.length < 256 * 1024) j.out += d;
        const m = !j.url && LINK.exec(j.out);
        if (m) { j.url = m[0]; j.state = 'waiting'; clearTimeout(j.timer); j.timer = setTimeout(() => stop(j, 'error', 'The sign-in timed out. Please try again.'), SIGN_IN_WAIT); ready(); }
      };
      j.proc.stdout.on('data', feed); j.proc.stderr.on('data', feed);
      j.timer = setTimeout(() => stop(j, 'error', 'rclone didn’t start the sign-in. Please try again.'), LINK_WAIT);
      j.proc.on('error', e => { stop(j, 'error', 'Couldn’t run rclone: ' + e.message); ready(); });
      j.proc.on('close', () => {
        clearTimeout(j.timer);
        if (current === j) current = null;
        if (j.state === 'starting' || j.state === 'waiting') {
          j.token = parseToken(j.out);
          Object.assign(j, j.token ? { state: 'done' } : { state: 'error', error: explain(j.out, j.backend) });
        }
        j.out = '';   // it may hold the token
        ready();
        // Drop the token (and the job) after a while if it was never saved.
        setTimeout(() => jobs.delete(j.id), KEEP_TOKEN).unref();
      });
      await linked;
      return view(j);
    },
    get: id => jobs.get(id),
    view,
    cancel(id) { const j = jobs.get(id); if (j) stop(j, 'cancelled'); return !!j; },
    stopAll() { for (const j of jobs.values()) stop(j, 'cancelled'); },
  };
};
