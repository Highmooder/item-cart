// Category data model.
// `icon` refers to a key in js/modules/icons.js — kept separate from
// markup so categories stay plain data.

export const categories = [
  { id: "food", name: "Food & Drinks", icon: "food" },
  { id: "fashion", name: "Fashion", icon: "fashion" },
  { id: "electronics", name: "Electronics", icon: "electronics" },
  { id: "beauty", name: "Beauty", icon: "beauty" },
  { id: "academic", name: "Academic", icon: "academic" },
  { id: "accessories", name: "Accessories", icon: "accessories" },
  { id: "hostel", name: "Hostel & Home", icon: "hostel" },
  { id: "services", name: "Services", icon: "services" },
  { id: "others", name: "Others", icon: "others" },
];

export function getCategoryById(id) {
  return categories.find((category) => category.id === id);
}
