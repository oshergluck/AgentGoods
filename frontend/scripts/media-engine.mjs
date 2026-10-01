/**
 * Procedural artwork engine.
 *
 * Every store, product and token gets illustration that is DERIVED FROM ITS OWN ID, so two things
 * never look alike and nothing has to be drawn by hand as the catalogue grows. The generator is
 * deterministic: the same id always produces the same image, which matters because a listing
 * whose artwork changed on every page load would read as a different listing.
 *
 * Four properties are deliberate:
 *
 *  - **same-origin.** Nothing is fetched. Rendering a catalogue never discloses a viewer's IP to
 *    a third-party image host (docs/DECISIONS.md D-017).
 *  - **SVG.** Sharp at any size, a few kilobytes, and it costs no image decode — which is what
 *    keeps a page of forty listings inside the Core Web Vitals budget of MASTER_PLAN 0.29.
 *  - **cheap motion.** Movement comes from a handful of SMIL animations per image, never one per
 *    element. A hundred independent timelines on screen shows up directly in INP.
 *  - **honest.** This is decoration for humans. Agents read `contentHash`, declarations and
 *    signal coverage; none of them looks at a picture. Nothing here ever encodes meaning that a
 *    reader could mistake for protocol state.
 *
 * Used both offline (`generate-media.mjs` writes files) and at runtime in the UI, so a listing
 * created after the last build still gets its own artwork rather than a placeholder.
 */

/* ----------------------------------------------------------------- random */

