import { renderHeader, renderFooter } from "../modules/layout.js";
import { loadCatalog } from "../modules/catalog.js";
import { categories } from "../data/categories.js";
import { schools } from "../data/schools.js";
import { submitApplication } from "../modules/vendorApplications.js";
import { icon } from "../modules/icons.js";

const BENEFITS = [
  { iconName: "user", title: "Reach students directly", body: "Get discovered by students already searching the Item cart marketplace for what you sell." },
  { iconName: "cart", title: "Receive real orders", body: "Orders come to you through Item cart, organized and easy to fulfill — no more scattered DMs." },
  { iconName: "star", title: "Build a store profile", body: "Your ratings, products, and story live in one place students can browse and trust." },
  { iconName: "whatsapp", title: "Stay in direct contact", body: "Coordinate delivery and pickup with customers on WhatsApp once an order is placed." },
];

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader("become-vendor.html");
  renderFooter();
  await loadCatalog();

  renderBenefits();
  populateSchoolSelect();
  populateCategorySelect();
  wireForm();
});

function renderBenefits() {
  const grid = document.getElementById("benefits-grid");
  if (!grid) return;
  grid.innerHTML = BENEFITS.map(
    (b) => `
      <div class="benefit-item">
        <span class="benefit-item__icon">${icon(b.iconName)}</span>
        <h3>${b.title}</h3>
        <p>${b.body}</p>
      </div>
    `
  ).join("");
}

function populateSchoolSelect() {
  const select = document.getElementById("school-input");
  if (!select) return;
  select.innerHTML = schools
    .filter((school) => school.active)
    .map((school) => `<option value="${school.id}">${school.name} (${school.abbreviation})</option>`)
    .join("");
}

function populateCategorySelect() {
  const select = document.getElementById("category-input");
  if (!select) return;
  select.innerHTML = categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
}

// A person needs a few seconds to fill this in. Anything faster is a script.
// (The database enforces the same minimum, so this only saves a round trip.)
const MIN_FILL_MS = 3000;

function wireForm() {
  const form = document.getElementById("vendor-form");
  if (!form) return;

  const shownAt = Date.now();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors();
    hideSubmitError();

    const values = {
      storeName: form.storeName.value.trim(),
      ownerName: form.ownerName.value.trim(),
      phone: form.phone.value.trim(),
      whatsapp: form.whatsapp.value.trim(),
      email: form.email.value.trim(),
      schoolId: form.schoolId.value,
      category: form.category.value,
      location: form.location.value.trim(),
      description: form.description.value.trim(),
      website: form.website ? form.website.value.trim() : "",
      elapsedMs: Date.now() - shownAt,
    };

    const errors = validate(values);
    if (Object.keys(errors).length > 0) {
      showErrors(errors);
      return;
    }

    // The hidden trap box was filled in: a bot. Look successful, send nothing.
    if (values.website) {
      showSuccess();
      return;
    }

    if (values.elapsedMs < MIN_FILL_MS) {
      showSubmitError("That was quick! Please check your details and press Submit again.");
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    const idleLabel = submitBtn ? submitBtn.textContent : "";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";
    }

    const result = await submitApplication(values);

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = idleLabel;
    }
    if (!result.success) {
      showSubmitError(result.error || "Your application could not be submitted. Please try again.");
      return;
    }

    showSuccess();
  });
}

function validate(values) {
  const errors = {};
  if (!values.storeName) errors.storeName = "Store or business name is required.";
  else if (values.storeName.length > 120) errors.storeName = "Keep the store name under 120 characters.";
  if (!values.ownerName) errors.ownerName = "Owner name is required.";
  if (!/^[0-9+()\-\s]{7,}$/.test(values.phone)) errors.phone = "Enter a valid phone number.";
  if (!/^[0-9+()\-\s]{7,}$/.test(values.whatsapp)) errors.whatsapp = "Enter a valid WhatsApp number.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = "Enter a valid email address.";
  if (!values.location) errors.location = "Location is required.";
  else if (values.location.length > 200) errors.location = "Keep the location under 200 characters.";
  if (!values.description || values.description.length < 10) {
    errors.description = "Tell students a bit more about your business (at least 10 characters).";
  } else if (values.description.length > 1000) {
    errors.description = "Keep the description under 1,000 characters.";
  }
  return errors;
}

function clearErrors() {
  document.querySelectorAll(".field-error").forEach((el) => (el.textContent = ""));
  document.querySelectorAll(".has-error").forEach((el) => el.classList.remove("has-error"));
}

function showErrors(errors) {
  Object.entries(errors).forEach(([field, message]) => {
    const errorEl = document.getElementById(`${field}-error`);
    const inputEl = document.getElementById(`${field}-input`);
    if (errorEl) errorEl.textContent = message;
    if (inputEl) inputEl.classList.add("has-error");
  });
  const firstField = Object.keys(errors)[0];
  document.getElementById(`${firstField}-input`)?.focus();
}

function showSubmitError(message) {
  const el = document.getElementById("vendor-submit-error");
  el.textContent = message;
  el.style.display = "block";
}

function hideSubmitError() {
  const el = document.getElementById("vendor-submit-error");
  el.style.display = "none";
}

function showSuccess() {
  document.getElementById("vendor-form-wrap").style.display = "none";
  document.getElementById("vendor-success-icon").innerHTML = icon("verified");
  document.getElementById("vendor-success").style.display = "block";
}
