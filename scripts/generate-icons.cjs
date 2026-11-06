const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

// Brand colors
const CHATGPT = {
  bg: { r: 16, g: 163, b: 127 },    // #10a37f
  fg: { r: 255, g: 255, b: 255 },
};
const CLAUDE = {
  bg: { r: 217, g: 119, b: 6 },     // #d97706
  fg: { r: 255, g: 255, b: 255 },
};
const GEMINI = {
  bg: { r: 66, g: 133, b: 244 },    // #4285f4
  fg: { r: 255, g: 255, b: 255 },
};

// Sector layout: rotate so dividers start from top (12 o'clock)
// Sector 0 (right):   -30° to  90° → ChatGPT
// Sector 1 (bottom):   90° to 210° → Claude
// Sector 2 (left):    210° to 330° → Gemini
const SECTORS = [
  { brand: CHATGPT, startDeg: -30, drawSymbol: drawChatGPTSymbol },
  { brand: CLAUDE,  startDeg: 90,  drawSymbol: drawClaudeSymbol },
  { brand: GEMINI,  startDeg: 210, drawSymbol: drawGeminiSymbol },
];

function degToRad(d) { return d * Math.PI / 180; }

function getSector(normAngle) {
  // normAngle: 0-360, 0 = right
  // Sector 0: 330-360, 0-90 (ChatGPT, right side)
  // Sector 1: 90-210 (Claude, bottom-left)
  // Sector 2: 210-330 (Gemini, top-left)
  if (normAngle >= 330 || normAngle < 90) return 0;
  if (normAngle >= 90 && normAngle < 210) return 1;
  return 2;
}

function sectorCenter(sectorIdx) {
  const centers = [30, 150, 270]; // degree of center of each sector
  return degToRad(centers[sectorIdx]);
}

// === Symbol drawing functions ===
// Each returns true if (x,y) should be white (foreground) in that sector

// ChatGPT: Simplified OpenAI spiral/knot — draw as interlocking arcs
function drawChatGPTSymbol(x, y, cx, cy, r) {
  const sx = cx + Math.cos(degToRad(30)) * r * 0.55;
  const sy = cy + Math.sin(degToRad(30)) * r * 0.55;
  const dx = x - sx;
  const dy = y - sy;
  const symbolR = r * 0.22;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const thickness = r * 0.06;

  // Draw a spiral-like pattern: two concentric ring arcs
  if (Math.abs(dist - symbolR) < thickness) {
    const angle = Math.atan2(dy, dx);
    // Only draw partial arcs for spiral effect
    if (angle > -Math.PI * 0.8 && angle < Math.PI * 0.5) return true;
  }
  if (Math.abs(dist - symbolR * 0.5) < thickness) {
    const angle = Math.atan2(dy, dx);
    if (angle > -Math.PI * 0.3 && angle < Math.PI * 0.9) return true;
  }
  // Center dot
  if (dist < thickness * 0.8) return true;

  return false;
}

// Claude: Starburst / sparkle — the Claude icon's distinctive rays
function drawClaudeSymbol(x, y, cx, cy, r) {
  const sx = cx + Math.cos(degToRad(150)) * r * 0.55;
  const sy = cy + Math.sin(degToRad(150)) * r * 0.55;
  const dx = x - sx;
  const dy = y - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxR = r * 0.24;
  const thickness = r * 0.045;

  if (dist > maxR) return false;

  // Center dot
  if (dist < thickness * 1.5) return true;

  // 4 rays at 0°, 90°, 180°, 270° (plus)
  const angle = Math.atan2(dy, dx);
  const rayCount = 4;
  for (let i = 0; i < rayCount; i++) {
    const rayAngle = (i * Math.PI) / 2; // 0, 90, 180, 270
    let angleDiff = Math.abs(angle - rayAngle);
    if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
    // Ray gets thinner toward the tip
    const taperThickness = thickness * (1 - dist / maxR * 0.6);
    if (angleDiff < taperThickness / dist && dist > thickness) return true;
  }

  // 4 diagonal shorter rays
  for (let i = 0; i < 4; i++) {
    const rayAngle = (i * Math.PI) / 2 + Math.PI / 4;
    let angleDiff = Math.abs(angle - rayAngle);
    if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
    const shortMaxR = maxR * 0.6;
    const taperThickness = thickness * 0.8 * (1 - dist / shortMaxR * 0.6);
    if (dist < shortMaxR && angleDiff < taperThickness / dist && dist > thickness) return true;
  }

  return false;
}

// Gemini: Four-pointed star / sparkle
function drawGeminiSymbol(x, y, cx, cy, r) {
  const sx = cx + Math.cos(degToRad(270)) * r * 0.55;
  const sy = cy + Math.sin(degToRad(270)) * r * 0.55;
  const dx = x - sx;
  const dy = y - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxR = r * 0.24;

  if (dist > maxR) return false;

  // Gemini star: 4-pointed star shape using the formula
  // For a 4-pointed star, check if point is inside the star shape
  const angle = Math.atan2(dy, dx);

  // Star shape: radius varies with angle
  // 4-pointed star: r = maxR * cos(2*angle) envelope
  const starFactor = Math.pow(Math.abs(Math.cos(2 * angle)), 0.4);
  const pointR = maxR * (0.25 + 0.75 * starFactor);

  if (dist < pointR) return true;

  return false;
}

// === Thin divider line check ===
function isOnDivider(normAngle, dist, innerR, outerR, lineWidth) {
  if (dist < innerR || dist > outerR) return false;
  const boundaries = [90, 210, 330];
  for (const b of boundaries) {
    let diff = Math.abs(normAngle - b);
    if (diff > 180) diff = 360 - diff;
    // Convert angular distance to pixel distance at this radius
    const pixelDist = degToRad(diff) * dist;
    if (pixelDist < lineWidth) return true;
  }
  return false;
}

function createIcon(size) {
  const png = new PNG({ width: size, height: size });
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Outside circle = transparent
      if (dist > r) {
        png.data[idx] = 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 0;
        continue;
      }

      // Anti-aliasing at edge
      let alpha = 255;
      if (dist > r - 1.5) {
        alpha = Math.max(0, Math.min(255, Math.round((r - dist) / 1.5 * 255)));
      }

      // Get angle in degrees (0 = right, clockwise)
      const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
      const normAngle = ((angleDeg % 360) + 360) % 360;

      // Thin dark divider lines between sectors
      const dividerWidth = Math.max(1, size * 0.015);
      if (isOnDivider(normAngle, dist, r * 0.15, r, dividerWidth)) {
        png.data[idx] = 30;
        png.data[idx + 1] = 30;
        png.data[idx + 2] = 35;
        png.data[idx + 3] = alpha;
        continue;
      }

      // Determine sector
      const sectorIdx = getSector(normAngle);
      const sector = SECTORS[sectorIdx];

      // Check if this pixel is part of the symbol
      const isSymbol = sector.drawSymbol(x, y, cx, cy, r);

      const color = isSymbol ? sector.brand.fg : sector.brand.bg;

      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = alpha;
    }
  }

  return png;
}

// Generate icons
const outDir = path.join(__dirname, '..', 'public', 'icons');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

for (const size of [16, 48, 128]) {
  const png = createIcon(size);
  const buffer = PNG.sync.write(png);
  const filePath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(filePath, buffer);
  console.log(`Generated: ${filePath} (${size}x${size})`);
}

console.log('Done! Three AI icons spliced into one circle (120° each)');
