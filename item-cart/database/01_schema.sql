-- =====================================================================
-- Item cart — Phase 2: Supabase schema
-- Paste into Supabase → SQL Editor → New query → Run.
-- Run this file FIRST, then 02_seed.sql.
-- =====================================================================
-- WHAT: tables, enums, security rules (RLS) and two checkout functions.
-- WHY:  the database — not the browser — enforces the Item cart rules:
--       prices come from the database, payment is never marked "paid"
--       by a customer, and a checkout either fully succeeds or saves nothing.
-- FUTURE: vendor dashboards, payment webhooks and more schools plug in
--         without changing these tables.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. ENUMS (fixed lists of allowed values)
-- ---------------------------------------------------------------------
create type delivery_method     as enum ('delivery', 'pickup');
create type payment_status      as enum ('pending', 'awaiting_verification', 'paid', 'failed', 'refunded');
create type order_status        as enum ('pending', 'confirmed', 'processing', 'ready', 'completed', 'cancelled');
create type dispute_status      as enum ('none', 'open', 'resolved');
create type product_availability as enum ('in-stock', 'limited', 'unavailable');
create type application_status  as enum ('pending_review', 'approved', 'rejected');


-- ---------------------------------------------------------------------
-- 2. CATALOG TABLES
-- ---------------------------------------------------------------------
create table schools (
  id            text primary key,              -- e.g. 'uniosun'
  name          text not null,
  abbreviation  text not null,
  location      text not null,
  active        boolean not null default true
);

create table categories (
  id    text primary key,                      -- e.g. 'food'
  name  text not null,
  icon  text not null                          -- key used by js/modules/icons.js
);

create table vendors (
  id           text primary key,               -- e.g. 'v-mama-ket'
  store_name   text not null,
  owner_name   text not null,
  phone        text not null,
  whatsapp     text not null,                  -- per-vendor channel, never the purchase flow
  email        text not null,
  description  text not null,
  category_id  text not null references categories(id),
  location     text not null,
  school_id    text not null references schools(id),
  rating       numeric(2,1) not null default 0 check (rating between 0 and 5),
  verified     boolean not null default false,
  active       boolean not null default true,
  image        text,
  created_at   timestamptz not null default now()
);

create table products (
  id            text primary key,              -- e.g. 'p-jollof'
  name          text not null,
  description   text not null,
  price         integer not null check (price >= 0),   -- whole Naira
  image         text,
  category_id   text not null references categories(id),
  vendor_id     text not null references vendors(id),
  school_id     text not null references schools(id),
  rating        numeric(2,1) not null default 0 check (rating between 0 and 5),
  availability  product_availability not null default 'in-stock',
  created_at    timestamptz not null default now()
);

create index products_vendor_idx   on products(vendor_id);
create index products_category_idx on products(category_id);
create index products_school_idx   on products(school_id);
create index vendors_school_idx    on vendors(school_id);


-- ---------------------------------------------------------------------
-- 3. SETTINGS (replaces ITEMCART_CONFIG money values)
-- ---------------------------------------------------------------------
-- WHAT: commission rate and delivery fee live here, in ONE place.
-- WHY:  checkout reads them server-side, so a customer can't tamper
--       with them from the browser.
-- FUTURE: activating commission = update one row, no code change.
create table settings (
  key    text primary key,
  value  numeric not null
);

insert into settings (key, value) values
  ('commission_rate', 0),      -- 0 = 0% during launch
  ('delivery_fee',    500);    -- flat, charged once per transaction


-- ---------------------------------------------------------------------
-- 4. ADMINS
-- ---------------------------------------------------------------------
-- Add yourself later (Phase 6) after creating your login:
--   insert into admins (user_id) values ('<your auth user uuid>');
create table admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create or replace function is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;


-- ---------------------------------------------------------------------
-- 5. TRANSACTIONS + ORDERS (the hybrid model from Phase 4.1)
-- ---------------------------------------------------------------------
create sequence transaction_seq start 1001;
create sequence order_seq       start 1001;

