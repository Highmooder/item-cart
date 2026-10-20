-- =====================================================================
-- Item cart — Phase 6: keep vendor contact details private
-- Run AFTER 01–07.
-- =====================================================================
-- WHAT: vendor phone numbers, WhatsApp numbers, emails and owner names can
--       no longer be read by the public website or by logged-in customers.
--       Only admins can see them (through the admin page).
-- WHY:  customers now reach vendors through on-site chat. Before this, the
--       numbers were hidden on the pages but anyone could still read them
--       straight from the public Supabase API, which defeated the point.
-- WHAT STAYS THE SAME: the shop, checkout, chat and admin page all keep
--       working. Checkout still copies the vendor's number onto the order
--       (admin-only), and the admin page still shows and edits everything.
-- UNDO: if anything looks wrong, run   grant select on vendors to anon, authenticated;
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. ONLY THE PUBLIC COLUMNS OF "vendors" CAN BE READ
-- ---------------------------------------------------------------------
-- Everything the shop shows is listed here. Phone, WhatsApp, email and
-- owner name are deliberately missing. After this, a request such as
-- /rest/v1/vendors?select=* or ?select=phone is refused by the database.
revoke select on vendors from anon, authenticated;

grant select (id, store_name, description, category_id, location, school_id, rating, verified, active, image, created_at)
  on vendors to anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. ADMIN: read the full vendor list
-- ---------------------------------------------------------------------
-- The admin page can no longer use select("*"), so it asks this function,
-- which first checks that the caller is an admin.
-- JS: supabase.rpc('admin_list_vendors')
create or replace function admin_list_vendors()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;

  return coalesce((
    select jsonb_agg(to_jsonb(v) order by v.created_at desc)
    from vendors v
  ), '[]'::jsonb);
end;
$$;

revoke execute on function admin_list_vendors() from public, anon;
grant  execute on function admin_list_vendors() to authenticated;


-- ---------------------------------------------------------------------
-- 3. ORDER CONFIRMATIONS NO LONGER CARRY THE VENDOR'S NUMBER
-- ---------------------------------------------------------------------
-- The order record still stores it (for you), but the JSON a customer gets
-- back on the confirmation / "My orders" pages no longer includes it.
-- (Same function as in 05_customer_accounts.sql, minus one line.)
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
-- 4. CHECK IT WORKED (optional)
-- ---------------------------------------------------------------------
-- Open these two addresses in a browser, replacing the two placeholders
-- with your project address and your anon key (Project Settings → API):
--
--   https://YOUR-PROJECT.supabase.co/rest/v1/vendors?select=id,phone&apikey=YOUR-ANON-KEY
--        → should be REFUSED ("permission denied")
--   https://YOUR-PROJECT.supabase.co/rest/v1/vendors?select=id,store_name&apikey=YOUR-ANON-KEY
--        → should list your vendors
