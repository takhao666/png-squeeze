// png-squeeze: lossless PNG re-encoder that squeezes 1280x720 RGBA screenshots.
//
// Strategy, all computed at run time from the pixels themselves:
//  1. Decode the input (a stored, unfiltered RGBA PNG) with a small generic decoder.
//  2. Reduce the colour form when it is exact: a palette when the image holds at
//     most 256 distinct colours (tried in count order and in luminance order),
//     grey / grey+alpha when every pixel is grey, RGB when every pixel is opaque,
//     and a tRNS key when the only non-opaque pixels are one fully transparent
//     colour no opaque pixel uses. Each form is weighed by its real compressed size.
//  3. Pick each row's filter by several strategies — unfiltered, minimum
//     signed-byte sum, minimum zero-order entropy, fixed Paeth, and brute
//     force (each row actually deflated after the previous 32 KiB) — and keep
//     whichever deflates smallest at zlib level 9 (memLevel 9). Unfiltered
//     often wins on screenshots because it keeps repeated bytes matchable.
//  4. Emit one zlib stream in a single IDAT, only IHDR/PLTE/tRNS/IDAT/IEND chunks.
// Deterministic: no clock, no randomness, no environment reads; the same input
// always produces the same bytes. Node 22 stdlib only, no network.
import { inflateSync, deflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;
const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---- CRC-32 (PNG) -----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---- PNG writing ------------------------------------------------------------
function pngOf(chunks) {
  let size = 8;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
function ihdr(ct) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, W);
  v.setUint32(4, H);
  d[8] = 8;
  d[9] = ct;
  return d;
}
function pngFromForm(form, idat) {
  const chunks = [['IHDR', ihdr(form.ct)]];
  if (form.plte) chunks.push(['PLTE', form.plte]);
  if (form.trns) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---- PNG decoding (input is stored RGBA, but unfilter generically) -----------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let ct = -1;
  let w = 0;
  let h = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      w = dv.getUint32(0);
      h = dv.getUint32(4);
      ct = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const stride = w * ch;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const samples = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= ch ? samples[o + i - ch] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= ch ? samples[o + i - ch] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? samples[o + i - ch] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= ch ? samples[p + i - ch] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = w * h;
  const rgba = new Uint8Array(n * 4);
  if (ct === 6) rgba.set(samples);
  else if (ct === 2) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2]; rgba[d + 3] = 255;
    }
  } else if (ct === 0) {
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[i]; rgba[d + 3] = 255;
    }
  } else if (ct === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s]; rgba[d + 3] = samples[s + 1];
    }
  } else {
    const lut = new Uint8Array(palette.length / 3 * 4);
    for (let e = 0; e < palette.length / 3; e++) {
      lut[e * 4] = palette[e * 3]; lut[e * 4 + 1] = palette[e * 3 + 1]; lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i] * 4;
      rgba[d] = lut[e]; rgba[d + 1] = lut[e + 1]; rgba[d + 2] = lut[e + 2]; rgba[d + 3] = lut[e + 3];
    }
  }
  return rgba;
}

// ---- Image analysis ---------------------------------------------------------
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2], a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, 1);
      } else counts.set(key, k + 1);
    }
  }
  return { opaque, grey, colours: many ? null : counts };
}

// The one fully transparent colour the image may key by tRNS (type 0/2) instead
// of carrying an alpha channel: every non-opaque pixel is that exact colour at
// alpha 0, and no opaque pixel shares its grey/RGB value.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return -1;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return -1;
  }
  if (key === -1) return -1;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return -1;
  }
  return key;
}

