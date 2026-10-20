-- =====================================================================
-- Item cart — Phase 2b: admin catalog management
-- Run AFTER 01_schema.sql and 02_seed.sql.
-- =====================================================================
-- WHAT: lets an admin add/remove vendors and products, approve vendor
--       applications, and upload product/vendor images.
-- WHY:  "remove" is smart, not blind. A vendor or product that already
--       appears in past orders can't be deleted without breaking order
--       history and accounting, so it is DEACTIVATED (hidden from the
--       shop). One with no order history is deleted for real.
-- FUTURE: a vendor dashboard can reuse the same pattern for vendors
--         managing their own products.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Products get an "active" flag (soft remove)
-- ---------------------------------------------------------------------
alter table products add column if not exists active boolean not null default true;


-- ---------------------------------------------------------------------
-- 2. Auto-generated ids, so adding a vendor/product needs no manual id
-- ---------------------------------------------------------------------
alter table vendors  alter column id set default ('v-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
alter table products alter column id set default ('p-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));


-- ---------------------------------------------------------------------
-- 3. Public only sees active products from active vendors
-- ---------------------------------------------------------------------
drop policy if exists "public read products" on products;
create policy "public read products" on products for select using (
  (active and exists (select 1 from vendors v where v.id = products.vendor_id and v.active))
  or is_admin()
);


-- ---------------------------------------------------------------------
-- 4. Checkout now also rejects removed (inactive) products
--    (same function as 01_schema.sql, one added condition)
-- ---------------------------------------------------------------------
create or replace function create_checkout(
  p_school_id        text,
  p_customer         jsonb,
  p_delivery_method  delivery_method,
  p_items            jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name       text := nullif(btrim(p_customer->>'name'), '');
  v_phone      text := nullif(btrim(p_customer->>'phone'), '');
  v_email      text := nullif(btrim(p_customer->>'email'), '');
  v_location   text := nullif(btrim(p_customer->>'location'), '');
  v_note       text := nullif(btrim(p_customer->>'note'), '');

  v_rate       numeric;
  v_fee_cfg    integer;
  v_delivery   integer;

  v_requested  integer;
  v_valid      integer;

  v_subtotal   integer;
  v_comm_total integer := 0;
  v_pay_total  integer := 0;

  v_txn_id     text;
  v_order_id   text;
  v_order_ids  text[] := '{}';
  v_vendor     record;
  v_comm       integer;
begin
  -- Customer validation (mirrors checkout.js, but enforced server-side)
  if v_name  is null or char_length(v_name)  > 120 then raise exception 'Full name is required.'; end if;
  if v_phone is null or v_phone !~ '^[0-9+()\-\s]{7,30}$' then raise exception 'A valid phone number is required.'; end if;
  if v_email is null or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'A valid email is required.'; end if;
  if p_delivery_method = 'delivery' and v_location is null then
    raise exception 'Delivery location is required.';
  end if;
  if v_location is not null and char_length(v_location) > 300 then raise exception 'Location is too long.'; end if;
  if v_note is not null and char_length(v_note) > 1000 then raise exception 'Note is too long.'; end if;

  if not exists (select 1 from schools where id = p_school_id and active) then
    raise exception 'Unknown school.';
  end if;

  -- Items validation
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your cart is empty.';
  end if;

  select count(*) into v_requested
  from jsonb_to_recordset(p_items) as i("productId" text, quantity integer);

  select count(*) into v_valid
  from jsonb_to_recordset(p_items) as i("productId" text, quantity integer)
  join products p on p.id = i."productId"
  join vendors  v on v.id = p.vendor_id
  where p.school_id = p_school_id
    and v.active
    and p.active
    and p.availability <> 'unavailable'
    and i.quantity between 1 and 99;

  if v_requested <> v_valid then
    raise exception 'One or more items are unavailable. Please review your cart.';
  end if;

  -- Money settings (server-side)
  select value into v_rate    from settings where key = 'commission_rate';
  select value into v_fee_cfg from settings where key = 'delivery_fee';
  v_rate     := coalesce(v_rate, 0);
  v_delivery := case when p_delivery_method = 'delivery' then coalesce(v_fee_cfg, 0) else 0 end;

  -- Totals (prices come from the products table, not the browser)
  select coalesce(sum(p.price * i.quantity), 0)::integer into v_subtotal
  from jsonb_to_recordset(p_items) as i("productId" text, quantity integer)
  join products p on p.id = i."productId";

  for v_vendor in
    select p.vendor_id, sum(p.price * i.quantity)::integer as vendor_subtotal
    from jsonb_to_recordset(p_items) as i("productId" text, quantity integer)
    join products p on p.id = i."productId"
    group by p.vendor_id
  loop
    v_comm      := round(v_vendor.vendor_subtotal * v_rate)::integer;
    v_comm_total := v_comm_total + v_comm;
    v_pay_total  := v_pay_total + (v_vendor.vendor_subtotal - v_comm);
  end loop;

  -- Parent transaction
  insert into transactions (
    school_id, customer_name, customer_phone, customer_email, customer_location, customer_note,
    delivery_method, subtotal, delivery_fee, total, commission_total, vendor_payout_total
  ) values (
    p_school_id, v_name, v_phone, v_email, v_location, v_note,
    p_delivery_method, v_subtotal, v_delivery, v_subtotal + v_delivery, v_comm_total, v_pay_total
  )
  returning id into v_txn_id;

  -- Child vendor orders + items
  for v_vendor in
    select p.vendor_id, vd.whatsapp, sum(p.price * i.quantity)::integer as vendor_subtotal
    from jsonb_to_recordset(p_items) as i("productId" text, quantity integer)
    join products p  on p.id  = i."productId"
    join vendors  vd on vd.id = p.vendor_id
    group by p.vendor_id, vd.whatsapp
    order by p.vendor_id
  loop
    v_comm := round(v_vendor.vendor_subtotal * v_rate)::integer;

    insert into orders (
      transaction_id, school_id, vendor_id,
      customer_name, customer_phone, customer_email, customer_location, customer_note,
      delivery_method, vendor_subtotal, commission_rate, commission_amount, vendor_payout,
      vendor_whatsapp
    ) values (
      v_txn_id, p_school_id, v_vendor.vendor_id,
      v_name, v_phone, v_email, v_location, v_note,
      p_delivery_method, v_vendor.vendor_subtotal, v_rate, v_comm, v_vendor.vendor_subtotal - v_comm,
      v_vendor.whatsapp
    )
    returning id into v_order_id;

    insert into order_items (order_id, product_id, name, price, quantity, vendor_id)
    select v_order_id, p.id, p.name, p.price, i.quantity, p.vendor_id
    from jsonb_to_recordset(p_items) as i("productId" text, quantity integer)
    join products p on p.id = i."productId"
    where p.vendor_id = v_vendor.vendor_id;

    v_order_ids := v_order_ids || v_order_id;
  end loop;

  return jsonb_build_object(
    'transactionId', v_txn_id,
    'orderIds',      to_jsonb(v_order_ids),
    'total',         v_subtotal + v_delivery
  );
end;
$$;


-- ---------------------------------------------------------------------
-- 5. REMOVE VENDOR
-- ---------------------------------------------------------------------
-- JS:  supabase.rpc('remove_vendor', { p_vendor_id: 'v-mama-ket' })
-- Returns 'deleted' or 'deactivated'.
create or replace function remove_vendor(p_vendor_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  if not exists (select 1 from vendors where id = p_vendor_id) then
    raise exception 'Vendor not found.';
  end if;

  if exists (select 1 from orders where vendor_id = p_vendor_id) then
    update vendors set active = false where id = p_vendor_id;   -- hides vendor + their products
    return 'deactivated';
  end if;

  delete from products where vendor_id = p_vendor_id;
  delete from vendors  where id = p_vendor_id;
  return 'deleted';
end;
$$;


-- ---------------------------------------------------------------------
-- 6. REMOVE PRODUCT
-- ---------------------------------------------------------------------
-- JS:  supabase.rpc('remove_product', { p_product_id: 'p-jollof' })
-- Returns 'deleted' or 'deactivated'.
create or replace function remove_product(p_product_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  if not exists (select 1 from products where id = p_product_id) then
    raise exception 'Product not found.';
  end if;

  if exists (select 1 from order_items where product_id = p_product_id) then
    update products set active = false where id = p_product_id;
    return 'deactivated';
  end if;

  delete from products where id = p_product_id;
  return 'deleted';
end;
$$;


-- ---------------------------------------------------------------------
-- 7. APPROVE A VENDOR APPLICATION (the "add vendor" path for applicants)
-- ---------------------------------------------------------------------
-- JS:  supabase.rpc('approve_vendor_application', { p_application_id: 3 })
-- Creates the vendor from the application, unverified, then marks it approved.
create or replace function approve_vendor_application(p_application_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  a vendor_applications%rowtype;
  v_id text;
begin
  if not is_admin() then raise exception 'Admins only.'; end if;

  select * into a from vendor_applications where id = p_application_id for update;
  if not found then raise exception 'Application not found.'; end if;
  if a.status <> 'pending_review' then raise exception 'Application was already reviewed.'; end if;

  insert into vendors (store_name, owner_name, phone, whatsapp, email, description,
                       category_id, location, school_id, verified, active)
  values (a.store_name, a.owner_name, a.phone, a.whatsapp, a.email, a.description,
          a.category_id, a.location, a.school_id, false, true)
  returning id into v_id;

  update vendor_applications set status = 'approved' where id = p_application_id;
  return v_id;
end;
$$;

-- Admin-only functions: not callable by logged-out visitors.
revoke execute on function remove_vendor(text)                    from public, anon;
revoke execute on function remove_product(text)                   from public, anon;
revoke execute on function approve_vendor_application(bigint)     from public, anon;
grant  execute on function remove_vendor(text)                    to authenticated;
grant  execute on function remove_product(text)                   to authenticated;
grant  execute on function approve_vendor_application(bigint)     to authenticated;
-- (Each function also checks is_admin() itself — a normal logged-in user is still refused.)


-- ---------------------------------------------------------------------
-- 8. IMAGE STORAGE (product + vendor photos)
-- ---------------------------------------------------------------------
-- Anyone can VIEW images; only admins can upload, replace or delete.
insert into storage.buckets (id, name, public)
values ('catalog-images', 'catalog-images', true)
on conflict (id) do nothing;

create policy "public read catalog images" on storage.objects
  for select using (bucket_id = 'catalog-images');
create policy "admin upload catalog images" on storage.objects
  for insert to authenticated with check (bucket_id = 'catalog-images' and public.is_admin());
create policy "admin update catalog images" on storage.objects
  for update to authenticated using (bucket_id = 'catalog-images' and public.is_admin());
create policy "admin delete catalog images" on storage.objects
  for delete to authenticated using (bucket_id = 'catalog-images' and public.is_admin());


-- ---------------------------------------------------------------------
-- 9. MAKE YOURSELF AN ADMIN (do this once, after the steps above)
-- ---------------------------------------------------------------------
-- 1) Supabase → Authentication → Users → Add user (your email + password).
-- 2) Copy that user's UUID, then run this line with it filled in:
--
--    insert into admins (user_id) values ('PASTE-YOUR-USER-UUID-HERE');
