const sharp = require('sharp');
const path = require('path');

// 圖示來源：與 multi-ai-chat-desktop 一致的中性「四圓交集」標誌（512×512，已含透明背景）。
// 用中性圖而非各家 logo，是為了避開 Chrome Web Store 的商標審查風險。
// 來源本身就是透明底，不再需要去背 flood fill——直接縮圖並保留 alpha 即可。
const src = path.join(__dirname, '..', 'icon-source.png');
const outDir = path.join(__dirname, '..', 'public', 'icons');

async function main() {
  const meta = await sharp(src).metadata();
  console.log(`Source: ${meta.width}x${meta.height}`);

  for (const size of [16, 48, 128]) {
    const outPath = path.join(outDir, `icon${size}.png`);
    await sharp(src)
      .resize(size, size, {
        fit: 'contain',
        kernel: 'lanczos3',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(outPath);
    console.log(`Generated: icon${size}.png (${size}x${size})`);
  }

  console.log('Done!');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
