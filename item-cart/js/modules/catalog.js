import { getSupabase, isBackendConfigured } from "./backend.js";
import { schools } from "../data/schools.js";
import { categories } from "../data/categories.js";
import { vendors } from "../data/vendors.js";
import { products } from "../data/products.js";
import { ITEMCART_CONFIG } from "../data/config.js";

// WHAT: loads schools, categories, vendors, products and money settings
// from Supabase ONCE per page, and pours them into the same arrays the
// rest of the site already reads (data/*.js).
// WHY: every page, search, cart and render helper keeps working
// unchanged — they still call getVendorById(), products.filter(), and so
// on. The only difference is where the data comes from. Arrays are
// updated in place so existing imports see the new data.
// FALLBACK: if Supabase isn't configured yet, the sample data in
// data/*.js is left alone so you can keep building offline.
// FUTURE: category/product filtering can move into the query (server-side)
// once the catalog is too big to load whole.

let loadPromise = null;

export function loadCatalog() {
  if (!loadPromise) loadPromise = doLoad();
  return loadPromise;
}

function replaceContents(target, items) {
  target.splice(0, target.length, ...items);
}

const toSchool = (r) => ({ id: r.id, name: r.name, abbreviation: r.abbreviation, location: r.location, active: r.active });
const toCategory = (r) => ({ id: r.id, name: r.name, icon: r.icon });
// Vendor phone, WhatsApp and email are deliberately NOT loaded here:
// customers reach vendors through on-site chat, so the storefront never
// needs them.
const VENDOR_PUBLIC_COLUMNS = "id, store_name, description, category_id, location, school_id, rating, verified, active, image, created_at";
const toVendor = (r) => ({
  id: r.id,
  storeName: r.store_name,
  description: r.description,
  category: r.category_id,
  location: r.location,
  schoolId: r.school_id,
  rating: Number(r.rating),
  verified: r.verified,
  active: r.active,
  image: r.image || "",
  createdAt: r.created_at,
});
const toProduct = (r) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  price: r.price,
  image: r.image || "",
  categoryId: r.category_id,
  vendorId: r.vendor_id,
  schoolId: r.school_id,
  rating: Number(r.rating),
  availability: r.availability,
  createdAt: r.created_at,
});

async function doLoad() {
  if (!isBackendConfigured) return { ok: true, source: "local" };

  try {
    const supabase = await getSupabase();
    const [s, c, v, p, st] = await Promise.all([
      supabase.from("schools").select("*").order("name"),
      supabase.from("categories").select("*").order("name"),
      supabase.from("vendors").select(VENDOR_PUBLIC_COLUMNS).order("created_at", { ascending: false }),
      supabase.from("products").select("*").order("created_at", { ascending: false }),
      supabase.from("settings").select("*"),
    ]);
    const failed = [s, c, v, p, st].find((r) => r.error);
    if (failed) throw failed.error;

    // The shop shows ONLY active vendors and approved, active products, whoever is looking.
    // The database already hides removed items from the public, but it lets
    // admins see them (so the admin page can manage them). Without this
    // filter, an admin signed in on the same browser would still see items
    // they had just removed. Admins manage hidden items in admin.html.
    // The Item cart Admin support inbox is a hidden "store" used only for chat; never list it.
    const liveVendors = v.data.filter((row) => row.active !== false && row.id !== ITEMCART_CONFIG.supportVendorId);
    const liveVendorIds = new Set(liveVendors.map((row) => row.id));
    // "status" only exists once 09_vendor_products.sql is run; until then every
    // product counts as approved. Waiting and rejected products never show.
    const liveProducts = p.data.filter(
      (row) => row.active !== false && (row.status === undefined || row.status === "approved") && liveVendorIds.has(row.vendor_id)
    );

    replaceContents(schools, s.data.filter((row) => row.active !== false).map(toSchool));
    replaceContents(categories, c.data.map(toCategory));
    replaceContents(vendors, liveVendors.map(toVendor));
    replaceContents(products, liveProducts.map(toProduct));

    // Money settings live in the database; the checkout page only
    // DISPLAYS them — the server charges from the same table.
    const settings = Object.fromEntries(st.data.map((row) => [row.key, Number(row.value)]));
    if (Number.isFinite(settings.delivery_fee)) ITEMCART_CONFIG.deliveryFee = settings.delivery_fee;
    if (Number.isFinite(settings.commission_rate)) ITEMCART_CONFIG.commissionRate = settings.commission_rate;

    return { ok: true, source: "supabase" };
  } catch (error) {
    console.error("Item cart: could not load the catalog.", error);
    // Don't mix half-loaded data with the sample catalog.
    [schools, categories, vendors, products].forEach((list) => replaceContents(list, []));
    showCatalogError();
    return { ok: false, error };
  }
}

function showCatalogError() {
  const main = document.getElementById("main-content");
  if (!main) return;
  const banner = document.createElement("div");
  banner.className = "form-submit-error container";
  banner.style.display = "block";
  banner.setAttribute("role", "alert");
  banner.textContent = "We couldn't load the marketplace. Check your internet connection and refresh the page.";
  main.prepend(banner);
}
