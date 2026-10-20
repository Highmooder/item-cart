-- =====================================================================
-- Item cart — Phase 9: online payments (Paystack)
-- Run AFTER 01–10.
-- =====================================================================
-- WHAT: lets a customer pay an order online, and lets a payment that
--       Paystack has CONFIRMED mark that order "paid" automatically.
-- WHY:  until now you checked each payment by hand.
-- HOW IT STAYS SAFE:
--   * The two new functions below can only be called by the server
--     (the two Edge Functions, using the service key). Browsers and
--     signed-in customers cannot call them, so nobody can mark their own
--     order paid or change the fee from the website.
--   * An order becomes "paid" only if the amount Paystack reports equals
--     the order total plus the stored fee, to the kobo.
--   * Nothing here changes how an order total or a vendor payout is worked
--     out. "total" is still what the order costs (items + delivery). The
--     online payment fee is stored separately and shown to the customer.
--   * Paying manually still works exactly as before; you can still mark
--     an order paid yourself in Admin.
-- FUTURE: refunds and a "what each vendor is owed" report (Phase 3).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. NEW COLUMNS ON TRANSACTIONS
-- ---------------------------------------------------------------------
--   payment_provider   'paystack' once an online payment succeeded (else empty)
--   payment_reference  the reference of the latest attempt, e.g. TXN-1004-2
--   payment_fee        the fee shown to the customer for the latest attempt
--   payment_attempts   how many times "Pay online" was started (1, 2, 3...)
--   paid_at            when an online payment was confirmed
alter table transactions
  add column if not exists payment_provider  text,
  add column if not exists payment_reference text,
  add column if not exists payment_fee       integer not null default 0 check (payment_fee >= 0),
  add column if not exists payment_attempts  integer not null default 0 check (payment_attempts >= 0),
  add column if not exists paid_at           timestamptz;


-- ---------------------------------------------------------------------
-- 2. START AN ONLINE PAYMENT (server only)
-- ---------------------------------------------------------------------
-- Called by the start-payment Edge Function after it has checked who the
-- customer is. Records the fee and makes a fresh reference for this
-- attempt (Paystack needs a new one each time): TXN-1004-1, TXN-1004-2...
-- A paid order can't be paid again.
create or replace function begin_online_payment(p_transaction_id text, p_fee integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t         transactions%rowtype;
  v_attempt integer;
  v_ref     text;
begin
  if p_fee is null or p_fee < 0 or p_fee > 2000 then
    raise exception 'Invalid payment fee.';
  end if;

  select * into t from transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'Order not found.';
  end if;

  if t.payment_status = 'paid' then
    raise exception 'ALREADY_PAID';
  end if;
  if t.payment_status = 'refunded' then
    raise exception 'This order was refunded and can''t be paid.';
  end if;
  if t.total <= 0 then
    raise exception 'There is nothing to pay on this order.';
  end if;

  v_attempt := t.payment_attempts + 1;
  v_ref     := t.id || '-' || v_attempt::text;

  update transactions
     set payment_attempts  = v_attempt,
         payment_fee       = p_fee,
         payment_reference = v_ref,
         updated_at        = now()
   where id = t.id;

  return jsonb_build_object(
    'reference', v_ref,
    'attempt',   v_attempt,
    'total',     t.total,
    'fee',       p_fee,
    'email',     t.customer_email
  );
end;
$$;


-- ---------------------------------------------------------------------
-- 3. MARK AN ORDER PAID (server only)
-- ---------------------------------------------------------------------
-- Called when Paystack confirms a successful payment (by webhook, or when
-- the customer returns and the server asks Paystack directly).
-- Safe to call twice for the same payment: the second call changes nothing.
-- Returns {"status": ...}:
--   paid            marked paid now
--   already_paid    it was already paid (nothing changed)
--   amount_mismatch the amount didn't match, so it was NOT marked paid
--   ignored         not one of our payments (unknown reference, refunded...)
create or replace function mark_transaction_paid(p_reference text, p_amount_kobo bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t         transactions%rowtype;
  v_id      text;
  v_attempt integer;
  v_expect  bigint;
begin
  if p_reference is null or p_reference !~ '^TXN-[0-9]+-[0-9]+$' then
    return jsonb_build_object('status', 'ignored', 'reason', 'unknown_reference');
  end if;

  v_id      := regexp_replace(p_reference, '-[0-9]+$', '');
  v_attempt := substring(p_reference from '-([0-9]+)$')::integer;

  -- Lock the row so a webhook and a customer's "check my payment" can't clash.
  select * into t from transactions where id = v_id for update;
  if not found then
    return jsonb_build_object('status', 'ignored', 'reason', 'unknown_transaction');
  end if;

  if v_attempt < 1 or v_attempt > t.payment_attempts then
    return jsonb_build_object('status', 'ignored', 'reason', 'unknown_attempt');
  end if;

  if t.payment_status = 'paid' then
    return jsonb_build_object('status', 'already_paid');
  end if;
  if t.payment_status = 'refunded' then
    return jsonb_build_object('status', 'ignored', 'reason', 'refunded');
  end if;

  v_expect := (t.total + t.payment_fee)::bigint * 100;
  if p_amount_kobo is distinct from v_expect then
    return jsonb_build_object('status', 'amount_mismatch', 'expectedKobo', v_expect, 'receivedKobo', p_amount_kobo);
  end if;

  update transactions
     set payment_status    = 'paid',
         payment_provider  = 'paystack',
         payment_reference = p_reference,
         paid_at           = now(),
         updated_at        = now()
   where id = t.id;

  return jsonb_build_object('status', 'paid');
end;
$$;

revoke execute on function begin_online_payment(text, integer)   from public, anon, authenticated;
revoke execute on function mark_transaction_paid(text, bigint)   from public, anon, authenticated;
grant  execute on function begin_online_payment(text, integer)   to service_role;
grant  execute on function mark_transaction_paid(text, bigint)   to service_role;


-- ---------------------------------------------------------------------
-- 4. WHAT THE CONFIRMATION PAGE CAN SEE
-- ---------------------------------------------------------------------
-- Same function as in 08_private_vendor_contacts.sql, plus three lines:
-- paymentProvider, paymentFee (only once an online payment succeeded) and
-- paidAt. Nothing else changed, and still no vendor phone numbers.
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
-- 5. CHECK IT WORKED (optional)
-- ---------------------------------------------------------------------
--  1. Table Editor → transactions: you should see the five new columns.
--  2. After the Edge Functions are deployed (see PAYSTACK_SETUP.md), make a
--     test order, choose "Pay online", and pay with Paystack's TEST details.
--     The order should flip to Paid by itself.
--  3. In your browser, try:
--        https://YOUR-PROJECT.supabase.co/rest/v1/rpc/mark_transaction_paid
--     with your anon key. It must be REFUSED (permission denied). That is
--     what stops anyone marking their own order paid.