/** FNV-1a. Small, stable across platforms, and good enough to scatter a seed space. */
export function hashSeed(seed) {
  let h = 0x811c9dc5;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** xorshift32, seeded from the id. Deterministic per seed, uncorrelated between seeds. */
export function rng(seed) {
  let state = hashSeed(seed) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/* --------------------------------------------------------------- palettes */

/**
 * Palettes are generated in HSL rather than picked from a list, so the space is continuous and a
 * large catalogue does not visibly cycle. Saturation and lightness stay in a narrow band: that
 * band is what makes every result look like it belongs to the same product rather than to a
 * random colour generator.
 */
export function palette(seed) {
  const r = rng(`${seed}:palette`);
  const baseHue = Math.floor(r() * 360);
  // Three harmonies, chosen by seed: analogous, split-complementary, triadic.
  const harmony = Math.floor(r() * 3);
  const spread = harmony === 0 ? 28 : harmony === 1 ? 150 : 120;
  const direction = r() > 0.5 ? 1 : -1;

  const hsl = (h, s, l) => `hsl(${((h % 360) + 360) % 360} ${s}% ${l}%)`;
  return {
    a: hsl(baseHue, 78, 62),
    b: hsl(baseHue + spread * direction, 72, 56),
    c: hsl(baseHue + spread * direction * 1.7, 68, 60),
    glow: hsl(baseHue, 85, 58),
    harmony,
  };
}

/* ----------------------------------------------------------------- motifs */

const W = 960;
const H = 480;

function defs(p, id) {
  return `<defs>
    <linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${p.a}"/>
      <stop offset="50%" stop-color="${p.b}"/>
      <stop offset="100%" stop-color="${p.c}"/>
    </linearGradient>
    <linearGradient id="bg${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#070a12"/>
      <stop offset="100%" stop-color="#0d1526"/>
    </linearGradient>
    <radialGradient id="halo${id}" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="${p.glow}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${p.glow}" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

/** Concentric rings: something layered and indexed. */
function motifRings(p, r, id) {
  let out = `<rect width="${W}" height="${H}" fill="url(#halo${id})"/>`;
  const cx = W * (0.3 + r() * 0.4);
  const cy = H * (0.4 + r() * 0.2);
  const count = 7 + Math.floor(r() * 6);
  for (let i = 0; i < count; i++) {
    const radius = 24 + i * (14 + r() * 14);
    const dash = 4 + Math.floor(r() * 30);
    const dur = (36 + i * 8).toFixed(0);
    out += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="none" stroke="url(#g${id})" stroke-width="${(0.6 + r() * 1.8).toFixed(2)}" stroke-opacity="${(0.18 + r() * 0.5).toFixed(2)}" stroke-dasharray="${dash} ${dash + 7}"><animateTransform attributeName="transform" type="rotate" from="0 ${cx.toFixed(1)} ${cy.toFixed(1)}" to="${i % 2 ? 360 : -360} ${cx.toFixed(1)} ${cy.toFixed(1)}" dur="${dur}s" repeatCount="indefinite"/></circle>`;
  }
  out += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7" fill="${p.a}"/>`;
  return out;
}

/** A metered spectrum: capacity being drawn down. */
function motifSpectrum(p, r, id) {
  const bars = 30 + Math.floor(r() * 24);
  const phase = r() * Math.PI * 2;
  const freq = 0.18 + r() * 0.35;
  let out = "";
  for (let i = 0; i < bars; i++) {
    const w = W / bars;
    const height = (0.1 + Math.abs(Math.sin(i * freq + phase)) * 0.78) * H;
    out += `<rect x="${(i * w + w * 0.2).toFixed(1)}" y="${(H - height).toFixed(1)}" width="${(w * 0.6).toFixed(1)}" height="${height.toFixed(1)}" fill="url(#g${id})" opacity="${(0.14 + (i / bars) * 0.55).toFixed(2)}" rx="2"/>`;
  }
  return out;
}

/** Routed traces: tooling and harnesses. */
function motifCircuit(p, r, id) {
  const lanes = 6 + Math.floor(r() * 6);
  let out = "";
  for (let i = 0; i < lanes; i++) {
    const y = ((i + 0.5) / lanes) * H;
    const turn = W * (0.15 + r() * 0.7);
    const drop = y + (r() > 0.5 ? 1 : -1) * (24 + r() * 80);
    out += `<path d="M0 ${y.toFixed(1)} H ${turn.toFixed(1)} V ${drop.toFixed(1)} H ${W}" fill="none" stroke="url(#g${id})" stroke-width="1.5" stroke-opacity="${(0.16 + r() * 0.38).toFixed(2)}"/>`;
    out += `<circle cx="${turn.toFixed(1)}" cy="${drop.toFixed(1)}" r="3.2" fill="${p.a}" opacity="0.8"/>`;
  }
  return out;
}

/** A live waveform: streaming and realtime feeds. */
function motifWave(p, r, id) {
  let out = "";
  for (let layer = 0; layer < 3; layer++) {
    const amp = 26 + r() * 74;
    const phase = r() * Math.PI * 2;
    const freq = 0.16 + r() * 0.32;
    const pts = [];
    for (let i = 0; i <= 84; i++) {
      const x = (i / 84) * W;
      const y = H * 0.5 + Math.sin(i * freq + phase) * amp * (0.35 + 0.65 * Math.sin(i / 24));
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    out += `<polyline points="${pts.join(" ")}" fill="none" stroke="url(#g${id})" stroke-width="${(2.6 - layer * 0.7).toFixed(1)}" opacity="${(0.85 - layer * 0.25).toFixed(2)}"/>`;
  }
  return out;
}

/** A scattered lattice: raw, unstructured material. */
function motifLattice(p, r, id) {
  const cols = 20 + Math.floor(r() * 16);
  const rows = 9 + Math.floor(r() * 7);
  let out = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = r();
      if (v < 0.44) continue;
      const cx = ((x + 0.5) / cols) * W;
      const cy = ((y + 0.5) / rows) * H;
      const size = 1.3 + v * 3.6;
      const fill = v > 0.82 ? p.a : v > 0.62 ? p.b : p.c;
      out += `<rect x="${(cx - size / 2).toFixed(1)}" y="${(cy - size / 2).toFixed(1)}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" fill="${fill}" opacity="${(0.12 + v * 0.5).toFixed(2)}"/>`;
    }
  }
  return out;
}

/** An orbital system: something with a centre and dependents. */
function motifOrbit(p, r, id) {
  const cx = W / 2;
  const cy = H / 2;
  let out = `<rect width="${W}" height="${H}" fill="url(#halo${id})"/>`;
  const orbits = 3 + Math.floor(r() * 4);
  for (let i = 0; i < orbits; i++) {
    const rx = 60 + i * (50 + r() * 40);
    const ry = rx * (0.25 + r() * 0.5);
    const tilt = Math.floor(r() * 180);
    const dur = (22 + i * 11).toFixed(0);
    out += `<ellipse cx="${cx}" cy="${cy}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="url(#g${id})" stroke-opacity="${(0.2 + r() * 0.35).toFixed(2)}" stroke-width="1.4" transform="rotate(${tilt} ${cx} ${cy})"/>`;
    out += `<circle r="${(2.5 + r() * 3).toFixed(1)}" fill="${i % 2 ? p.a : p.c}"><animateMotion dur="${dur}s" repeatCount="indefinite" path="M ${cx - rx} ${cy} a ${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 0 ${(rx * 2).toFixed(1)} 0 a ${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 0 ${(-rx * 2).toFixed(1)} 0" rotate="auto"/></circle>`;
  }
  return out;
}

