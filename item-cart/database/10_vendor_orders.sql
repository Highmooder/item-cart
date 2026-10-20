-- =====================================================================
-- Item cart — Phase 8: vendor orders page
-- Run AFTER 01–09.
-- =====================================================================
-- WHAT: a vendor (a signed-in account linked to a store under
--       Admin → Vendors → Logins) can
--         1. see the PAID orders for their store,
--         2. tap "Ready" when an order is packed, and
--         3. start a chat with the customer about that order.
-- WHY:  until now vendors couldn't see their orders at all, and you
--       messaged each one yourself from the admin page.
-- HOW IT STAYS SAFE:
--   * Vendors never read the orders table directly (it is admin-only).
--     They use the three functions below, which first check that the
--     caller really manages that store.
--   * Only orders whose payment you have confirmed (status "paid") are
--     shown. An unpaid order is invisible to the vendor.
--   * The customer's phone number and email are NOT sent to the vendor.
--     They get the name, what was ordered, and where to bring it. To
--     coordinate, they use the on-site chat (phone numbers stay hidden).
--   * "Ready" is the only status change a vendor can make. Confirming
--     payment, completing and cancelling stay with you (admin).
-- FUTURE: email/push alerts for new paid orders, and a "Completed" step
--         once delivery tracking exists.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LIST A STORE'S PAID ORDERS
-- ---------------------------------------------------------------------
-- The newest 200, each with its items. "canMessage" is true when the
-- customer ordered while signed in (guests have no account to chat with).
-- "conversationId" is the existing chat with that customer, if any.
-- JS: supabase.rpc('vendor_list_orders', { p_vendor_id })
create or replace function vendor_list_orders(p_vendor_id text)
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
        'id', r.id,
        'transactionId', r.transaction_id,
        'createdAt', r.created_at,
        'customerName', r.customer_name,
        'deliveryMethod', r.delivery_method,
        'location', r.customer_location,
        'note', r.customer_note,
        'subtotal', r.vendor_subtotal,
        'payout', r.vendor_payout,
        'orderStatus', r.order_status,
        'disputeStatus', r.dispute_status,
        'canMessage', r.user_id is not null,
        'conversationId', (
          select c.id
          from conversations c
          where c.vendor_id = r.vendor_id and c.customer_id = r.user_id
        ),
        'items', coalesce((
          select jsonb_agg(
            jsonb_build_object('name', oi.name, 'price', oi.price, 'quantity', oi.quantity)
            order by oi.id
          )
          from order_items oi
          where oi.order_id = r.id
        ), '[]'::jsonb)
      )
      order by r.created_at desc
    )
    from (
      select o.*, t.user_id
      from orders o
      join transactions t on t.id = o.transaction_id
      where o.vendor_id = p_vendor_id
        and t.payment_status = 'paid'
      order by o.created_at desc
      limit 200
    ) r
  ), '[]'::jsonb);
end;
$$;


-- ---------------------------------------------------------------------
-- 2. MARK AN ORDER READY
-- ---------------------------------------------------------------------
-- Allowed only for a PAID order that hasn't been readied, completed or
-- cancelled yet. Tapping twice is harmless (it just says "ready").
-- JS: supabase.rpc('vendor_mark_order_ready', { p_order_id })
create or replace function vendor_mark_order_ready(p_order_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o       orders%rowtype;
  v_paid  payment_status;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;

  -- Lock the row so two quick taps (or you and the vendor) can't clash.
  select * into o from orders where id = p_order_id for update;

  -- Same message whether the order doesn't exist or belongs to another
  -- store, so nobody can probe for other stores' order numbers.
  if not found or not is_vendor_member(o.vendor_id) then
    raise exception 'Order not found.';
  end if;

  select payment_status into v_paid from transactions where id = o.transaction_id;
  if v_paid is distinct from 'paid' then
    raise exception 'This order isn''t paid yet, so it can''t be marked Ready.';
  end if;

  if o.order_status = 'ready' then
    return jsonb_build_object('orderStatus', 'ready');
  end if;

  if o.order_status not in ('pending', 'confirmed', 'processing') then
    raise exception 'This order is already %, so it can''t be marked Ready.', o.order_status;
  end if;

  update orders set order_status = 'ready' where id = o.id;

  return jsonb_build_object('orderStatus', 'ready');
end;
$$;


-- ---------------------------------------------------------------------
-- 3. MESSAGE THE CUSTOMER ABOUT AN ORDER
-- ---------------------------------------------------------------------
-- WHAT: the vendor's FIRST message to a customer (creates the chat). After
--       that, both sides reply with the normal send_message.
-- WHY:  start_conversation only works for customers writing to a store.
--       This is the other direction, and it is tied to a real paid order,
--       so a vendor can only write to people who bought from them.
-- The message goes through the same phone-number filter as every chat.
-- JS: supabase.rpc('vendor_start_order_conversation', { p_order_id, p_body })
create or replace function vendor_start_order_conversation(p_order_id text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o              orders%rowtype;
  t              transactions%rowtype;
  v_conversation uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to send messages.'; end if;

  select * into o from orders where id = p_order_id;
  if not found or not is_vendor_member(o.vendor_id) then
    raise exception 'Order not found.';
  end if;

  select * into t from transactions where id = o.transaction_id;
  if t.payment_status is distinct from 'paid' then
    raise exception 'This order isn''t paid yet.';
  end if;
  if t.user_id is null then
    raise exception 'This customer ordered as a guest, so they can''t receive chat messages.';
  end if;
  if t.user_id = auth.uid() then
    raise exception 'You can''t message yourself.';
  end if;

  insert into conversations (customer_id, vendor_id)
  values (t.user_id, o.vendor_id)
  on conflict (customer_id, vendor_id) do nothing;

  select id into v_conversation
  from conversations
  where customer_id = t.user_id and vendor_id = o.vendor_id;

  -- If the message is empty or too long this raises, and the whole
  -- function rolls back, so no empty conversation is left behind.
  return send_message(v_conversation, p_body) || jsonb_build_object('conversationId', v_conversation);
end;
$$;


revoke execute on function vendor_list_orders(text)                    from public, anon;
revoke execute on function vendor_mark_order_ready(text)               from public, anon;
revoke execute on function vendor_start_order_conversation(text, text) from public, anon;
grant  execute on function vendor_list_orders(text)                    to authenticated;
grant  execute on function vendor_mark_order_ready(text)               to authenticated;
grant  execute on function vendor_start_order_conversation(text, text) to authenticated;


-- ---------------------------------------------------------------------
-- 4. CHECK IT WORKED (optional)
-- ---------------------------------------------------------------------
--  1. In Admin → Orders, mark a test transaction as Paid.
--  2. Sign in as a vendor linked to that store, open Account → Orders.
--     The order should appear under "To prepare".
--  3. Tap Ready. In Admin → Orders the order now shows "Ready".
--  4. An order whose payment is still Pending must NOT appear for the vendor.
