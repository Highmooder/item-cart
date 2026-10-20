// Vendor data model.
// Sample/fictional vendors for the UNIOSUN launch. Each vendor carries
// its own whatsapp number, used purely as a communication channel for
// order coordination — never as the purchasing mechanism itself.
// Orders are placed and recorded by Item cart (see js/data/orders.js).
//
// Commission is deliberately NOT stored per vendor: Item cart's cut is
// computed centrally from ITEMCART_CONFIG.commissionRate (see
// js/data/config.js and js/modules/finance.js), which is 0 during
// launch. Keeping commission out of this file is what lets that rate
// change later without touching vendor records at all.
//
// `verified` and `active` are prototype-only state: `verified` shows
// a "Verified Vendor" badge (no real identity check has happened
// behind it), and `active` controls whether the vendor's store page
// is browsable — inactive vendors show a friendly notice instead.

export const vendors = [
  {
    id: "v-mama-ket",
    storeName: "Mama Ket Kitchen",
    ownerName: "Kehinde Adeyemi",
    phone: "+2348030000001",
    whatsapp: "+2348030000001",
    email: "mamaket.kitchen@example.com",
    description: "Home-style Nigerian meals cooked fresh daily, a short walk from the main gate.",
    category: "food",
    location: "Behind Faculty of Science, UNIOSUN",
    schoolId: "uniosun",
    rating: 4.8,
    verified: true,
    active: true,
    createdAt: "2026-07-01",
    image: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=400&auto=format&fit=crop",
  },
  {
    id: "v-thriftline",
    storeName: "Thriftline Fits",
    ownerName: "Aisha Bello",
    phone: "+2348030000002",
    whatsapp: "+2348030000002",
    email: "thriftline.fits@example.com",
    description: "Curated thrift and streetwear picks, sized and priced for students.",
    category: "fashion",
    location: "Odi-Olowo Road, near UNIOSUN gate",
    schoolId: "uniosun",
    rating: 4.6,
    verified: true,
    active: true,
    createdAt: "2026-07-10",
    image: "https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?q=80&w=400&auto=format&fit=crop",
  },
  {
    id: "v-gadgethub",
    storeName: "GadgetHub Osogbo",
    ownerName: "Tunde Fashola",
    phone: "+2348030000003",
    whatsapp: "+2348030000003",
    email: "gadgethub.osogbo@example.com",
    description: "Phone accessories, chargers, and earbuds with same-day campus pickup.",
    category: "electronics",
    location: "Student Plaza, UNIOSUN",
    schoolId: "uniosun",
    rating: 4.7,
    verified: false,
    active: true,
    createdAt: "2026-08-05",
    image: "https://images.unsplash.com/photo-1512499617640-c74ae3a79d37?q=80&w=400&auto=format&fit=crop",
  },
  {
    id: "v-glowbar",
    storeName: "Glow Bar Naturals",
    ownerName: "Feyisayo Ogundele",
    phone: "+2348030000004",
    whatsapp: "+2348030000004",
    email: "glowbar.naturals@example.com",
    description: "Perfumes, body sprays, and hair products for the campus look.",
    category: "beauty",
    location: "Ladies Hostel Road, UNIOSUN",
    schoolId: "uniosun",
    rating: 4.5,
    verified: false,
    active: false,
    createdAt: "2026-08-12",
    image: "https://images.unsplash.com/photo-1512207736890-6ffef4ecb42b?q=80&w=400&auto=format&fit=crop",
  },
  {
    id: "v-brightpage",
    storeName: "BrightPage Stationery",
    ownerName: "Chidera Nwosu",
    phone: "+2348030000005",
    whatsapp: "+2348030000005",
    email: "brightpage.stationery@example.com",
    description: "Textbooks, calculators, and same-day printing for assignments.",
    category: "academic",
    location: "Opposite Faculty of Law, UNIOSUN",
    schoolId: "uniosun",
    rating: 4.9,
    verified: true,
    active: true,
    createdAt: "2026-06-20",
    image: "https://images.unsplash.com/photo-1553729459-efe14ef6055d?q=80&w=400&auto=format&fit=crop",
  },
  {
    id: "v-hostelbasics",
    storeName: "Hostel Basics",
    ownerName: "Grace Effiong",
    phone: "+2348030000006",
    whatsapp: "+2348030000006",
    email: "hostelbasics@example.com",
    description: "Bedsheets, extension boxes, and laundry pickup for hostel students.",
    category: "hostel",
    location: "Female Hostel Complex, UNIOSUN",
    schoolId: "uniosun",
    rating: 4.4,
    verified: true,
    active: true,
    createdAt: "2026-07-25",
    image: "https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?q=80&w=400&auto=format&fit=crop",
  },
  {
    id: "v-swiftrepairs",
    storeName: "Swift Repairs",
    ownerName: "Damilola Okafor",
    phone: "+2348030000007",
    whatsapp: "+2348030000007",
    email: "swiftrepairs@example.com",
    description: "Phone and laptop repair service, newly listed on Item cart — product listings coming soon.",
    category: "services",
    location: "Behind Student Union Building, UNIOSUN",
    schoolId: "uniosun",
    rating: 0,
    verified: false,
    active: true,
    createdAt: "2026-09-10",
    image: "https://images.unsplash.com/photo-1581092160607-ee22621dd758?q=80&w=400&auto=format&fit=crop",
  },
];

export function getVendorById(id) {
  return vendors.find((vendor) => vendor.id === id);
}
