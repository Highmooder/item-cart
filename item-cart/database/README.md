# Database files (Supabase)

Open Supabase → SQL Editor → New query, paste one file at a time, and press Run.
Run them in this order, once each:

1. `01_schema.sql`            tables and security rules
2. `02_seed.sql`             your starting vendors and products
3. `03_admin_catalog.sql`    add/remove vendors and products
4. `04_confirmation_vendor_name.sql`
5. `05_customer_accounts.sql` customer accounts and order history
6. `06_chat.sql`             vendor chat with phone numbers hidden
7. `07_alerts.sql`           unread counts for message alerts
8. `08_private_vendor_contacts.sql`   vendor phone/email private (admin only)
9. `09_vendor_products.sql`   vendors post products; admin approves before they go live
10. `10_vendor_orders.sql`    vendors see their paid orders, tap Ready, and message the customer
11. `11_online_payments.sql`  online payment (Paystack): fee, start payment, mark paid automatically
12. `12_payouts_and_refunds.sql`  what each vendor is owed, record payouts, refund online payments
13. `13_application_spam_protection.sql`  spam limits on the Become a Vendor form
14. `14_typing_indicator.sql`  live "is typing" dots and instant "Seen" ticks in chat (optional; chat works without it)
15. `15_unread_chats.sql`  lets the unread badge open the exact unread chat (optional; the badge works without it)
16. `16_support_chat_and_receipts.sql`  customers send their bank-transfer receipt to "Item cart Admin" in Messages (needed for the receipt upload button)

Email alerts need extra steps: see `ALERTS_SETUP.md`.

Online payments need two Edge Functions and a Paystack account: see `PAYSTACK_SETUP.md`.
Payouts and refunds: see `PAYOUTS_AND_REFUNDS_SETUP.md`.
Before real users: run `99_security_check.sql` and follow `SECURITY_AND_LIMITS.md`.

Ask Item cart AI (the shopping guide) needs no SQL, only a free Gemini key and one Edge Function: see `ASK_ITEM_CART_SETUP.md`.
