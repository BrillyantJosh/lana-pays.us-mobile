/**
 * Client-side image compression for receipt uploads.
 *
 * Receipt photos from modern phones can easily be 5–15 MB. On a slow
 * connection (3G / EDGE / weak Wi-Fi) that means 2–5 minutes just for
 * the upload, often timing out. We resize the image on-device using
 * the Canvas API before sending it to the server — typical 8 MB JPEG
 * shrinks to 300–500 KB while staying perfectly readable for Claude
 * Vision (1920 px is more than enough for OCR on a receipt).
 *
 * Strategy:
 *   • Skip if file is already small (< SKIP_THRESHOLD)
 *   • Skip if not a recognised raster image (PDFs, HEIC w/o decoder…)
 *   • Resize so the longest edge ≤ MAX_DIMENSION
 *   • Re-encode as JPEG quality 0.85
 *   • Fall back to the original file if anything throws
 */

const MAX_DIMENSION   = 1920;            // longest edge in pixels
const JPEG_QUALITY    = 0.85;
const SKIP_THRESHOLD  = 800 * 1024;       // 800 KB — already small enough
const COMPRESSIBLE    = ['image/jpeg', 'image/png', 'image/webp'];

export interface CompressionResult {
  /** The file to actually upload — compressed when worthwhile, otherwise the original. */
  file: File;
  /** Original size in bytes. */
  originalSize: number;
  /** Final size in bytes (== originalSize when no compression happened). */
  finalSize: number;
  /** True when we actually re-encoded; false when we kept the original. */
  compressed: boolean;
}

/**
 * Compress an image file in the browser. Always resolves — never throws —
 * so callers can use the returned `file` blindly.
 */
export async function compressImage(input: File): Promise<CompressionResult> {
  const originalSize = input.size;

  // Bail out early when there's nothing useful to do
  if (originalSize <= SKIP_THRESHOLD) {
    return { file: input, originalSize, finalSize: originalSize, compressed: false };
  }
  if (!COMPRESSIBLE.includes(input.type)) {
    return { file: input, originalSize, finalSize: originalSize, compressed: false };
  }

  try {
    const dataUrl = await readAsDataURL(input);
    const img     = await loadImage(dataUrl);

    // Compute target dimensions while preserving aspect ratio
    const { width, height } = fitInside(img.naturalWidth, img.naturalHeight, MAX_DIMENSION);

    const canvas = document.createElement('canvas');
    canvas.width  = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');

    ctx.drawImage(img, 0, 0, width, height);

    const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    if (!blob) throw new Error('canvas.toBlob returned null');

    // If compression somehow made it bigger (rare — tiny PNGs), keep the original
    if (blob.size >= originalSize) {
      return { file: input, originalSize, finalSize: originalSize, compressed: false };
    }

    const newName = renameToJpeg(input.name);
    const compressed = new File([blob], newName, { type: 'image/jpeg', lastModified: Date.now() });

    return { file: compressed, originalSize, finalSize: compressed.size, compressed: true };
  } catch (e) {
    // Any failure → fall back to original. Better to upload slowly than to fail.
    console.warn('[compress-image] compression failed, falling back to original:', e);
    return { file: input, originalSize, finalSize: originalSize, compressed: false };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function fitInside(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = w / h;
  return ratio >= 1
    ? { width: max,                height: Math.round(max / ratio) }
    : { width: Math.round(max * ratio), height: max               };
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('failed to decode image'));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

function renameToJpeg(name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.jpg`;
}
