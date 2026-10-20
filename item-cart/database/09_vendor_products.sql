-- =====================================================================
-- Item cart — Phase 7: vendors post their own products (admin approves)
-- Run AFTER 01–08.
-- =====================================================================
-- WHAT: a vendor (a signed-in account linked to a store under Admin →
--       Vendors → Logins) can submit new products and edit their own.
--       NOTHING goes live until an admin approves it — new products and
--       EVERY edit to a live product.
-- HOW IT WORKS:
--   * A new product is saved with status "pending". The shop only shows
--     status "approved", so it stays hidden until you approve it.
--   * An edit to a LIVE product is saved as a separate "revision". The shop
--     keeps showing the current version until you approve the revision.
--   * Vendors can't write to the products table directly. They can only use
--     the functions below, which check who they are and validate everything.
--   * One safety exception: a vendor can PAUSE a live product at once
--     (mark it Unavailable), so they never get orders they can't fill.
--     Switching it back on is an edit, so it needs approval.
-- FUTURE: email alerts to you for new submissions, and to vendors for
--         decisions (same pattern as the chat alerts).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. PRODUCT STATUS
-- ---------------------------------------------------------------------
-- Existing products become "approved" automatically, so nothing disappears.
alter table products
  add column if not exists status text not null default 'approved'
    check (status in ('pending', 'approved', 'rejected')),
  add column if not exists review_note text,
  add column if not exists reviewed_at timestamptz;

create index if not exists products_status_idx on products(status);

-- The public shop shows only APPROVED products (admins still see everything).
drop policy if exists "public read products" on products;
create policy "public read products" on products for select using (
  (
    status = 'approved'
    and active
    and exists (select 1 from vendors v where v.id = products.vendor_id and v.active)
  )
  or is_admin()
);


-- ---------------------------------------------------------------------
-- 2. EDITS TO LIVE PRODUCTS (held until approved)
-- ---------------------------------------------------------------------
create table if not exists product_revisions (
  id            bigint generated always as identity primary key,
  product_id    text not null references products(id) on delete cascade,
  proposed      jsonb not null,     -- {name, description, price, categoryId, image, availability}
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_by  uuid references auth.users(id) on delete set null,
  submitted_at  timestamptz not null default now(),
  reviewed_by   uuid references auth.users(id) on delete set null,
  reviewed_at   timestamptz,
  review_note   text
);

-- A product can have only one edit waiting at a time.
create unique index if not exists product_revisions_one_pending
  on product_revisions(product_id) where status = 'pending';

alter table product_revisions enable row level security;   -- no policies: closed to the API
revoke all on product_revisions from anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. CHECKOUT only sells approved products
--    (same function as in 05_customer_accounts.sql with one added condition)
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
    and p.status = 'approved'
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
    user_id, school_id, customer_name, customer_phone, customer_email, customer_location, customer_note,
    delivery_method, subtotal, delivery_fee, total, commission_total, vendor_payout_total
  ) values (
    auth.uid(), p_school_id, v_name, v_phone, v_email, v_location, v_note,
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

revoke execute on function create_checkout(text, jsonb, delivery_method, jsonb) from public;
grant  execute on function create_checkout(text, jsonb, delivery_method, jsonb) to anon, authenticated;


-- ---------------------------------------------------------------------
-- 4. PHOTOS: a vendor team may upload into its own store's folder only
-- ---------------------------------------------------------------------
-- Files go to catalog-images/vendor-products/<store id>/... They can add
-- files but not replace or delete them, so a live product's photo can't be
-- swapped behind your back.
create policy "vendor team uploads own product photos" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'catalog-images'
    and (storage.foldername(name))[1] = 'vendor-products'
    and public.is_vendor_member((storage.foldername(name))[2])
  );

-- Only ordinary photos, up to 3 MB each, for everyone.
update storage.buckets
set file_size_limit = 3145728,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'catalog-images';


