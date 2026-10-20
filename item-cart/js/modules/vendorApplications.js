import { getSupabase, isBackendConfigured } from "./backend.js";

// WHAT: sends a vendor application from the "Become a Vendor" form to
// Supabase.
// WHY: the page only deals in plain data and a {success, error} result,
// so how it's stored can change without touching become-vendor.js.
// Applications are NEVER auto-approved: they start as "pending_review"
// and only become a vendor when an admin approves them in admin.html.
// SPAM PROTECTION: the form calls the submit_vendor_application database
// function (database/13_application_spam_protection.sql), which checks a
// hidden trap field, how long the form was open, duplicates and overall
// limits before saving anything. The public key can no longer write to the
// table directly once that file has been run.
// BEFORE THAT FILE IS RUN, the function doesn't exist yet. In that case we
// fall back to the old direct save so applications keep working during the
// switch-over (and the old way simply stops working after the SQL is run).

const FRIENDLY_ERROR = "Your application could not be submitted. Please check your details and try again.";

function isMissingFunction(error) {
  return Boolean(error) && (error.code === "PGRST202" || /could not find the function/i.test(error.message || ""));
}

export async function submitApplication(data) {
  if (!isBackendConfigured) {
    return { success: false, error: "Applications aren't open yet. Please check back soon." };
  }

  try {
    const supabase = await getSupabase();
    const { error } = await supabase.rpc("submit_vendor_application", {
      p_store_name: data.storeName,
      p_owner_name: data.ownerName,
      p_phone: data.phone,
      p_whatsapp: data.whatsapp,
      p_email: data.email,
      p_school_id: data.schoolId,
      p_category_id: data.category,
      p_location: data.location,
      p_description: data.description,
      p_website: data.website || "",
      p_elapsed_ms: Math.round(Number(data.elapsedMs) || 0),
    });

    if (!error) return { success: true };

    // The database wrote these messages on purpose (limits, duplicates...), so show them.
    if (error.code === "P0001" && error.message) return { success: false, error: error.message };

    if (isMissingFunction(error)) return await legacyInsert(supabase, data);

    console.warn("Item cart: vendor application was rejected.", error);
    return { success: false, error: FRIENDLY_ERROR };
  } catch (error) {
    console.warn("Item cart: could not reach the server.", error);
    return { success: false, error: "We couldn't reach the server. Check your internet connection and try again." };
  }
}

// The original save, used only until 13_application_spam_protection.sql has been run.
async function legacyInsert(supabase, data) {
  const { error } = await supabase.from("vendor_applications").insert({
    store_name: data.storeName,
    owner_name: data.ownerName,
    phone: data.phone,
    whatsapp: data.whatsapp,
    email: data.email,
    school_id: data.schoolId,
    category_id: data.category,
    location: data.location,
    description: data.description,
  });
  if (error) {
    console.warn("Item cart: vendor application was rejected.", error);
    return { success: false, error: FRIENDLY_ERROR };
  }
  return { success: true };
}
