-- =====================================================================
-- Item cart — Phase 2: seed data (generated from js/data/*.js)
-- Run AFTER 01_schema.sql.
-- =====================================================================

insert into schools (id, name, abbreviation, location, active) values
  ('uniosun', 'Osun State University', 'UNIOSUN', 'Osogbo, Osun State', true);

insert into categories (id, name, icon) values
  ('food', 'Food & Drinks', 'food'),
  ('fashion', 'Fashion', 'fashion'),
  ('electronics', 'Electronics', 'electronics'),
  ('beauty', 'Beauty', 'beauty'),
  ('academic', 'Academic', 'academic'),
  ('accessories', 'Accessories', 'accessories'),
  ('hostel', 'Hostel & Home', 'hostel'),
  ('services', 'Services', 'services'),
  ('others', 'Others', 'others');

insert into vendors (id, store_name, owner_name, phone, whatsapp, email, description, category_id, location, school_id, rating, verified, active, image, created_at) values
  ('v-mama-ket', 'Mama Ket Kitchen', 'Kehinde Adeyemi', '+2348030000001', '+2348030000001', 'mamaket.kitchen@example.com', 'Home-style Nigerian meals cooked fresh daily, a short walk from the main gate.', 'food', 'Behind Faculty of Science, UNIOSUN', 'uniosun', 4.8, true, true, 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=400&auto=format&fit=crop', '2026-07-01'),
  ('v-thriftline', 'Thriftline Fits', 'Aisha Bello', '+2348030000002', '+2348030000002', 'thriftline.fits@example.com', 'Curated thrift and streetwear picks, sized and priced for students.', 'fashion', 'Odi-Olowo Road, near UNIOSUN gate', 'uniosun', 4.6, true, true, 'https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?q=80&w=400&auto=format&fit=crop', '2026-07-10'),
  ('v-gadgethub', 'GadgetHub Osogbo', 'Tunde Fashola', '+2348030000003', '+2348030000003', 'gadgethub.osogbo@example.com', 'Phone accessories, chargers, and earbuds with same-day campus pickup.', 'electronics', 'Student Plaza, UNIOSUN', 'uniosun', 4.7, false, true, 'https://images.unsplash.com/photo-1512499617640-c74ae3a79d37?q=80&w=400&auto=format&fit=crop', '2026-08-05'),
  ('v-glowbar', 'Glow Bar Naturals', 'Feyisayo Ogundele', '+2348030000004', '+2348030000004', 'glowbar.naturals@example.com', 'Perfumes, body sprays, and hair products for the campus look.', 'beauty', 'Ladies Hostel Road, UNIOSUN', 'uniosun', 4.5, false, false, 'https://images.unsplash.com/photo-1512207736890-6ffef4ecb42b?q=80&w=400&auto=format&fit=crop', '2026-08-12'),
  ('v-brightpage', 'BrightPage Stationery', 'Chidera Nwosu', '+2348030000005', '+2348030000005', 'brightpage.stationery@example.com', 'Textbooks, calculators, and same-day printing for assignments.', 'academic', 'Opposite Faculty of Law, UNIOSUN', 'uniosun', 4.9, true, true, 'https://images.unsplash.com/photo-1553729459-efe14ef6055d?q=80&w=400&auto=format&fit=crop', '2026-06-20'),
  ('v-hostelbasics', 'Hostel Basics', 'Grace Effiong', '+2348030000006', '+2348030000006', 'hostelbasics@example.com', 'Bedsheets, extension boxes, and laundry pickup for hostel students.', 'hostel', 'Female Hostel Complex, UNIOSUN', 'uniosun', 4.4, true, true, 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?q=80&w=400&auto=format&fit=crop', '2026-07-25'),
  ('v-swiftrepairs', 'Swift Repairs', 'Damilola Okafor', '+2348030000007', '+2348030000007', 'swiftrepairs@example.com', 'Phone and laptop repair service, newly listed on Item cart — product listings coming soon.', 'services', 'Behind Student Union Building, UNIOSUN', 'uniosun', 0, false, true, 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?q=80&w=400&auto=format&fit=crop', '2026-09-10');

insert into products (id, name, description, price, image, category_id, vendor_id, school_id, rating, availability, created_at) values
  ('p-jollof', 'Jollof Rice + Chicken', 'Smoky party-style jollof rice with a grilled chicken portion and coleslaw.', 2500, 'https://images.unsplash.com/photo-1603496987674-79600a000f55?q=80&w=500&auto=format&fit=crop', 'food', 'v-mama-ket', 'uniosun', 4.8, 'in-stock', '2026-08-20'),
  ('p-shawarma', 'Chicken Shawarma', 'Loaded chicken shawarma wrap with spicy sauce and fries on the side.', 2000, 'https://images.unsplash.com/photo-1529006557810-274b9b2fc783?q=80&w=500&auto=format&fit=crop', 'food', 'v-mama-ket', 'uniosun', 4.6, 'in-stock', '2026-08-25'),
  ('p-hoodie', 'Oversized Hoodie', 'Heavyweight cotton oversized hoodie, unisex fit, available in 4 colors.', 12000, 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?q=80&w=500&auto=format&fit=crop', 'fashion', 'v-thriftline', 'uniosun', 4.7, 'in-stock', '2026-09-01'),
  ('p-sneakers', 'Classic Canvas Sneakers', 'Everyday canvas sneakers, true to size, great for lecture-to-hostel wear.', 15000, 'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?q=80&w=500&auto=format&fit=crop', 'fashion', 'v-thriftline', 'uniosun', 4.5, 'limited', '2026-08-15'),
  ('p-powerbank', '20000mAh Power Bank', 'Dual-output fast-charging power bank, ideal for long lecture days.', 9500, 'https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?q=80&w=500&auto=format&fit=crop', 'electronics', 'v-gadgethub', 'uniosun', 4.6, 'in-stock', '2026-08-28'),
  ('p-earbuds', 'Wireless Earbuds', 'Bluetooth 5.0 earbuds with charging case, 20-hour total battery life.', 11000, 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?q=80&w=500&auto=format&fit=crop', 'electronics', 'v-gadgethub', 'uniosun', 4.4, 'in-stock', '2026-09-03'),
  ('p-perfume', 'Signature Perfume 50ml', 'Long-lasting unisex fragrance, campus favorite scent.', 7500, 'https://images.unsplash.com/photo-1541643600914-78b084683601?q=80&w=500&auto=format&fit=crop', 'beauty', 'v-glowbar', 'uniosun', 4.5, 'in-stock', '2026-08-18'),
  ('p-calculator', 'Scientific Calculator', 'Exam-approved scientific calculator with dual power (solar + battery).', 6500, 'https://images.unsplash.com/photo-1611142027631-6c1516c9dd67?q=80&w=500&auto=format&fit=crop', 'academic', 'v-brightpage', 'uniosun', 4.9, 'in-stock', '2026-07-30'),
  ('p-printing', 'Assignment Printing (per page)', 'Same-day black-and-white printing and spiral binding available.', 50, 'https://images.unsplash.com/photo-1586953208448-b95a79798f07?q=80&w=500&auto=format&fit=crop', 'academic', 'v-brightpage', 'uniosun', 4.8, 'in-stock', '2026-09-05'),
  ('p-extbox', '6-Way Extension Box', 'Surge-protected extension box, a hostel-room essential.', 3500, 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?q=80&w=500&auto=format&fit=crop', 'hostel', 'v-hostelbasics', 'uniosun', 4.3, 'in-stock', '2026-08-10'),
  ('p-bedsheet', 'Bedsheet Set (Single)', 'Soft cotton-blend bedsheet with pillowcase, machine washable.', 8000, 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?q=80&w=500&auto=format&fit=crop', 'hostel', 'v-hostelbasics', 'uniosun', 4.4, 'unavailable', '2026-08-22'),
  ('p-laundry', 'Laundry Service (per bag)', 'Wash, dry, and fold service — drop off and pick up within 48 hours.', 2500, 'https://images.unsplash.com/photo-1545173168-9f1947eebb7f?q=80&w=500&auto=format&fit=crop', 'services', 'v-hostelbasics', 'uniosun', 4.6, 'in-stock', '2026-09-08');

