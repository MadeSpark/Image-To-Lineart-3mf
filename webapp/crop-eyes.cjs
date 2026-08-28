const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');
const outDir = 'D:/DevelopmentFolder/Nodejs/转向量/webapp/line-debug-output';
process.chdir(outDir);

async function crop(srcName, dstName, x, y, w, h, zoom = 1.5) {
  const src = await loadImage(srcName);
  const canvas = createCanvas(w * zoom, h * zoom);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, x, y, w, h, 0, 0, w * zoom, h * zoom);
  fs.writeFileSync(dstName, canvas.toBuffer('image/png'));
  console.log(`wrote ${dstName}`);
}

(async () => {
  const targets = [
    ['sim-preview-afterFloor.png',  'crop-preview-afterFloor-eyes.png'],
    ['sim-export-afterFloor.png',   'crop-export-afterFloor-eyes.png'],
    ['fixed-preview-shape.png',     'crop-fixed-preview-eyes.png'],
  ];
  for (const [src, dst] of targets) {
    await crop(src, dst, 310, 200, 250, 220, 2);
  }
})();
