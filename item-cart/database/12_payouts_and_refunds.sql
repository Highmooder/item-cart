-- =====================================================================
-- Item cart — Phase 10: vendor payouts and online refunds
-- Run AFTER 01–11.
-- =====================================================================
-- WHAT: (1) a "what each vendor is owed" report with a record of what you
--       have paid them, and (2) the bookkeeping behind refunding an online
--       (Paystack) payment from the admin page.
-- WHY:  customers pay Item cart once; you then pay each vendor. This keeps
--       that in one place instead of a notebook.
-- THE RULES (change them here if you want different ones):
--   * A vendor is OWED money for an order only when the customer's payment
--     is Paid AND you have set that vendor order to "Completed".
--     Orders still in progress are shown separately as "in progress".
--   * Cancelled orders and refunded payments are never owed.
--   * You can't record a payout bigger than what is owed.
--   * Recording a payout does NOT move money. You pay the vendor (bank
--     transfer, cash...) and then record it here.
--   * Everything here is admin-only. Vendors and customers can't read or
--     change any of it, and the refund functions can only be called by the
--     server (the refund-payment Edge Function), never from a browser.
-- FUTURE: let each vendor see their own balance; vendor bank details and
--         automatic transfers once your Paystack account allows them.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. NEW COLUMNS AND TABLES
-- ---------------------------------------------------------------------
alter table transactions
  add column if not exists refunded_amount   integer not null default 0 check (refunded_amount >= 0),
  add column if not exists refunded_at       timestamptz,
  add column if not exists refund_lock_until timestamptz;

