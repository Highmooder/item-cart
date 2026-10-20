# Item cart message alerts — setup

Two kinds of alerts are built in:

1. **In the site (works right away).** Signed-in people see an unread badge on the
   account icon and the Messages menu link. They can also turn on browser
   notifications from the Messages page. These only work while Item cart is open
   in a browser tab.
2. **By email (needs the steps below).** Vendors get an email when a customer
   writes to them, customers get one when a vendor replies, and you can get one
   when a phone number is hidden in a chat. At most one email per person per
   conversation every 10 minutes.

## Steps for email alerts

### 1. Run the SQL
Run `07_alerts.sql` in the Supabase SQL editor (after `06_chat.sql`).

### 2. Get an email sender (Resend)
1. Make a free account at resend.com and create an **API key**.
2. Until you verify your own domain in Resend, it can only deliver to the email
   you signed up with. That's fine for testing. For real vendors and customers,
   verify your domain, then set `FROM_EMAIL` below (for example
   `Item cart <hello@yourdomain.com>`).

### 3. Create the function
1. Supabase dashboard → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `notify-new-message`.
3. Paste in the full contents of `supabase/functions/notify-new-message/index.ts`.
4. Deploy.

### 4. Add the secrets
Edge Functions → **Secrets** (or "Manage secrets"). Add:

| Name | Value |
|---|---|
| `WEBHOOK_SECRET` | any long random text you make up (you'll reuse it in step 5) |
| `RESEND_API_KEY` | your Resend API key |
| `SITE_URL` | your website address, no trailing slash, e.g. `https://item-cart.example` |
| `FROM_EMAIL` | optional, e.g. `Item cart <hello@yourdomain.com>` |
| `ADMIN_ALERT_EMAIL` | optional, your email, to be told when a phone number is flagged |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are added for you. Never put the
service key in any website file.

### 5. Connect it to new messages
1. Dashboard → **Database** → **Webhooks** → **Create a new hook**.
2. Name: `notify-new-message`. Table: `messages`. Events: **Insert** only.
3. Type: **Supabase Edge Functions**, and pick `notify-new-message`.
4. Under HTTP Headers add: `x-webhook-secret` = the same text as `WEBHOOK_SECRET`.
5. Create the webhook.

### 6. Test it
1. Link a vendor's account (Admin → Vendors → Logins) and make sure it has an email you can read.
2. As a customer, send that vendor a message.
3. Check the vendor's inbox. If nothing arrives, open **Edge Functions →
   notify-new-message → Logs** to see why.

## Notes
- The email shows the hidden version of a message, never the original phone number.
- The function rejects any request without your secret, so nobody can use it to send email.
- WhatsApp or SMS alerts would be added in the same function, in place of the email-sending step.