-- ---------------------------------------------------------------------
-- 5. SHARED CHECKS for vendor input
-- ---------------------------------------------------------------------
create or replace function check_vendor_product_input(
  p_vendor_id     text,
  p_name          text,
  p_description   text,
  p_price         integer,
  p_category_id   text,
  p_image         text,
  p_current_image text   -- the product's present photo (null for a new product)
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 120 then
    raise exception 'Product name must be 2 to 120 characters.';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) not between 10 and 1000 then
    raise exception 'Description must be 10 to 1,000 characters.';
  end if;
  if p_price is null or p_price < 0 or p_price > 50000000 then
    raise exception 'Enter a price between 0 and 50,000,000 naira.';
  end if;
  if not exists (select 1 from categories where id = p_category_id) then
    raise exception 'Choose a category.';
  end if;

  -- A NEW photo must be one uploaded to THIS store's folder on Item cart,
  -- never an address on someone else's website. A photo that is simply
  -- unchanged is always fine (older products have photos added by admin).
  if p_image is not null and p_image <> '' and p_image is distinct from p_current_image then
    if p_image ~ '[\s"''<>]'
       or p_image !~ '^https://[^/]+/storage/v1/object/public/catalog-images/vendor-products/'
       or position(('/vendor-products/' || p_vendor_id || '/') in p_image) = 0 then
      raise exception 'Use a photo uploaded here on Item cart.';
    end if;
  end if;
end;
$$;

revoke execute on function check_vendor_product_input(text, text, text, integer, text, text, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. VENDOR FUNCTIONS
-- ---------------------------------------------------------------------
-- Everything a store's team can see about its own products, including
-- pending and rejected ones and any edit waiting for approval.
-- JS: supabase.rpc('vendor_list_products', { p_vendor_id })
create or replace function vendor_list_products(p_vendor_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_vendor_member(p_vendor_id) then
    raise exception 'You don''t manage this store.';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'description', p.description,
        'price', p.price,
        'image', p.image,
        'categoryId', p.category_id,
        'availability', p.availability,
        'status', p.status,
        'active', p.active,
        'reviewNote', p.review_note,
        'createdAt', p.created_at,
        'edit', (
          select jsonb_build_object(
            'id', r.id, 'status', r.status, 'proposed', r.proposed,
            'reviewNote', r.review_note, 'submittedAt', r.submitted_at
          )
          from product_revisions r
          where r.product_id = p.id
          order by r.id desc
          limit 1
        )
      )
      order by p.created_at desc
    )
    from products p
    where p.vendor_id = p_vendor_id
  ), '[]'::jsonb);
end;
$$;