-- Parent record: the ONE payment the customer makes to Item cart.
create table transactions (
  id                   text primary key default ('TXN-' || nextval('transaction_seq')),
  school_id            text not null references schools(id),

  customer_name        text not null,
  customer_phone       text not null,
  customer_email       text not null,
  customer_location    text,
  customer_note        text,

  delivery_method      delivery_method not null,
  subtotal             integer not null check (subtotal >= 0),
  delivery_fee         integer not null check (delivery_fee >= 0),   -- once, never per vendor
  total                integer not null check (total >= 0),
  commission_total     integer not null default 0,
  vendor_payout_total  integer not null default 0,

  payment_status       payment_status not null default 'pending',    -- lives ONLY here
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Child record: one vendor's slice of a transaction, for fulfillment.
create table orders (
  id                 text primary key default ('RUN-' || nextval('order_seq')),
  transaction_id     text not null references transactions(id) on delete cascade,
  school_id          text not null references schools(id),
  vendor_id          text not null references vendors(id),

  customer_name      text not null,
  customer_phone     text not null,
  customer_email     text not null,
  customer_location  text,
  customer_note      text,
  delivery_method    delivery_method not null,

  vendor_subtotal    integer not null check (vendor_subtotal >= 0),
  commission_rate    numeric not null default 0,        -- rate in effect at creation
  commission_amount  integer not null default 0,
  vendor_payout      integer not null,

  order_status       order_status not null default 'pending',   -- fulfillment only
  dispute_status     dispute_status not null default 'none',
  vendor_whatsapp    text,                                      -- communication channel only

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Line items (moved out of the order JSON so they can be queried).
create table order_items (
  id          bigint generated always as identity primary key,
  order_id    text not null references orders(id) on delete cascade,
  product_id  text not null references products(id),
  name        text not null,                 -- snapshot: stays correct if product is renamed
  price       integer not null,              -- snapshot of price at purchase time
  quantity    integer not null check (quantity > 0),
  vendor_id   text not null references vendors(id)
);

create index orders_transaction_idx on orders(transaction_id);
create index orders_vendor_idx      on orders(vendor_id);
create index order_items_order_idx  on order_items(order_id);

-- Keep updated_at honest automatically.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger transactions_updated_at before update on transactions
  for each row execute function set_updated_at();
create trigger orders_updated_at before update on orders
  for each row execute function set_updated_at();


-- ---------------------------------------------------------------------
-- 6. VENDOR APPLICATIONS
-- ---------------------------------------------------------------------
-- Never auto-approved: an application only becomes a vendor through
-- manual admin review.
create table vendor_applications (
  id            bigint generated always as identity primary key,
  store_name    text not null check (char_length(store_name)  between 1 and 120),
  owner_name    text not null check (char_length(owner_name)  between 1 and 120),
  phone         text not null check (char_length(phone)       between 7 and 30),
  whatsapp      text not null check (char_length(whatsapp)    between 7 and 30),
  email         text not null check (char_length(email)       between 5 and 200),
  school_id     text not null references schools(id),
  category_id   text not null references categories(id),
  location      text not null check (char_length(location)    between 1 and 200),
  description   text not null check (char_length(description) between 10 and 1000),
  status        application_status not null default 'pending_review',
  submitted_at  timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
-- WHAT: RLS = rules the database applies to every request.
-- WHY:  your anon key is public (it's in the browser). Without RLS,
--       anyone could read or edit everything.
alter table schools             enable row level security;
alter table categories          enable row level security;
alter table vendors             enable row level security;
alter table products            enable row level security;
alter table settings            enable row level security;
alter table admins              enable row level security;   -- no policies = nobody via API
alter table transactions        enable row level security;
alter table orders              enable row level security;
alter table order_items         enable row level security;
alter table vendor_applications enable row level security;

-- Public catalog (read-only)
create policy "public read schools"    on schools    for select using (active or is_admin());
create policy "public read categories" on categories for select using (true);
create policy "public read vendors"    on vendors    for select using (active or is_admin());
create policy "public read products"   on products   for select using (
  exists (select 1 from vendors v where v.id = products.vendor_id and v.active) or is_admin()
);
create policy "public read settings"   on settings   for select using (true);

-- Admin management of catalog + settings
create policy "admin write schools"    on schools    for all using (is_admin()) with check (is_admin());
create policy "admin write categories" on categories for all using (is_admin()) with check (is_admin());
create policy "admin write vendors"    on vendors    for all using (is_admin()) with check (is_admin());
create policy "admin write products"   on products   for all using (is_admin()) with check (is_admin());
create policy "admin write settings"   on settings   for all using (is_admin()) with check (is_admin());

-- Money records: admin only. Customers go through the functions below.
create policy "admin all transactions" on transactions for all using (is_admin()) with check (is_admin());
create policy "admin all orders"       on orders       for all using (is_admin()) with check (is_admin());
create policy "admin all order_items"  on order_items  for all using (is_admin()) with check (is_admin());

-- Vendor applications: anyone can submit, only admins can read/review.
create policy "anyone can apply" on vendor_applications
  for insert to anon, authenticated
  with check (status = 'pending_review');
create policy "admin read applications"   on vendor_applications for select using (is_admin());
create policy "admin update applications" on vendor_applications for update using (is_admin()) with check (is_admin());

-- Table-level permissions (belt and braces on top of RLS)
revoke all on transactions, orders, order_items, admins from anon;
revoke all on vendor_applications from anon, authenticated;
grant insert         on vendor_applications to anon, authenticated;
grant select, update on vendor_applications to authenticated;   -- RLS limits this to admins


-- ---------------------------------------------------------------------
-- 8. CHECKOUT FUNCTION
-- ---------------------------------------------------------------------
-- WHAT: creates ONE transaction + one order per vendor + all line items,
--       in a single all-or-nothing step.
-- WHY:  - prices/fees/commission are read from the database, never
--         trusted from the browser
--       - if anything fails, Postgres rolls everything back, so the old
--         manual rollback code is no longer needed
--       - payment_status always starts as 'pending'
-- FUTURE: add stock checks, promo codes or a payment-gateway reference here.
--
-- Call from JS:
--   supabase.rpc('create_checkout', {
--     p_school_id: 'uniosun',
--     p_customer: { name, phone, email, location, note },
--     p_delivery_method: 'delivery',
--     p_items: [{ productId: 'p-jollof', quantity: 2 }]
--   })
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
-- 9. CONFIRMATION LOOKUP (guest-safe)
-- ---------------------------------------------------------------------
-- WHAT: returns a transaction + its orders + items, but only if the
--       phone number matches the one used at checkout.
-- WHY:  guests have no login, and transaction ids (TXN-1001...) are
--       sequential and guessable. Requiring the phone number stops
--       strangers from browsing other people's orders.
-- FUTURE: replace the phone check with auth.uid() once customer accounts exist.
--
-- Call from JS:
--   supabase.rpc('get_confirmation', { p_transaction_id: 'TXN-1001', p_phone: '+234...' })
create or replace function get_confirmation(p_transaction_id text, p_phone text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  t transactions%rowtype;
begin
  select * into t
  from transactions
  where id = p_transaction_id
    and regexp_replace(customer_phone, '\D', '', 'g') = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', t.id,
    'schoolId', t.school_id,
    'customer', jsonb_build_object(
      'name', t.customer_name, 'phone', t.customer_phone, 'email', t.customer_email,
      'location', t.customer_location, 'note', t.customer_note
    ),
    'deliveryMethod', t.delivery_method,
    'subtotal', t.subtotal,
    'deliveryFee', t.delivery_fee,
    'total', t.total,
    'commissionTotal', t.commission_total,
    'vendorPayoutTotal', t.vendor_payout_total,
    'paymentStatus', t.payment_status,
    'createdAt', t.created_at,
    'orders', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', o.id,
          'transactionId', o.transaction_id,
          'vendorId', o.vendor_id,
          'vendorWhatsapp', o.vendor_whatsapp,
          'vendorSubtotal', o.vendor_subtotal,
          'commissionRate', o.commission_rate,
          'commissionAmount', o.commission_amount,
          'vendorPayout', o.vendor_payout,
          'orderStatus', o.order_status,
          'disputeStatus', o.dispute_status,
          'createdAt', o.created_at,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'productId', oi.product_id, 'name', oi.name, 'price', oi.price,
              'quantity', oi.quantity, 'vendorId', oi.vendor_id
            ) order by oi.id)
            from order_items oi where oi.order_id = o.id
          ), '[]'::jsonb)
        ) order by o.id
      )
      from orders o where o.transaction_id = t.id
    ), '[]'::jsonb)
  );
end;
$$;


-- Only these two functions are callable by the public.
revoke execute on function create_checkout(text, jsonb, delivery_method, jsonb) from public;
revoke execute on function get_confirmation(text, text) from public;
grant  execute on function create_checkout(text, jsonb, delivery_method, jsonb) to anon, authenticated;
grant  execute on function get_confirmation(text, text) to anon, authenticated;