// ---- Filtering --------------------------------------------------------------
// Filter one row with filter `t` into `out`, returning the signed-byte sum
// (PNG spec 12.8 minimum-sum heuristic cost).
function filterRowInto(t, cur, prev, bpp, out) {
  const n = cur.length;
  let sum = 0;
  if (t === 0) {
    for (let i = 0; i < n; i++) { const v = cur[i]; out[i] = v; sum += v < 128 ? v : 256 - v; }
  } else if (t === 1) {
    for (let i = 0; i < n; i++) {
      const v = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 255;
      out[i] = v; sum += v < 128 ? v : 256 - v;
    }
  } else if (t === 2) {
    if (prev === null) {
      for (let i = 0; i < n; i++) { const v = cur[i]; out[i] = v; sum += v < 128 ? v : 256 - v; }
    } else {
      for (let i = 0; i < n; i++) {
        const v = (cur[i] - prev[i]) & 255;
        out[i] = v; sum += v < 128 ? v : 256 - v;
      }
    }
  } else if (t === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const v = (cur[i] - ((a + b) >> 1)) & 255;
      out[i] = v; sum += v < 128 ? v : 256 - v;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      const v = (cur[i] - paeth(a, b, c)) & 255;
      out[i] = v; sum += v < 128 ? v : 256 - v;
    }
  }
  return sum;
}

