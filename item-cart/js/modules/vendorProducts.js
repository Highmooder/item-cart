import { getSupabase } from "./backend.js";
import { prepareImage, MAX_ORIGINAL_BYTES } from "./imageResize.js";

// WHAT: everything a vendor's team needs to manage their own products:
// list them, submit new ones, edit, pause, withdraw an edit, remove, and
// upload photos.
// WHY: pages call these small functions and get {ok, data, error} back.
// SECURITY: the database decides everything. A vendor can't publish — new
// products and every edit wait for admin approval (09_vendor_products.sql).
// FUTURE: bulk upload, and stock counts.

const BUCKET = "catalog-images";
export const MAX_IMAGE_BYTES = MAX_ORIGINAL_BYTES; // big photos are shrunk before upload (imageResize.js)
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

async function rpc(name, args) {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc(name, args);
    if (error) return { ok: false, error: friendlyError(error) };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

export function listProducts(vendorId) {
  return rpc("vendor_list_products", { p_vendor_id: vendorId });
}

const fields = (f) => ({
  p_name: f.name,
  p_description: f.description,
  p_price: f.price,
  p_category_id: f.categoryId,
  p_image: f.image || null,
  p_availability: f.availability,
});

export function submitProduct(vendorId, f) {
  return rpc("vendor_submit_product", { p_vendor_id: vendorId, ...fields(f) });
}

export function editProduct(productId, f) {
  return rpc("vendor_edit_product", { p_product_id: productId, ...fields(f) });
}

export function pauseProduct(productId) {
  return rpc("vendor_pause_product", { p_product_id: productId });
}

export function withdrawEdit(productId) {
  return rpc("vendor_withdraw_edit", { p_product_id: productId });
}

export function removeProduct(productId) {
  return rpc("vendor_remove_product", { p_product_id: productId });
}

export function checkImage(file) {
  if (!file) return "";
  if (!IMAGE_TYPES.includes(file.type)) return "Use a JPG, PNG or WebP photo.";
  if (file.size > MAX_IMAGE_BYTES) return "That photo is over 15 MB. Choose a smaller one.";
  return "";
}

// Photos go into this store's own folder; the database refuses anywhere else.
export async function uploadPhoto(vendorId, original) {
  try {
    // Shrink first: phone photos are several MB, the site shows them ~400 px wide.
    const prepared = await prepareImage(original);
    if (!prepared.ok) return { ok: false, error: prepared.error };
    const file = prepared.file;

    const supabase = await getSupabase();
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = `vendor-products/${vendorId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });
    if (error) return { ok: false, error: "We couldn't upload that photo. Please try again." };
    return { ok: true, url: supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

export function friendlyError(error) {
  const msg = (error && error.message) || "";
  // P0001 = a message we wrote on purpose in the database function.
  if (error && error.code === "P0001" && msg) return msg;
  if (error && (error.code === "PGRST202" || /could not find the function/i.test(msg))) return "Product posting isn't set up yet. Please try again later.";
  if (/JWT|not authenticated|expired/i.test(msg)) return "Your session expired. Please sign in again.";
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Couldn't reach the server. Check your internet connection.";
  return "Something went wrong. Please try again.";
}
