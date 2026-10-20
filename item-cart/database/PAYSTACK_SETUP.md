# Online payments with Paystack — setup

With this on, checkout offers two ways to pay:

- **Bank transfer to Item cart** (as before, no fee, you confirm it).
- **Pay online now** (bank transfer, USSD or card on Paystack's page). The student
  pays a small fee, shown before they choose. The order marks itself **Paid**,
  and the vendor sees it on their Orders page straight away.

Until you finish these steps, nothing changes on the site: online payment stays
hidden because `onlinePayments.enabled` in `js/data/config.js` is `false`.

## How it works

1. The customer places the order as usual. Your database works out the prices.
2. They tap "Pay online". The `start-payment` function works out the fee **from
   your database** (the browser can't change it), asks Paystack for a checkout page
   and sends the customer there.
3. Paystack tells Item cart the payment succeeded in two ways: the `paystack-webhook`
   function (automatic) and, when the customer comes back, `start-payment` asks
   Paystack directly. Either one marks the order paid, and only if the amount
   matches the order total plus the fee, to the kobo.
4. The secret key lives only in Supabase secrets. It is never in the website files.

## The fee students pay

Paystack charges 1.5% + ₦100 on local payments, with the ₦100 waived when the charge
is under ₦2,500, and a ₦2,000 cap. Students pay it, so the charge is slightly more
than the order total and Item cart still receives the full total.

| Order total | Student pays | Fee |
|---|---|---|
| ₦2,000 | ₦2,031 | ₦31 |
| ₦2,400 | ₦2,437 | ₦37 |
| ₦2,500 | ₦2,640 | ₦140 |
| ₦5,000 | ₦5,178 | ₦178 |

The fee jumps at ₦2,500 (the flat ₦100 starts). Bank transfer to Item cart stays free.
If Paystack changes its rates, update the numbers at the top of BOTH
`js/modules/payments.js` and `supabase/functions/start-payment/index.ts`. They must
match exactly.

## Steps

### 1. Create a Paystack account (start verification today)
1. Sign up at paystack.com/ng. A new account starts in **test mode**, so you can
   build and test straight away with no real money.
2. Start the live verification now, because it can take days. Without a registered
   company, choose **Starter Business**. You'll need a valid ID (BVN, driver's
   licence, NIN slip, voter's card or passport) and proof of address.
3. Starter Business limits (check Paystack's current terms): a lifetime collection
   cap of ₦2,000,000 until you register the business, and no Paystack Transfers, so
   you pay vendors yourself for now.

### 2. Copy your TEST secret key
Paystack dashboard → Settings → API Keys & Webhooks. Copy the **Test Secret Key**
(starts `sk_test_`). Keep it private. Don't paste it into any website file.

### 3. Run the database file
Supabase → SQL Editor → paste `database/11_online_payments.sql` → Run.

### 4. Deploy the two functions
Supabase → Edge Functions → **Deploy a new function** → **Via Editor**:

| Function name | Paste in | Verify JWT |
|---|---|---|
| `start-payment` | `supabase/functions/start-payment/index.ts` | **On** (if the site gets a 401 error from it, turn it off. The function checks the customer itself.) |
| `paystack-webhook` | `supabase/functions/paystack-webhook/index.ts` | **Off** (Paystack doesn't send a Supabase login. A signature protects it instead.) |

### 5. Add the secrets
Edge Functions → **Secrets**:

| Name | Value |
|---|---|
| `PAYSTACK_SECRET_KEY` | the Test Secret Key from step 2 |
| `SITE_URL` | your website address, e.g. `https://item-cart.netlify.app` (no slash at the end) |
| `ALLOWED_ORIGINS` | optional: the same address, so only your site can call the function |

### 6. Tell Paystack where to send confirmations
Paystack → Settings → API Keys & Webhooks. Paystack has separate **Test** and **Live**
webhook boxes. In the Test one, enter:

`https://YOUR-PROJECT.supabase.co/functions/v1/paystack-webhook`

### 7. Turn it on
In `js/data/config.js` change `enabled: false` to `enabled: true` under
`onlinePayments`, then upload the site.

### 8. Test it (no real money)
1. Add something to the cart, check out, choose **Pay online now**.
2. On Paystack's page use the test details it shows in test mode.
3. You return to Item cart and the order shows **Payment: Paid**.
4. Check Admin → Orders (Paid) and, signed in as that store's vendor, the vendor
   Orders page (the order appears).
5. Also test: close the Paystack tab without paying, then use "Pay online" again from
   the order page.

### 9. Going live (after Paystack activates you)
1. Replace `PAYSTACK_SECRET_KEY` with the **Live Secret Key** (`sk_live_`).
2. Put the same webhook address in Paystack's **Live** webhook box.
3. Make one small real payment yourself and confirm it flips to Paid.

## Good to know

- **If a customer closes the tab before coming back,** the webhook still marks the
  order paid, as long as step 6 is done. Without the webhook, the order stays Pending
  until they return to the order page or you mark it paid in Admin.
- **If a customer pays twice,** the second payment isn't refunded automatically.
  Refund it from Admin → Orders (see `PAYOUTS_AND_REFUNDS_SETUP.md`) or from Paystack's dashboard.
- **If the amount doesn't match,** the order is NOT marked paid and the customer is
  told it's being checked. Look at the transaction in Paystack and mark it paid in
  Admin if it's right.
- **"Online payment isn't available right now"** on the site means a secret is missing
  or a function isn't deployed. The order is still saved and manual payment still works.
- **Stuck on Pending after paying:** check the webhook address in Paystack, and
  Edge Functions → `paystack-webhook` → Logs. The logs never contain customer details.
- **Admin:** nothing changed. You can still mark any order Paid by hand.