// Filter every row of `samples` by one strategy and return the filtered stream.
// Strategies: 'none' (fixed filter 0), 'paeth' (fixed filter 4), 'minsum'
// (per-row best of 5 by signed-byte sum), 'entropy' (per-row best of 5 by the
// zero-order entropy of the filtered row), 'brute' (per-row best of 5 by the
// real size of that row deflated at level 4 after the previous 32 KiB — the
// most accurate, and the most expensive).
const LOG2 = (() => {
  const t = new Float64Array(8192);
  for (let i = 1; i < t.length; i++) t[i] = Math.log2(i);
  return t;
})();
const HIST = new Uint32Array(256);
function entropyBits(row) {
  HIST.fill(0);
  for (let i = 0; i < row.length; i++) HIST[row[i]]++;
  let s = 0;
  const total = row.length;
  for (let c = 0; c < 256; c++) {
    const n = HIST[c];
    if (n) s += n * LOG2[n];
  }
  return total * LOG2[total] - s;
}
function filterImage(samples, bpp, mode) {
  const stride = W * bpp;
  const raw = new Uint8Array(H * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const buf = new Uint8Array(stride + 1);
    buf[0] = t;
    trial.push(buf);
  }
  for (let y = 0; y < H; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (mode === 'none' || mode === 'paeth') {
      const f = mode === 'none' ? 0 : 4;
      raw[at] = f;
      filterRowInto(f, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let best = Infinity;
    let type = 0;
    for (let t = 0; t < 5; t++) {
      const s = filterRowInto(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (mode === 'minsum') cost = s;
      else if (mode === 'entropy') cost = entropyBits(trial[t].subarray(1));
      else cost = deflateSync(trial[t], { level: 4, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---- Forms ------------------------------------------------------------------
function samplesFor(rgba, ct) {
  const n = W * H;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

function paletteForm(rgba, counts, order) {
  const entries = [...counts.entries()].map(([key, count]) => ({
    r: (key >>> 24) & 255, g: (key >>> 16) & 255, b: (key >>> 8) & 255, a: key & 255, key, count,
  }));
  const lum = (e) => 299 * e.r + 587 * e.g + 114 * e.b;
  if (order === 'adjacency') {
    // Order entries so colours that touch in the image get nearby indices:
    // start from the most frequent colour, then repeatedly take the unused
    // colour most adjacent (in the image) to the ones already placed. This
    // makes the index stream smooth, so Sub/Up filters emit small bytes.
    const tmp = new Map(entries.map((e, i) => [e.key, i]));
    const m = entries.length;
    const adj = new Float64Array(m * m);
    const idx = new Uint8Array(W * H);
    for (let i = 0, d = 0; i < W * H; i++, d += 4) {
      idx[i] = tmp.get(((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0);
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (x + 1 < W && idx[i] !== idx[i + 1]) { adj[idx[i] * m + idx[i + 1]]++; adj[idx[i + 1] * m + idx[i]]++; }
        if (y + 1 < H && idx[i] !== idx[i + W]) { adj[idx[i] * m + idx[i + W]]++; adj[idx[i + W] * m + idx[i]]++; }
      }
    }
    const placed = new Uint8Array(m);
    const score = new Float64Array(m);
    const ord = [];
    let first = 0;
    for (let i = 1; i < m; i++) if (entries[i].count > entries[first].count) first = i;
    ord.push(first);
    placed[first] = 1;
    for (let j = 0; j < m; j++) score[j] = adj[first * m + j];
    while (ord.length < m) {
      let bi = -1;
      let bs = -1;
      for (let j = 0; j < m; j++) {
        if (placed[j]) continue;
        const s = score[j] * 1000000 + entries[j].count;
        if (s > bs) { bs = s; bi = j; }
      }
      ord.push(bi);
      placed[bi] = 1;
      for (let j = 0; j < m; j++) score[j] += adj[bi * m + j];
    }
    // Reorder entries, keeping transparent entries first so tRNS stays short.
    const rank = new Int32Array(m);
    ord.forEach((orig, pos) => { rank[orig] = pos; });
    const posOf = new Map(entries.map((e, i) => [e, rank[i]]));
    const sorted = ord.map((i) => entries[i]);
    sorted.sort((x, y) => {
      const tx = x.a === 255 ? 1 : 0;
      const ty = y.a === 255 ? 1 : 0;
      if (tx !== ty) return tx - ty;
      if (tx === 0 && x.a !== y.a) return x.a - y.a;
      return posOf.get(x) - posOf.get(y);
    });
    entries.length = 0;
    entries.push(...sorted);
  } else {
    entries.sort((x, y) => {
      const tx = x.a === 255 ? 1 : 0;
      const ty = y.a === 255 ? 1 : 0;
      if (tx !== ty) return tx - ty;
      if (tx === 0 && x.a !== y.a) return x.a - y.a;
      if (order === 'luminance') return lum(x) - lum(y) || x.key - y.key;
      return y.count - x.count || x.key - y.key;
    });
  }
  const index = new Map(entries.map((e, i) => [e.key, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((e, i) => {
    plte[i * 3] = e.r; plte[i * 3 + 1] = e.g; plte[i * 3 + 2] = e.b;
    if (e.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (e) => e.a);
  const n = W * H;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const key = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
    indices[i] = index.get(key);
  }
  return { ct: 3, bpp: 1, samples: indices, plte, trns };
}

function channelForm(rgba, grey, opaque) {
  const key = opaque ? -1 : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== -1 ? 0 : 4;
    if (key !== -1) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== -1 ? 2 : 6;
    if (key !== -1) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 255, 0, key & 255);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  return { ct, bpp, samples: samplesFor(rgba, ct), plte: null, trns };
}

// ---- Encode one image: try the forms, keep the smallest real deflate --------
const Z = { level: 9, memLevel: 9 };
function encodeImage(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    forms.push(paletteForm(rgba, colours, 'adjacency'));
    // A palette image that is also grey can sometimes win as grey; try it too.
    if (grey) forms.push(channelForm(rgba, grey, opaque));
  } else {
    forms.push(channelForm(rgba, grey, opaque));
  }
  let best = null;
  for (const form of forms) {
    const overhead = (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);
    // Several filter strategies, each weighed by its real level-9 deflate size;
    // unfiltered often wins on screenshots because it keeps repeated bytes
    // matchable, brute force wins where filters genuinely help.
    const modes = form.ct === 3
      ? ['none', 'minsum', 'entropy', 'brute']
      : ['none', 'minsum', 'entropy', 'paeth', 'brute'];
    let formBest = null;
    for (const mode of modes) {
      const raw = filterImage(form.samples, form.bpp, mode);
      const z = deflateSync(raw, Z);
      const bytes = z.length + overhead;
      if (formBest === null || bytes < formBest.bytes) formBest = { form, raw, zlib: z, bytes };
    }
    // Z_FILTERED sometimes squeezes a filtered stream a little more.
    const zf = deflateSync(formBest.raw, { level: 9, memLevel: 9, strategy: 1 });
    if (zf.length + overhead < formBest.bytes) formBest = { form, raw: formBest.raw, zlib: zf, bytes: zf.length + overhead };
    if (best === null || formBest.bytes < best.bytes) best = formBest;
  }
  return pngFromForm(best.form, best.zlib);
}

// ---- Main -------------------------------------------------------------------
for (const id of readdirSync(INPUT).sort()) {
  const rgba = decodePng(new Uint8Array(readFileSync(join(INPUT, id, 'image.png'))));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'image.png'), encodeImage(rgba));
}
