import fs from "fs";
import path from "path";
import zlib from "zlib";
import { execSync } from "child_process";

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodeRgbaToPng(width: number, height: number, rawScanlines: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idatData = zlib.deflateSync(rawScanlines, { level: 6 });
  return Buffer.concat([
    signature,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", idatData),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * High-detail programmatic fallback icon with Royal Navy squircle, Gold Architectural Compass,
 * and Cyan Neural Core if ffmpeg/ImageMagick is not installed.
 */
function createCompassLogoPng(size: number, maskable: boolean = false): Buffer {
  const width = size;
  const height = size;
  const rawData = Buffer.alloc(height * (1 + width * 4));
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size * (maskable ? 0.36 : 0.42);
  const cornerRadius = maskable ? 0 : Math.round(size * 0.22);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    rawData[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;

      let insideBg = true;
      if (!maskable) {
        if (x < cornerRadius && y < cornerRadius) {
          insideBg = Math.hypot(cornerRadius - x, cornerRadius - y) <= cornerRadius;
        } else if (x >= width - cornerRadius && y < cornerRadius) {
          insideBg = Math.hypot(x - (width - cornerRadius - 1), cornerRadius - y) <= cornerRadius;
        } else if (x < cornerRadius && y >= height - cornerRadius) {
          insideBg = Math.hypot(cornerRadius - x, y - (height - cornerRadius - 1)) <= cornerRadius;
        } else if (x >= width - cornerRadius && y >= height - cornerRadius) {
          insideBg =
            Math.hypot(x - (width - cornerRadius - 1), y - (height - cornerRadius - 1)) <=
            cornerRadius;
        }
      }

      if (!insideBg) {
        rawData[px] = 0;
        rawData[px + 1] = 0;
        rawData[px + 2] = 0;
        rawData[px + 3] = 0;
        continue;
      }

      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);

      // Deep Royal Navy gradient background
      const radialGlow = Math.max(0, 1 - dist / (size * 0.6));
      let r = Math.round(11 + radialGlow * 14);
      let g = Math.round(20 + radialGlow * 32);
      let b = Math.round(44 + radialGlow * 65);

      // Outer gold compass ring
      const onOuterRing = Math.abs(dist - maxR * 0.85) < size * 0.014;
      const onInnerRing = Math.abs(dist - maxR * 0.55) < size * 0.01;

      // Compass legs (Gold #F59E0B -> 245, 185, 45)
      const ny = (y - (cy - maxR * 0.78)) / (maxR * 1.55);
      const legSpread = ny * maxR * 0.58;
      const onLeftLeg =
        ny >= 0 && ny <= 1 && Math.abs(dx + legSpread) < size * 0.032 * (1 - ny * 0.35);
      const onRightLeg =
        ny >= 0 && ny <= 1 && Math.abs(dx - legSpread) < size * 0.032 * (1 - ny * 0.35);
      const onTopHinge = Math.hypot(dx, y - (cy - maxR * 0.72)) < size * 0.075;

      // Central cyan AI spark (#38BDF8 -> 56, 189, 248)
      const onCenterCore = dist < size * 0.085;
      const onCrosshair =
        (Math.abs(dx) < size * 0.008 && Math.abs(dy) < maxR * 0.85) ||
        (Math.abs(dy) < size * 0.008 && Math.abs(dx) < maxR * 0.85);

      if (onLeftLeg || onRightLeg || onTopHinge || onOuterRing) {
        r = 245;
        g = 190;
        b = 55;
      } else if (onCenterCore) {
        r = 56;
        g = 215;
        b = 255;
      } else if (onInnerRing || onCrosshair) {
        r = 34;
        g = 165;
        b = 230;
      }

      rawData[px] = r;
      rawData[px + 1] = g;
      rawData[px + 2] = b;
      rawData[px + 3] = 255;
    }
  }

  return encodeRgbaToPng(width, height, rawData);
}

function createScreenshotPng(width: number, height: number): Buffer {
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    rawData[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      // Clean dark slate header + modern UI card preview
      if (y < height * 0.14) {
        rawData[px] = 15;
        rawData[px + 1] = 23;
        rawData[px + 2] = 42;
      } else if (
        x > width * 0.06 &&
        x < width * 0.94 &&
        y > height * 0.2 &&
        y < height * 0.86
      ) {
        rawData[px] = 255;
        rawData[px + 1] = 255;
        rawData[px + 2] = 255;
      } else {
        rawData[px] = 241;
        rawData[px + 1] = 245;
        rawData[px + 2] = 249;
      }
      rawData[px + 3] = 255;
    }
  }
  return encodeRgbaToPng(width, height, rawData);
}

const publicDir = path.join(process.cwd(), "public");
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const generatedJpgLogo = path.join(
  process.cwd(),
  "src/assets/images/mr_hany_app_logo_1793557082254.jpg"
);

let convertedWithTool = false;
if (fs.existsSync(generatedJpgLogo)) {
  try {
    execSync(
      `ffmpeg -y -i "${generatedJpgLogo}" -vf "scale=512:512" "${path.join(publicDir, "pwa-512x512.png")}" && ` +
        `ffmpeg -y -i "${generatedJpgLogo}" -vf "scale=512:512" "${path.join(publicDir, "pwa-maskable-512x512.png")}" && ` +
        `ffmpeg -y -i "${generatedJpgLogo}" -vf "scale=192:192" "${path.join(publicDir, "pwa-192x192.png")}" && ` +
        `ffmpeg -y -i "${generatedJpgLogo}" -vf "scale=180:180" "${path.join(publicDir, "apple-touch-icon.png")}" && ` +
        `ffmpeg -y -i "${generatedJpgLogo}" -vf "scale=64:64" "${path.join(publicDir, "favicon.ico")}"`,
      { stdio: "ignore" }
    );
    convertedWithTool = true;
    console.log("Converted AI-generated Mr. Hany logo into exact PNG icons via ffmpeg.");
  } catch {
    convertedWithTool = false;
  }
}

if (!convertedWithTool) {
  fs.writeFileSync(path.join(publicDir, "pwa-192x192.png"), createCompassLogoPng(192, false));
  fs.writeFileSync(path.join(publicDir, "pwa-512x512.png"), createCompassLogoPng(512, false));
  fs.writeFileSync(
    path.join(publicDir, "pwa-maskable-512x512.png"),
    createCompassLogoPng(512, true)
  );
  fs.writeFileSync(path.join(publicDir, "apple-touch-icon.png"), createCompassLogoPng(180, false));
  fs.writeFileSync(path.join(publicDir, "favicon.ico"), createCompassLogoPng(64, false));
  console.log("Generated high-detail Compass & Neural Core PNG icons in /public.");
}

fs.writeFileSync(path.join(publicDir, "screenshot-mobile.png"), createScreenshotPng(540, 720));
fs.writeFileSync(path.join(publicDir, "screenshot-wide.png"), createScreenshotPng(1280, 720));
console.log("Generated Rich Install UI screenshots in /public.");
