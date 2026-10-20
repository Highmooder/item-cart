// WHAT: shrinks a photo in the person's browser BEFORE it is uploaded.
// WHY: phone cameras make 3-8 MB photos, but Item cart shows them about 400 px
// wide. Uploading them as they are would use up the free storage (about 1 GB)
// and download allowance (about 5 GB a month) after a few hundred products,
// and make every page slower to load on student data plans.
// RESULT: a typical photo goes from several MB to roughly 60-250 KB, with no
// visible difference at the sizes the site shows.
// SAFE: if anything goes wrong while shrinking, the original photo is used
// (as long as it is within the old 3 MB limit), so an upload never fails
// because of this file.

export const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024; // what a person may pick; we shrink it
const KEEP_AS_IS_BYTES = 150 * 1024;                 // already small: leave it alone
const OLD_LIMIT_BYTES = 3 * 1024 * 1024;             // used only if shrinking is impossible
const GOOD_ENOUGH_BYTES = 400 * 1024;                // stop trying smaller once under this

// Each try: longest side in pixels, and quality (0 to 1).
const ATTEMPTS = [
  [1200, 0.82],
  [1000, 0.72],
  [800, 0.6],
];

// Returns { ok: true, file, before, after } or { ok: false, error }.
export async function prepareImage(file) {
  if (!file) return { ok: true, file };

  let source;
  try {
    source = await decode(file);
  } catch (error) {
    return fallback(file);
  }

  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  if (!width || !height) return fallback(file);

  // Small enough in bytes and in pixels already: nothing to gain.
  if (file.size <= KEEP_AS_IS_BYTES && Math.max(width, height) <= ATTEMPTS[0][0]) {
    closeSource(source);
    return { ok: true, file, before: file.size, after: file.size };
  }

  let best = null;
  try {
    for (const [side, quality] of ATTEMPTS) {
      const scale = Math.min(1, side / Math.max(width, height));
      best = await encode(source, Math.round(width * scale), Math.round(height * scale), quality);
      if (best && best.size <= GOOD_ENOUGH_BYTES) break;
    }
  } catch (error) {
    best = null;
  }
  closeSource(source);

  if (!best) return fallback(file);
  // Never make a photo bigger than the one the person chose.
  if (best.size >= file.size && file.size <= OLD_LIMIT_BYTES) return { ok: true, file, before: file.size, after: file.size };

  const extension = best.type === "image/webp" ? "webp" : "jpg";
  const baseName = (file.name || "photo").replace(/\.[^.]+$/, "") || "photo";
  const shrunk = new File([best], `${baseName}.${extension}`, { type: best.type });
  return { ok: true, file: shrunk, before: file.size, after: shrunk.size };
}

// Shrinking wasn't possible: use the original if the old limit allows it.
function fallback(file) {
  if (file.size <= OLD_LIMIT_BYTES) return { ok: true, file, before: file.size, after: file.size };
  return { ok: false, error: "We couldn't read that photo. Try a different one." };
}

// Opens the photo as pixels. Phone photos carry a "which way is up" note
// (EXIF); asking for "from-image" makes sure upright photos stay upright.
async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (error) {
      /* older browser: try the plain way */
    }
    try {
      return await createImageBitmap(file);
    } catch (error) {
      /* fall through to an <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function closeSource(source) {
  if (source && typeof source.close === "function") source.close();
}

// WebP is smallest. If this browser can't make WebP, use JPEG on a white
// background (JPEG has no see-through areas).
async function encode(source, width, height, quality) {
  const webp = await draw(source, width, height, "image/webp", quality, false);
  if (webp && webp.type === "image/webp") return webp;
  return draw(source, width, height, "image/jpeg", quality, true);
}

function draw(source, width, height, type, quality, whiteBackground) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  if (whiteBackground) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(source, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
