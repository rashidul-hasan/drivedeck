'use strict';
// A streaming zip writer with no dependencies: each file is written as it arrives, and nothing is kept on
// disk. Files are stored, not compressed. Most cloud files (photos, video, music, archives) are already
// compressed, and storing keeps a download as fast as the drive can send it. A file's checksum and size are
// only known once it has been read, so they follow it in a data descriptor. ZIP64 records are added when a
// file, the archive or the number of entries is too big for the classic format.

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
// c is the running register: start at 0xFFFFFFFF, and the final checksum is (c ^ 0xFFFFFFFF) >>> 0.
const crcUpdate = (c, buf) => { for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return c; };

const MAX32 = 0xFFFFFFFF;
const dosTime = when => {
  let d = new Date(when);
  if (isNaN(d) || d.getFullYear() < 1980) d = new Date(1980, 0, 1);
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
};
const u64 = (b, v, at) => b.writeBigUInt64LE(BigInt(v), at);

class ZipWriter {
  constructor(out) { this.out = out; this.offset = 0; this.entries = []; }

  async write(buf) {
    if (this.out.destroyed) throw new Error('download stopped');
    this.offset += buf.length;
    if (!this.out.write(buf)) await new Promise(res => {
      const done = () => { this.out.off('drain', done); this.out.off('close', done); res(); };
      this.out.on('drain', done); this.out.on('close', done);
    });
  }

  // flags: bit 3 (sizes follow in a data descriptor) and bit 11 (names are UTF-8).
  localHeader(name, { time, date }, { descriptor, zip64 }) {
    const n = Buffer.from(name), extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) { extra.writeUInt16LE(1, 0); extra.writeUInt16LE(16, 2); }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(zip64 ? 45 : 20, 4); h.writeUInt16LE(descriptor ? 0x0808 : 0x0800, 6);
    h.writeUInt16LE(0, 8); h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12);
    h.writeUInt32LE(0, 14); h.writeUInt32LE(zip64 ? MAX32 : 0, 18); h.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    h.writeUInt16LE(n.length, 26); h.writeUInt16LE(extra.length, 28);
    return Buffer.concat([h, n, extra]);
  }

  async addDir(name, mtime) {
    const t = dosTime(mtime), offset = this.offset;
    await this.write(this.localHeader(name.replace(/\/?$/, '/'), t, {}));
    this.entries.push({ name: name.replace(/\/?$/, '/'), ...t, crc: 0, size: 0, offset, dir: true });
  }

  // data: an async iterable of Buffers. bigHint: the file may be 4 GB or more, so it needs ZIP64 fields.
  async addFile(name, mtime, data, bigHint = false) {
    const t = dosTime(mtime), offset = this.offset;
    await this.write(this.localHeader(name, t, { descriptor: true, zip64: bigHint }));
    let c = 0xFFFFFFFF, size = 0;
    try {
      for await (const chunk of data) { c = crcUpdate(c, chunk); size += chunk.length; await this.write(chunk); }
    } finally {
      // Written even if reading failed part way, so the archive stays valid (with a shorter file).
      const crc = (c ^ 0xFFFFFFFF) >>> 0, d = Buffer.alloc(bigHint ? 24 : 16);
      d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc, 4);
      if (bigHint) { u64(d, size, 8); u64(d, size, 16); } else { d.writeUInt32LE(size, 8); d.writeUInt32LE(size, 12); }
      this.entries.push({ name, ...t, crc, size, offset });
      if (!this.out.destroyed) await this.write(d);
    }
  }

  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const n = Buffer.from(e.name), big = [];
      if (e.size >= MAX32) big.push(e.size, e.size);
      if (e.offset >= MAX32) big.push(e.offset);
      const extra = Buffer.alloc(big.length ? 4 + big.length * 8 : 0);
      if (big.length) { extra.writeUInt16LE(1, 0); extra.writeUInt16LE(big.length * 8, 2); big.forEach((v, i) => u64(extra, v, 4 + i * 8)); }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(45, 4); h.writeUInt16LE(big.length ? 45 : 20, 6);
      h.writeUInt16LE(e.dir ? 0x0800 : 0x0808, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(e.time, 12); h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16); h.writeUInt32LE(Math.min(e.size, MAX32), 20); h.writeUInt32LE(Math.min(e.size, MAX32), 24);
      h.writeUInt16LE(n.length, 28); h.writeUInt16LE(extra.length, 30); h.writeUInt16LE(0, 32); h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36);
      h.writeUInt32LE(e.dir ? 0x10 : 0, 38); h.writeUInt32LE(Math.min(e.offset, MAX32), 42);
      await this.write(Buffer.concat([h, n, extra]));
    }
    const cdSize = this.offset - start, count = this.entries.length;
    if (count >= 0xFFFF || start >= MAX32 || cdSize >= MAX32) {
      const z = Buffer.alloc(56), at = this.offset;
      z.writeUInt32LE(0x06064b50, 0); u64(z, 44, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
      z.writeUInt32LE(0, 16); z.writeUInt32LE(0, 20); u64(z, count, 24); u64(z, count, 32); u64(z, cdSize, 40); u64(z, start, 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0); loc.writeUInt32LE(0, 4); u64(loc, at, 8); loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([z, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Math.min(count, 0xFFFF), 8); end.writeUInt16LE(Math.min(count, 0xFFFF), 10);
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12); end.writeUInt32LE(Math.min(start, MAX32), 16);
    await this.write(end);
  }
}

module.exports = { ZipWriter };