/** A terraced contour: something surveyed and mapped. */
function motifTerrain(p, r, id) {
  const layers = 5 + Math.floor(r() * 5);
  let out = "";
  for (let l = 0; l < layers; l++) {
    const baseY = H * (0.3 + (l / layers) * 0.7);
    const amp = 12 + r() * 46;
    const freq = 0.1 + r() * 0.25;
    const phase = r() * Math.PI * 2;
    const pts = [`0,${H}`];
    for (let i = 0; i <= 60; i++) {
      const x = (i / 60) * W;
      pts.push(`${x.toFixed(1)},${(baseY + Math.sin(i * freq + phase) * amp).toFixed(1)}`);
    }
    pts.push(`${W},${H}`);
    out += `<polygon points="${pts.join(" ")}" fill="url(#g${id})" opacity="${(0.06 + (l / layers) * 0.12).toFixed(3)}"/>`;
    out += `<polyline points="${pts.slice(1, -1).join(" ")}" fill="none" stroke="url(#g${id})" stroke-width="1.2" opacity="${(0.25 + (l / layers) * 0.35).toFixed(2)}"/>`;
  }
  return out;
}

export const MOTIFS = [motifRings, motifSpectrum, motifCircuit, motifWave, motifLattice, motifOrbit, motifTerrain];

/* ------------------------------------------------------------------ cover */

/**
 * A cover illustration for `seed`.
 *
 * The motif, palette, density and drift speed all derive from the seed, so the space of distinct
 * results is effectively the space of ids: seven motifs times a continuous hue space times the
 * per-motif parameters. A catalogue does not start repeating.
 */
export function coverSvg(seed, caption = "") {
  const p = palette(seed);
  const r = rng(`${seed}:cover`);
  const id = hashSeed(seed).toString(36).slice(0, 6);
  const motif = MOTIFS[hashSeed(`${seed}:motif`) % MOTIFS.length];
  const drift = (11 + r() * 10).toFixed(1);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(caption)}">
  ${defs(p, id)}
  <rect width="${W}" height="${H}" fill="url(#bg${id})"/>
  ${motif(p, r, id)}
  <rect x="-240" y="0" width="240" height="${H}" fill="url(#g${id})" opacity="0.06">
    <animate attributeName="x" from="-240" to="${W}" dur="${drift}s" repeatCount="indefinite"/>
  </rect>
  <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="${p.b}" stroke-opacity="0.16" stroke-width="2"/>
</svg>
`;
}

/* ------------------------------------------------------------------- logo */

/** A logo mark for `seed`: a rotating polygonal glyph on a dark tile. */
export function logoSvg(seed, initials = "") {
  const p = palette(seed);
  const r = rng(`${seed}:logo`);
  const id = hashSeed(`${seed}:logo`).toString(36).slice(0, 6);
  const sides = 3 + Math.floor(r() * 5);
  const spin = r() > 0.5 ? 360 : -360;
  const dur = (14 + r() * 12).toFixed(1);
  const twist = r() * 0.8;

  const points = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 - Math.PI / 2 + twist;
    points.push(`${(64 + Math.cos(angle) * 34).toFixed(2)},${(64 + Math.sin(angle) * 34).toFixed(2)}`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="${escapeXml(initials)} mark">
  <defs>
    <linearGradient id="lg${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${p.a}"/>
      <stop offset="55%" stop-color="${p.b}"/>
      <stop offset="100%" stop-color="${p.c}"/>
    </linearGradient>
    <radialGradient id="lh${id}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${p.glow}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${p.glow}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="128" height="128" rx="30" fill="#080b14"/>
  <rect width="128" height="128" rx="30" fill="url(#lh${id})"/>
  <polygon points="${points.join(" ")}" fill="none" stroke="url(#lg${id})" stroke-width="3" stroke-linejoin="round">
    <animateTransform attributeName="transform" type="rotate" from="0 64 64" to="${spin} 64 64" dur="${dur}s" repeatCount="indefinite"/>
  </polygon>
  <polygon points="${points.join(" ")}" fill="url(#lg${id})" opacity="0.14" transform="scale(0.62) translate(39 39)"/>
  <circle cx="64" cy="64" r="6" fill="${p.a}">
    <animate attributeName="r" values="5;7.5;5" dur="3.4s" repeatCount="indefinite"/>
  </circle>
  ${initials ? `<text x="64" y="116" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" letter-spacing="3" fill="#8fa3c8">${escapeXml(initials)}</text>` : ""}
</svg>
`;
}

/** SVG is XML: an unescaped caption would break the document or inject markup. */
export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A `data:` URI, for rendering directly in an `<img>` without a network request or a file. */
export function toDataUri(svg) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
