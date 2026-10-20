# Vendor payouts and online refunds — setup

Two features, both in the admin page:

1. **Payouts tab:** what each vendor is owed, and a record of what you have paid them.
2. **Refund buttons** on payments made online with Paystack.

Neither moves money on its own for payouts (you pay the vendor, then record it). Refunds
DO send money back to the customer through Paystack.

## Part 1: Payouts (no keys needed)

1. Supabase → SQL Editor → run `database/12_payouts_and_refunds.sql`.
2. Upload the website files. Admin now has a **Payouts** tab.

### The rules
| | |
|---|---|
| A vendor is **owed** an order when | its payment is **Paid** AND you set that vendor order to **Completed** |
| **In progress** | paid orders not completed yet (shown, but not payable yet) |
| Never owed | cancelled orders, refunded payments, unpaid payments |
| **Owed** | earned (completed orders) minus payouts you recorded |
| Negative owed | "Owes Item cart": for example you refunded an order you had already paid the vendor for |
| Limit | you can't record a payout bigger than what is owed |

So remember to set orders to **Completed** (Admin → Orders → the vendor order → Save order)
when they are delivered. Until you do, the vendor shows "in progress", not "owed".

### Using it
- Pay the vendor yourself (bank transfer, cash...).
- Admin → Payouts → **Record payout**, enter the amount and a note (for example the transfer
  reference).
- Recorded the wrong amount? **History → Void**. The entry stays in the list, marked
  Voided, and stops counting.
- Removing a vendor never deletes their payout history.

## Part 2: Refunds through Paystack

### Set up
1. Supabase → Edge Functions → **Deploy a new function** → **Via Editor**.
2. Name it `refund-payment` and paste `supabase/functions/refund-payment/index.ts`.
3. Leave **Verify JWT** **on** (admins are signed in). No new secrets are needed. It uses the
   same `PAYSTACK_SECRET_KEY` as `start-payment`.
4. **Redeploy `paystack-webhook`** (paste in the new `supabase/functions/paystack-webhook/index.ts`).
   It now also hears Paystack's later refund updates. The webhook address in Paystack stays the same.

### Using it
Admin → Orders → open a payment that was **made online** (it says "Paid online with Paystack").
You will see:
- **Refund this order**: on a vendor order. Refunds that vendor order's items, and cancels it.
- **Refund everything remaining**: refunds whatever hasn't been refunded yet, including the
  online fee the customer paid, and cancels every remaining vendor order.

Payments made by bank transfer have no refund button here. Return that money yourself, then
use "Update payment" to mark it Refunded.

### What happens
1. The database works out the amount and locks the payment for 2 minutes, so a double tap or
   two admins can't refund twice.
2. Paystack is asked to refund. If it refuses, the site shows its reason, nothing changes, and
   you can try again.
3. If Paystack accepts, the refund is recorded and the refunded vendor order(s) are
   cancelled, so they're never prepared or paid out.
4. Later, Paystack reports the refund as pending, processing, processed or failed. You see that
   status next to each refund in the order. The customer sees "Refunded to you" on their order page.

### If something looks wrong
- **"Refund needs attention"** (red): Paystack couldn't complete that refund. Its docs say a
  failed refund is credited back to your Paystack balance, but the customer has NOT received it.
  Refund them another way (for example bank transfer).
- **"Paystack accepted the refund but the site couldn't record it. Do NOT refund again."**: the money
  has been returned. Don't press Refund again. Fix the record by hand: set the vendor order(s) to
  Cancelled and, if it was a full refund, use "Update payment" to mark it Refunded.
- **"Paystack refused the refund"** plus a reason: nothing was refunded. Common causes are a
  low Paystack balance or a payment Paystack won't refund. Check Paystack's dashboard.
- **No refund buttons at all:** the SQL in Part 1 hasn't been run, or the payment wasn't made online.

### Things I couldn't confirm (check Paystack's current terms)
- Whether Paystack returns **its own fee** when you refund. If it doesn't, a full refund costs Item cart
  that fee, because the customer is refunded what they paid.
- What Paystack does when your balance is too low for a refund.
- How refunds behave in **test mode**. Try a refund on a test payment before relying on it.
