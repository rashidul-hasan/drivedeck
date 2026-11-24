'use strict';
// Thumbnails served by the cloud provider itself, for rclone backends whose API offers them.
// Each adapter gets the remote's rclone config, the file's provider ID (from rclone's listing), its path
// on the remote and a current OAuth access token. It resolves to image bytes, or null when the provider
// has no thumbnail for that file (the caller may then generate one). Errors carry the HTTP status.

const TIMEOUT = 20000;
const MAX_BYTES = 5 * 1024 * 1024;

async function request(url, init = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  if (r.status === 404 || r.status === 409) return null;   // no thumbnail for this file (Dropbox uses 409)
  if (!r.ok && !(r.status >= 300 && r.status < 400)) throw Object.assign(new Error(`${new URL(url).host} answered ${r.status}`), { status: r.status });
  return r;
}
const bytes = async r => {
  if (!r || !r.ok) return null;
  const b = Buffer.from(await r.arrayBuffer());
  return b.length && b.length <= MAX_BYTES ? b : null;
};
const bearer = token => ({ Authorization: 'Bearer ' + token });

const GRAPH = { global: 'https://graph.microsoft.com', us: 'https://graph.microsoft.us', de: 'https://graph.microsoft.de', cn: 'https://microsoftgraph.chinacloudapi.cn' };

module.exports = {
  // https://developers.google.com/drive/api/reference/rest/v3/files (thumbnailLink)
  drive: async ({ id, token, size }) => {
    if (!id) return null;
    const meta = await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=thumbnailLink&supportsAllDrives=true`, { headers: bearer(token) });
    const link = meta && (await meta.json()).thumbnailLink;
    if (!link) return null;
    const u = new URL(link.replace(/=s\d+$/, `=s${size}`));
    // The link is short-lived and, for private files, needs the same token. Only ever send it to Google.
    const google = u.protocol === 'https:' && /(^|\.)(googleusercontent|googleapis|google)\.com$/.test(u.hostname);
    return bytes(await request(u, { headers: google ? bearer(token) : {} }));
  },

  // https://learn.microsoft.com/graph/api/driveitem-list-thumbnails
  onedrive: async ({ cfg, id, token }) => {
    if (!id) return null;
    const [driveId, itemId] = id.includes('#') ? id.split('#') : [cfg.drive_id, id];
    if (!driveId || !itemId) return null;
    const host = GRAPH[cfg.region || 'global'] || GRAPH.global;
    const r = await request(`${host}/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/thumbnails/0/large/content`,
      { headers: bearer(token), redirect: 'manual' });
    // Graph redirects to a pre-signed URL on another host; follow it without the token.
    const loc = r && r.status >= 300 && r.headers.get('location');
    return bytes(loc ? await request(loc) : r);
  },

  // https://www.dropbox.com/developers/documentation/http/documentation#files-get_thumbnail
  dropbox: async ({ id, path, token }) => {
    const arg = JSON.stringify({ resource: { '.tag': 'path', path: id || '/' + path }, format: 'jpeg', size: 'w640h480', mode: 'fitone_bestfit' })
      .replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));   // header must be ASCII
    return bytes(await request('https://content.dropboxapi.com/2/files/get_thumbnail_v2', { method: 'POST', headers: { ...bearer(token), 'Dropbox-API-Arg': arg } }));
  },
};
