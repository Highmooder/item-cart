-- =====================================================================
-- Item cart — Phase 1 patch: vendor name on the confirmation page
-- Run AFTER 01, 02 and 03.
-- =====================================================================
-- WHAT: get_confirmation now also returns each order's vendor name.
-- WHY:  if a vendor is later hidden/removed, the shop stops listing
--       them, but a customer's old order should still say who it was from.
-- (Same function as 01_schema.sql with one added line.)
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
end;
$$;

revoke execute on function get_confirmation(text, text) from public;
grant  execute on function get_confirmation(text, text) to anon, authenticated;
