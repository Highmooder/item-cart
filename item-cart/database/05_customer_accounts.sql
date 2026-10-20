-- =====================================================================
-- Item cart — Phase 3: customer accounts + order history
-- Run AFTER 01, 02, 03 and 04.
-- =====================================================================
-- WHAT: customers can create an account (Supabase Auth), and every order
--       they place while signed in is linked to them. "My orders" then
--       shows their full history on any device.
-- WHY:  before this, a guest order was only findable with its phone
--       number, and there was no list of past orders at all.
-- GUEST CHECKOUT STILL WORKS: user_id is optional. A guest can also
--       attach an order to a new account afterwards (claim_guest_orders).
-- FUTURE: saved delivery addresses, re-order buttons and loyalty points
--       all hang off the same user_id.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Link transactions to an account (optional)
-- ---------------------------------------------------------------------
-- "on delete set null": if someone deletes their account, the order stays
-- in your records (you still need it for accounting) but is no longer
-- tied to them.
alter table transactions
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create index if not exists transactions_user_idx on transactions(user_id);


-- ---------------------------------------------------------------------
-- 2. PROFILES (name + phone for each account)
-- ---------------------------------------------------------------------
create table if not exists profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  full_name   text check (char_length(full_name) <= 120),
  phone       text check (char_length(phone) <= 30),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table profiles enable row level security;

-- A customer can only ever see and change their OWN profile.
create policy "own profile read"   on profiles for select to authenticated using (user_id = auth.uid());
create policy "own profile insert" on profiles for insert to authenticated with check (user_id = auth.uid());
create policy "own profile update" on profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on profiles from anon;
grant select, insert, update on profiles to authenticated;

create trigger profiles_updated_at before update on profiles
  for each row execute function set_updated_at();

-- Create the profile automatically when someone signs up. The sign-up form
-- sends the name and phone along, and this copies them across.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (user_id, full_name, phone)
  values (
    new.id,
    left(nullif(btrim(new.raw_user_meta_data->>'full_name'), ''), 120),
    left(nullif(btrim(new.raw_user_meta_data->>'phone'), ''), 30)
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Accounts that already exist (e.g. your admin login) get a blank profile.
insert into profiles (user_id)
select id from auth.users
on conflict (user_id) do nothing;


-- ---------------------------------------------------------------------
-- 3. CHECKOUT now records who placed the order
--    (same function as in 03_admin_catalog.sql; the only change is
--     that user_id = auth.uid(), which is NULL for guests)
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
-- 4. ONE shared "order as JSON" builder
-- ---------------------------------------------------------------------
-- WHAT: builds the transaction + orders + items JSON the website reads.
-- WHY:  the confirmation page and the "My orders" page now show exactly
--       the same data from one definition, so they can't drift apart.
-- It is internal: nobody can call it directly, only the functions below.
create or replace function transaction_json(t transactions)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
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
    'userLinked', t.user_id is not null,
    'isMine', (auth.uid() is not null and t.user_id = auth.uid()),
    'orders', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', o.id,
          'transactionId', o.transaction_id,
          'vendorId', o.vendor_id,
          'vendorName', (select v.store_name from vendors v where v.id = o.vendor_id),
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
$$;

revoke execute on function transaction_json(transactions) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. CONFIRMATION LOOKUP — now also works for the account owner
-- ---------------------------------------------------------------------
-- You can open an order if EITHER you are signed in as its owner, OR you
-- know the phone number used at checkout (guests).
-- JS: supabase.rpc('get_confirmation', { p_transaction_id, p_phone })  -- p_phone may be null
create or replace function get_confirmation(p_transaction_id text, p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t transactions%rowtype;
begin
  select * into t
  from transactions
  where id = p_transaction_id
    and (
      (auth.uid() is not null and user_id = auth.uid())
      or (
        p_phone is not null
        and regexp_replace(customer_phone, '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g')
      )
    );

  if not found then
    return null;
  end if;

  return transaction_json(t);
end;
$$;

revoke execute on function get_confirmation(text, text) from public;
grant  execute on function get_confirmation(text, text) to anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. MY ORDERS — the signed-in customer's full history, newest first
-- ---------------------------------------------------------------------
-- JS: supabase.rpc('get_my_orders')
create or replace function get_my_orders()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(transaction_json(t) order by t.created_at desc)
    from transactions t
    where t.user_id = auth.uid()
  ), '[]'::jsonb);
end;
$$;

revoke execute on function get_my_orders() from public, anon;
grant  execute on function get_my_orders() to authenticated;


-- ---------------------------------------------------------------------
-- 7. CLAIM A GUEST ORDER (attach it to the signed-in account)
-- ---------------------------------------------------------------------
-- WHAT: lets someone who checked out as a guest save that order to their
--       new account. It needs BOTH the transaction id and the phone number
--       used at checkout, and only works on orders nobody owns yet.
-- WHY:  stops anyone from "stealing" an order they only guessed the id of.
-- JS: supabase.rpc('claim_guest_orders', { p_transaction_id, p_phone })
create or replace function claim_guest_orders(p_transaction_id text, p_phone text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  update transactions
  set user_id = auth.uid()
  where id = p_transaction_id
    and user_id is null
    and regexp_replace(customer_phone, '\D', '', 'g') = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');

  -- true if it is now (or already was) this person's order
  return exists (
    select 1 from transactions where id = p_transaction_id and user_id = auth.uid()
  );
end;
$$;

revoke execute on function claim_guest_orders(text, text) from public, anon;
grant  execute on function claim_guest_orders(text, text) to authenticated;
