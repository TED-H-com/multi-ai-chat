const path = require('path');
const sharp = require('sharp');

const width = 1280;
const height = 800;
const rootDir = path.join(__dirname, '..');
const sourcePath = path.join(rootDir, 'screenshot.png');
const outputPath = path.join(rootDir, 'store', 'screenshot-1280x800.png');

async function main() {
  await sharp(sourcePath)
    .resize(width, height, {
      fit: 'cover',
      position: 'centre',
      kernel: 'lanczos3',
    })
    .removeAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(outputPath);

  const metadata = await sharp(outputPath).metadata();
  if (
    metadata.width !== width ||
    metadata.height !== height ||
    metadata.format !== 'png' ||
    metadata.hasAlpha
  ) {
    throw new Error(
      `Unexpected output: ${metadata.width}x${metadata.height} ${metadata.format}, alpha=${metadata.hasAlpha}`,
    );
  }

  console.log(`Generated: ${path.relative(rootDir, outputPath)} (${width}x${height}, full bleed)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
