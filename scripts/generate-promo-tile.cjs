const path = require('path');
const sharp = require('sharp');

const width = 440;
const height = 280;
const iconSize = 164;
const rootDir = path.join(__dirname, '..');
const iconPath = path.join(rootDir, 'icon-source.png');
const outputPath = path.join(rootDir, 'store', 'promo-small-440x280.png');

const background = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#061b3b"/>
        <stop offset="0.48" stop-color="#123d79"/>
        <stop offset="1" stop-color="#4b207f"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="48%" r="50%">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.18"/>
        <stop offset="0.6" stop-color="#74d7ff" stop-opacity="0.09"/>
        <stop offset="1" stop-color="#74d7ff" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="orbit" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ff9c47"/>
        <stop offset="0.34" stop-color="#39d6c3"/>
        <stop offset="0.67" stop-color="#5e9cff"/>
        <stop offset="1" stop-color="#dc5ee9"/>
      </linearGradient>
      <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="12"/>
      </filter>
    </defs>
    <rect width="440" height="280" fill="url(#background)"/>
    <ellipse cx="220" cy="136" rx="190" ry="132" fill="url(#glow)"/>
    <circle cx="220" cy="136" r="103" fill="none" stroke="url(#orbit)" stroke-width="2" stroke-opacity="0.34"/>
    <circle cx="220" cy="136" r="120" fill="none" stroke="#ffffff" stroke-width="1" stroke-opacity="0.10" stroke-dasharray="4 10"/>
    <circle cx="220" cy="136" r="78" fill="#8ecaff" fill-opacity="0.20" filter="url(#softGlow)"/>
    <circle cx="74" cy="55" r="34" fill="#ff8b46" fill-opacity="0.12"/>
    <circle cx="379" cy="218" r="48" fill="#d65ee7" fill-opacity="0.13"/>
    <circle cx="395" cy="51" r="18" fill="#43d6c1" fill-opacity="0.18"/>
    <circle cx="43" cy="232" r="24" fill="#5a99ff" fill-opacity="0.14"/>
  </svg>
`);

async function main() {
  const icon = await sharp(iconPath)
    .resize(iconSize, iconSize, {
      fit: 'contain',
      kernel: 'lanczos3',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await sharp(background)
    .composite([
      {
        input: icon,
        left: Math.round((width - iconSize) / 2),
        top: Math.round((height - iconSize) / 2) - 4,
      },
    ])
    .removeAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(outputPath);

  const metadata = await sharp(outputPath).metadata();
  if (metadata.width !== width || metadata.height !== height || metadata.format !== 'png') {
    throw new Error(`Unexpected output: ${metadata.width}x${metadata.height} ${metadata.format}`);
  }

  console.log(`Generated: ${path.relative(rootDir, outputPath)} (${width}x${height})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