-- One row per refund sent to Paystack. provider_status follows Paystack:
-- pending, processing, processed, failed, needs-attention.
create table if not exists payment_refunds (
  id                 bigint generated always as identity primary key,
  transaction_id     text    not null references transactions(id),
  order_id           text    references orders(id) on delete set null,
  amount             integer not null check (amount > 0),
  provider_refund_id text,
  provider_status    text    not null default 'pending',
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists payment_refunds_transaction_idx on payment_refunds (transaction_id);

-- One row per payout you made to a vendor. A mistake can be "voided" (kept,
-- but no longer counted). No foreign key to vendors on purpose: removing a
-- vendor never erases the record of what you paid them.
create table if not exists vendor_payouts (
  id          bigint generated always as identity primary key,
  vendor_id   text    not null,
  vendor_name text,
  amount      integer not null check (amount > 0),
  note        text    check (note is null or char_length(note) <= 300),
  paid_at     timestamptz not null default now(),
  created_by  uuid,
  voided_at   timestamptz,
  voided_by   uuid
);
create index if not exists vendor_payouts_vendor_idx on vendor_payouts (vendor_id, paid_at desc);

-- Admin can READ both tables. Nobody can write to them directly; all writes
-- go through the functions below.
alter table payment_refunds enable row level security;
alter table vendor_payouts  enable row level security;

drop policy if exists "admin read refunds" on payment_refunds;
create policy "admin read refunds" on payment_refunds for select using (is_admin());

drop policy if exists "admin read payouts" on vendor_payouts;
create policy "admin read payouts" on vendor_payouts for select using (is_admin());


-- ---------------------------------------------------------------------
-- 2. WHAT EACH VENDOR IS OWED  (admin only)
-- ---------------------------------------------------------------------
--   earned      completed orders in Paid payments
--   inProgress  paid orders not completed yet (not payable yet)
--   paidOut     payouts you recorded (not voided)
--   owed        earned - paidOut   (negative = the vendor owes Item cart, e.g.
--               you refunded an order you had already paid them for)
-- JS: supabase.rpc('admin_vendor_balances')
create or replace function admin_vendor_balances()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Admins only.';
  end if;

  return coalesce((
    select jsonb_agg(rec order by (rec->>'owed')::bigint desc, rec->>'storeName')
    from (
      select jsonb_build_object(
        'vendorId',        v.id,
        'storeName',       v.store_name,
        'earned',          coalesce(e.earned, 0),
        'inProgress',      coalesce(e.in_progress, 0),
        'completedOrders', coalesce(e.completed_orders, 0),
        'paidOut',         coalesce(p.paid, 0),
        'owed',            coalesce(e.earned, 0) - coalesce(p.paid, 0),
        'lastPayoutAt',    p.last_at
      ) as rec
      from vendors v
      left join (
        select o.vendor_id,
               sum(o.vendor_payout) filter (where o.order_status = 'completed')                                         as earned,
               sum(o.vendor_payout) filter (where o.order_status in ('pending', 'confirmed', 'processing', 'ready'))    as in_progress,
               count(*)             filter (where o.order_status = 'completed')                                         as completed_orders
        from orders o
        join transactions t on t.id = o.transaction_id
        where t.payment_status = 'paid'
        group by o.vendor_id
      ) e on e.vendor_id = v.id
      left join (
        select vendor_id, sum(amount) as paid, max(paid_at) as last_at
        from vendor_payouts
        where voided_at is null
        group by vendor_id
      ) p on p.vendor_id = v.id
    ) x
  ), '[]'::jsonb);
end;
$$;


-- ---------------------------------------------------------------------
-- 3. RECORD A PAYOUT YOU MADE  (admin only)
-- ---------------------------------------------------------------------
-- Refuses more than is owed. The lock stops a double-tap recording it twice.
-- JS: supabase.rpc('admin_record_payout', { p_vendor_id, p_amount, p_note })
create or replace function admin_record_payout(p_vendor_id text, p_amount integer, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name   text;
  v_earned bigint;
  v_paid   bigint;
  v_owed   bigint;
  v_id     bigint;
begin
  if not is_admin() then
    raise exception 'Admins only.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount above ₦0.';
  end if;

  select store_name into v_name from vendors where id = p_vendor_id;
  if not found then
    raise exception 'Vendor not found.';
  end if;

  perform pg_advisory_xact_lock(hashtext('vendor-payout:' || p_vendor_id));

  select coalesce(sum(o.vendor_payout), 0) into v_earned
  from orders o
  join transactions t on t.id = o.transaction_id
  where o.vendor_id = p_vendor_id
    and o.order_status = 'completed'
    and t.payment_status = 'paid';

  select coalesce(sum(amount), 0) into v_paid
  from vendor_payouts
  where vendor_id = p_vendor_id and voided_at is null;

  v_owed := v_earned - v_paid;
  if p_amount > v_owed then
    raise exception 'That is more than the ₦% owed to this vendor.', greatest(v_owed, 0);
  end if;

  insert into vendor_payouts (vendor_id, vendor_name, amount, note, created_by)
  values (p_vendor_id, v_name, p_amount, nullif(left(trim(coalesce(p_note, '')), 300), ''), auth.uid())
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'owed', v_owed - p_amount);
end;
$$;


-- ---------------------------------------------------------------------
-- 4. VOID A PAYOUT YOU RECORDED BY MISTAKE  (admin only)
-- ---------------------------------------------------------------------
-- The row stays (so there is a trail) but stops counting.
-- JS: supabase.rpc('admin_void_payout', { p_payout_id })
create or replace function admin_void_payout(p_payout_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Admins only.';
  end if;

  update vendor_payouts
     set voided_at = now(), voided_by = auth.uid()
   where id = p_payout_id and voided_at is null;

  if not found then
    raise exception 'That payout was not found or is already voided.';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function admin_vendor_balances()                       from public, anon;
revoke execute on function admin_record_payout(text, integer, text)      from public, anon;
revoke execute on function admin_void_payout(bigint)                     from public, anon;
grant  execute on function admin_vendor_balances()                       to authenticated;
grant  execute on function admin_record_payout(text, integer, text)      to authenticated;
grant  execute on function admin_void_payout(bigint)                     to authenticated;


-- ---------------------------------------------------------------------
-- 5. REFUNDS  (server only: called by the refund-payment Edge Function)
-- ---------------------------------------------------------------------
-- A refund has three steps so money and records can't drift apart:
--   prepare_refund  checks it is allowed, works out the amount, and locks
--                   the payment for 2 minutes (so two admins can't both
--                   refund at once). Changes nothing else.
--   (the Edge Function then asks Paystack to refund)
--   finish_refund   Paystack accepted: record it, cancel the vendor order(s).
--   abort_refund    Paystack refused: release the lock.
-- What is refunded:
--   * one vendor order  -> that order's items (vendor subtotal)
--   * everything        -> whatever hasn't been refunded yet, INCLUDING the
--                          online fee the customer paid
-- Paying by hand (bank transfer) is never refunded here; do that yourself.

create or replace function prepare_refund(p_transaction_id text, p_order_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t           transactions%rowtype;
  o           orders%rowtype;
  v_remaining integer;
  v_amount    integer;
begin
  select * into t from transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'Order not found.';
  end if;

  if t.payment_provider is distinct from 'paystack' or t.payment_reference is null then
    raise exception 'NOT_ONLINE';
  end if;
  if t.payment_status <> 'paid' then
    raise exception 'Only a paid order can be refunded.';
  end if;
  if t.refund_lock_until is not null and t.refund_lock_until > now() then
    raise exception 'A refund on this order is already being processed. Wait a minute, then refresh.';
  end if;

  v_remaining := t.total + t.payment_fee - t.refunded_amount;
  if v_remaining <= 0 then
    raise exception 'Nothing is left to refund on this order.';
  end if;

  if p_order_id is null then
    v_amount := v_remaining;
  else
    select * into o from orders where id = p_order_id and transaction_id = t.id for update;
    if not found then
      raise exception 'That vendor order is not part of this payment.';
    end if;
    if o.order_status = 'cancelled' then
      raise exception 'That vendor order is already cancelled.';
    end if;
    v_amount := least(o.vendor_subtotal, v_remaining);
  end if;

  if v_amount <= 0 then
    raise exception 'There is nothing to refund for that order.';
  end if;

  update transactions set refund_lock_until = now() + interval '2 minutes' where id = t.id;

  return jsonb_build_object(
    'reference', t.payment_reference,
    'amount',    v_amount,
    'remaining', v_remaining
  );
end;
$$;

create or replace function finish_refund(
  p_transaction_id     text,
  p_order_id           text,
  p_amount             integer,
  p_provider_refund_id text,
  p_provider_status    text,
  p_admin              uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t transactions%rowtype;
begin
  select * into t from transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'Order not found.';
  end if;

  insert into payment_refunds (transaction_id, order_id, amount, provider_refund_id, provider_status, created_by)
  values (t.id, p_order_id, p_amount, nullif(p_provider_refund_id, ''), coalesce(nullif(p_provider_status, ''), 'pending'), p_admin);

  update transactions
     set refunded_amount   = t.refunded_amount + p_amount,
         refunded_at       = now(),
         refund_lock_until = null,
         payment_status    = case when t.refunded_amount + p_amount >= t.total + t.payment_fee
                                  then 'refunded'::payment_status else t.payment_status end,
         updated_at        = now()
   where id = t.id;

  -- The refunded vendor order(s) are cancelled so they are never prepared or paid out.
  if p_order_id is null then
    update orders set order_status = 'cancelled' where transaction_id = t.id and order_status <> 'cancelled';
  else
    update orders set order_status = 'cancelled' where id = p_order_id and transaction_id = t.id and order_status <> 'cancelled';
  end if;

  return jsonb_build_object(
    'refundedAmount', t.refunded_amount + p_amount,
    'paymentStatus',  case when t.refunded_amount + p_amount >= t.total + t.payment_fee then 'refunded' else t.payment_status::text end
  );
end;
$$;

create or replace function abort_refund(p_transaction_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update transactions set refund_lock_until = null where id = p_transaction_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- Paystack reports a refund's progress later (processed / failed). Matches the
-- newest unfinished refund for that payment and amount. Safe to repeat.
create or replace function record_refund_status(p_transaction_reference text, p_amount_kobo bigint, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn text;
  v_id  bigint;
begin
  if p_status is null or p_status not in ('pending', 'processing', 'processed', 'failed', 'needs-attention') then
    return jsonb_build_object('status', 'ignored', 'reason', 'unknown_status');
  end if;
  if p_transaction_reference is null or p_transaction_reference !~ '^TXN-[0-9]+-[0-9]+$' then
    return jsonb_build_object('status', 'ignored', 'reason', 'unknown_reference');
  end if;

  v_txn := regexp_replace(p_transaction_reference, '-[0-9]+$', '');

  select id into v_id
  from payment_refunds
  where transaction_id = v_txn
    and amount::bigint * 100 = p_amount_kobo
    and provider_status not in ('processed', 'failed')
  order by created_at desc
  limit 1;

  if v_id is null then
    return jsonb_build_object('status', 'ignored', 'reason', 'no_matching_refund');
  end if;

  update payment_refunds set provider_status = p_status, updated_at = now() where id = v_id;
  return jsonb_build_object('status', 'updated', 'refundStatus', p_status);
end;
$$;

revoke execute on function prepare_refund(text, text)                                      from public, anon, authenticated;
revoke execute on function finish_refund(text, text, integer, text, text, uuid)            from public, anon, authenticated;
revoke execute on function abort_refund(text)                                              from public, anon, authenticated;
revoke execute on function record_refund_status(text, bigint, text)                        from public, anon, authenticated;
grant  execute on function prepare_refund(text, text)                                      to service_role;
grant  execute on function finish_refund(text, text, integer, text, text, uuid)            to service_role;
grant  execute on function abort_refund(text)                                              to service_role;
grant  execute on function record_refund_status(text, bigint, text)                        to service_role;


-- ---------------------------------------------------------------------
-- 6. WHAT THE CONFIRMATION PAGE CAN SEE
-- ---------------------------------------------------------------------
-- Same function as in 11_online_payments.sql plus one line: refundedAmount.
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
    'paymentProvider', t.payment_provider,
    'paymentFee', case when t.payment_provider = 'paystack' then t.payment_fee else 0 end,
    'refundedAmount', t.refunded_amount,
    'paidAt', t.paid_at,
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
-- 7. CHECK IT WORKED (optional)
-- ---------------------------------------------------------------------
--  1. Admin → Payouts: vendors with completed, paid orders show an "Owed" amount.
--  2. Set a vendor order to Completed in Admin → Orders (on a Paid payment):
--     the Owed amount goes up by that order's vendor payout.
--  3. Record a payout for less than the owed amount; Owed goes down.
--     Try recording MORE than is owed; it must be refused.
--  4. In your browser, open
--        https://YOUR-PROJECT.supabase.co/rest/v1/rpc/prepare_refund
--     with your anon key. It must be REFUSED (permission denied).