-- A NEW product: saved as "pending", invisible to customers until approved.
-- JS: supabase.rpc('vendor_submit_product', { p_vendor_id, p_name, p_description, p_price, p_category_id, p_image, p_availability })
create or replace function vendor_submit_product(
  p_vendor_id    text,
  p_name         text,
  p_description  text,
  p_price        integer,
  p_category_id  text,
  p_image        text,
  p_availability product_availability
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
begin
  if not is_vendor_member(p_vendor_id) then
    raise exception 'You don''t manage this store.';
  end if;

  perform check_vendor_product_input(p_vendor_id, p_name, p_description, p_price, p_category_id, p_image, null);

  -- Spam brake: at most 20 products waiting for review at once.
  if (select count(*) from products where vendor_id = p_vendor_id and status = 'pending') >= 20 then
    raise exception 'You have 20 products waiting for approval. Please wait for those to be reviewed first.';
  end if;

  insert into products (name, description, price, image, category_id, vendor_id, school_id, availability, status)
  select btrim(p_name), btrim(p_description), p_price, nullif(p_image, ''), p_category_id, v.id, v.school_id, p_availability, 'pending'
  from vendors v
  where v.id = p_vendor_id and v.active
  returning id into v_id;

  if v_id is null then
    raise exception 'This store isn''t active right now.';
  end if;

  return jsonb_build_object('id', v_id, 'status', 'pending');
end;
$$;

-- EDIT a product.
--   * waiting or not-approved product → updated in place and sent for review again
--   * LIVE product → the change is held as a revision; the shop keeps the
--     current version until an admin approves the change
-- JS: supabase.rpc('vendor_edit_product', { p_product_id, p_name, ... })
create or replace function vendor_edit_product(
  p_product_id   text,
  p_name         text,
  p_description  text,
  p_price        integer,
  p_category_id  text,
  p_image        text,
  p_availability product_availability
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p          products%rowtype;
  v_proposed jsonb;
begin
  select * into p from products where id = p_product_id for update;
  if not found then raise exception 'Product not found.'; end if;
  if not is_vendor_member(p.vendor_id) then raise exception 'You don''t manage this store.'; end if;
  if not p.active then raise exception 'This product was removed. Contact Item cart if that is a mistake.'; end if;

  perform check_vendor_product_input(p.vendor_id, p_name, p_description, p_price, p_category_id, p_image, p.image);

  if p.status in ('pending', 'rejected') then
    update products
    set name = btrim(p_name), description = btrim(p_description), price = p_price,
        category_id = p_category_id, image = nullif(p_image, ''), availability = p_availability,
        status = 'pending', review_note = null
    where id = p.id;
    return jsonb_build_object('kind', 'resubmitted');
  end if;

  v_proposed := jsonb_build_object(
    'name', btrim(p_name),
    'description', btrim(p_description),
    'price', p_price,
    'categoryId', p_category_id,
    'image', nullif(p_image, ''),
    'availability', p_availability
  );

  if v_proposed = jsonb_build_object(
       'name', p.name, 'description', p.description, 'price', p.price,
       'categoryId', p.category_id, 'image', p.image, 'availability', p.availability
     ) then
    raise exception 'You haven''t changed anything.';
  end if;

  -- A newer edit replaces one that was still waiting.
  delete from product_revisions where product_id = p.id and status = 'pending';
  insert into product_revisions (product_id, proposed, submitted_by)
  values (p.id, v_proposed, auth.uid());

  return jsonb_build_object('kind', 'edit_pending');
end;
$$;

-- PAUSE a live product at once (mark it Unavailable). Stopping sales is
-- instant; starting them again is an edit and needs approval.
create or replace function vendor_pause_product(p_product_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p products%rowtype;
begin
  select * into p from products where id = p_product_id for update;
  if not found then raise exception 'Product not found.'; end if;
  if not is_vendor_member(p.vendor_id) then raise exception 'You don''t manage this store.'; end if;
  if p.status <> 'approved' then raise exception 'Only live products can be paused.'; end if;

  update products set availability = 'unavailable' where id = p.id;

  -- if an edit is waiting, it must not switch the product back on by surprise
  update product_revisions
  set proposed = jsonb_set(proposed, '{availability}', '"unavailable"')
  where product_id = p.id and status = 'pending';
end;
$$;

-- Withdraw an edit that is still waiting for review.
create or replace function vendor_withdraw_edit(p_product_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vendor text;
begin
  select vendor_id into v_vendor from products where id = p_product_id;
  if v_vendor is null then raise exception 'Product not found.'; end if;
  if not is_vendor_member(v_vendor) then raise exception 'You don''t manage this store.'; end if;

  delete from product_revisions where product_id = p_product_id and status = 'pending';
end;
$$;

-- Remove one of the store's own products. Deleted for good if it was never
-- ordered; otherwise hidden, so past orders stay intact.
-- Returns 'deleted' or 'hidden'.
create or replace function vendor_remove_product(p_product_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vendor text;
begin
  select vendor_id into v_vendor from products where id = p_product_id;
  if v_vendor is null then raise exception 'Product not found.'; end if;
  if not is_vendor_member(v_vendor) then raise exception 'You don''t manage this store.'; end if;

  if exists (select 1 from order_items where product_id = p_product_id) then
    update products set active = false where id = p_product_id;
    return 'hidden';
  end if;

  delete from products where id = p_product_id;
  return 'deleted';
end;
$$;

revoke execute on function vendor_list_products(text)          from public, anon;
revoke execute on function vendor_submit_product(text, text, text, integer, text, text, product_availability) from public, anon;
revoke execute on function vendor_edit_product(text, text, text, integer, text, text, product_availability)   from public, anon;
revoke execute on function vendor_pause_product(text)          from public, anon;
revoke execute on function vendor_withdraw_edit(text)          from public, anon;
revoke execute on function vendor_remove_product(text)         from public, anon;
grant  execute on function vendor_list_products(text)          to authenticated;
grant  execute on function vendor_submit_product(text, text, text, integer, text, text, product_availability) to authenticated;
grant  execute on function vendor_edit_product(text, text, text, integer, text, text, product_availability)   to authenticated;
grant  execute on function vendor_pause_product(text)          to authenticated;
grant  execute on function vendor_withdraw_edit(text)          to authenticated;
grant  execute on function vendor_remove_product(text)         to authenticated;


-- ---------------------------------------------------------------------
-- 7. ADMIN FUNCTIONS
-- ---------------------------------------------------------------------
-- Everything waiting for review, oldest first: new products and edits.
-- For an edit you get the current and the proposed version side by side.
-- JS: supabase.rpc('admin_pending_products')
create or replace function admin_pending_products()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;

  return coalesce((
    select jsonb_agg(q.item order by q.item->>'submittedAt')
    from (
      select jsonb_build_object(
        'kind', 'new',
        'productId', p.id,
        'revisionId', null::bigint,
        'vendorId', p.vendor_id,
        'vendorName', v.store_name,
        'submittedAt', p.created_at,
        'current', null::jsonb,
        'proposed', jsonb_build_object(
          'name', p.name, 'description', p.description, 'price', p.price,
          'categoryId', p.category_id, 'image', p.image, 'availability', p.availability
        )
      ) as item
      from products p
      join vendors v on v.id = p.vendor_id
      where p.status = 'pending'

      union all

      select jsonb_build_object(
        'kind', 'edit',
        'productId', p.id,
        'revisionId', r.id,
        'vendorId', p.vendor_id,
        'vendorName', v.store_name,
        'submittedAt', r.submitted_at,
        'current', jsonb_build_object(
          'name', p.name, 'description', p.description, 'price', p.price,
          'categoryId', p.category_id, 'image', p.image, 'availability', p.availability
        ),
        'proposed', r.proposed
      ) as item
      from product_revisions r
      join products p on p.id = r.product_id
      join vendors v on v.id = p.vendor_id
      where r.status = 'pending'
    ) q
  ), '[]'::jsonb);
end;
$$;

-- Approve or reject. For a NEW product pass p_revision_id = null.
-- A rejection needs a short reason, which the vendor sees.
-- JS: supabase.rpc('admin_review_product', { p_product_id, p_revision_id, p_decision: 'approve' | 'reject', p_note })
create or replace function admin_review_product(
  p_product_id  text,
  p_revision_id bigint,
  p_decision    text,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  p      products%rowtype;
  r      product_revisions%rowtype;
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  if p_decision not in ('approve', 'reject') then raise exception 'Choose approve or reject.'; end if;
  if p_decision = 'reject' and (v_note is null or char_length(v_note) < 3) then
    raise exception 'Give a short reason so the vendor knows what to fix.';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'Keep the reason under 500 characters.';
  end if;

  -- a brand-new product
  if p_revision_id is null then
    select * into p from products where id = p_product_id for update;
    if not found then raise exception 'Product not found.'; end if;
    if p.status <> 'pending' then raise exception 'This product was already reviewed.'; end if;

    update products
    set status      = case when p_decision = 'approve' then 'approved' else 'rejected' end,
        review_note = case when p_decision = 'reject' then v_note else null end,
        reviewed_at = now()
    where id = p.id;

    return jsonb_build_object('result', p_decision, 'kind', 'new');
  end if;

  -- an edit to a live product
  select * into r from product_revisions where id = p_revision_id and product_id = p_product_id for update;
  if not found then raise exception 'That edit was not found.'; end if;
  if r.status <> 'pending' then raise exception 'This edit was already reviewed.'; end if;

  if p_decision = 'approve' then
    update products
    set name         = r.proposed->>'name',
        description  = r.proposed->>'description',
        price        = (r.proposed->>'price')::integer,
        category_id  = r.proposed->>'categoryId',
        image        = r.proposed->>'image',
        availability = (r.proposed->>'availability')::product_availability,
        review_note  = null,
        reviewed_at  = now()
    where id = p_product_id;
  end if;

  update product_revisions
  set status      = case when p_decision = 'approve' then 'approved' else 'rejected' end,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = case when p_decision = 'reject' then v_note else null end
  where id = r.id;

  return jsonb_build_object('result', p_decision, 'kind', 'edit');
end;
$$;

revoke execute on function admin_pending_products()                         from public, anon;
revoke execute on function admin_review_product(text, bigint, text, text)   from public, anon;
grant  execute on function admin_pending_products()                         to authenticated;
grant  execute on function admin_review_product(text, bigint, text, text)   to authenticated;


-- ---------------------------------------------------------------------
-- 8. CHECK IT WORKED (optional)
-- ---------------------------------------------------------------------
--  select count(*) from products where status = 'approved';   -- all your existing products
--  Then: link a vendor account (Admin → Vendors → Logins), sign in as that
--  vendor, open "Manage products" from the Account page and add a product.
--  It should show as "Waiting for approval", and NOT appear in the shop until
--  you approve it in Admin → Approvals.
