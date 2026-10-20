# Before real users: security check, free-plan limits and go-live list

## 1. Run the security checks (about 15 minutes)

**a. Supabase's own Security Advisor.** In the Supabase dashboard open **Advisors → Security Advisor**
(menu names shift as the dashboard changes). Run it and read each finding. Typical things to fix:
a table without row-level security, or a function anyone can run. Warnings about things you chose on
purpose (for example, the public product catalog being readable by everyone) can be dismissed.

**b. Your own checks.** Open `database/99_security_check.sql` and run each numbered block in the SQL
Editor. Each block says what a good result looks like. Blocks 1 to 4 should return **no rows**.
These queries only read; they change nothing.

**c. A two-minute break-in test.**
1. In a private browser window, open `admin.html`. You should see only a sign-in.
2. Sign in with an ordinary customer account. It should say you aren't an admin.
3. In that window try to open
   `https://YOUR-PROJECT.supabase.co/rest/v1/transactions` (add your public key if asked). You should
   get no order data.

**d. Admin account.** Block 8 of the security check lists the admins. It should be only you. Use a long,
unique password. Two-step sign-in for admins is the next best protection; ask if you want it built.

## 2. Sign-up emails: do this before real users (important)
Supabase's built-in email sender is meant for testing. Reports say it allows only a couple of emails an
hour and delivers only to your own team's addresses, and that this can change without notice. Real students
signing up or resetting a password would not get their emails.

Fix: Supabase → **Authentication → SMTP Settings** → turn on **Custom SMTP** and enter a transactional
email provider's details (several have free tiers; check current limits). You'll need an address on a
domain you own to send from, which is one more reason to settle the brand name and buy the domain first.
Then check **Authentication → Rate Limits**.

Also in Authentication: set the password minimum length to 8 (the site already asks for 8), keep
email confirmation on, and set **URL Configuration** to your live address (see `DEPLOY_SETUP.md`).
Supabase also offers CAPTCHA protection for sign-ups (Authentication → Attack Protection; check it is
available on your plan). Turn it on if fake sign-ups appear.

## 3. Free-plan limits and what they mean for Item cart
Figures are from public 2026 pricing guides. Limits change, so confirm on supabase.com/pricing,
netlify.com/pricing and in your Google AI Studio and Paystack dashboards.

| Service | Free allowance (as reported) | What to watch for Item cart |
|---|---|---|
| **Supabase database** | 500 MB per project | Orders, chats and applications are small. Photos should go to file storage, never the database. |
| **Supabase file storage** | about 1 GB | Product photos are the biggest user. They are now shrunk in the browser before upload (usually 60-250 KB each). |
| **Supabase bandwidth ("egress")** | about 5 GB a month | Every photo view counts. Small images matter. |
| **Supabase sign-ups (monthly active users)** | 50,000 | Far above what you need at first. |
| **Supabase Edge Functions** | 500,000 calls a month | Payments, refunds and Ask Item cart AI each use a few per order or question. |
| **Supabase inactivity** | **project pauses after 1 week with no activity** | A paused site is down until you restore it in the dashboard. Fine while busy; risky in quiet weeks. Visit it weekly, or move to a paid plan before launch. |
| **Supabase backups** | none on free | Export your key tables regularly (Table Editor → export CSV): transactions, orders, vendors, vendor_payouts. |
| **Netlify (new accounts)** | 300 credits a month, shared by deploys, bandwidth and requests | Each production deploy costs credits and the site **pauses** when credits run out. Use the `dev` branch workflow in `DEPLOY_SETUP.md`. Older Netlify accounts have the earlier 100 GB bandwidth / 300 build-minute allowance instead. |
| **Google Gemini (Ask Item cart AI)** | free tier with per-minute and per-day limits | When limits hit, Ask Item cart AI switches to the basic search by itself. Free-tier questions may be used by Google, so keep the "don't type personal details" notice. |
| **Paystack Starter Business** | lifetime collection cap (₦2,000,000 at last check) | After that, payments stop until you register the business. No automatic vendor transfers on Starter. |

Where to check usage: Supabase → Project Settings → Usage; Netlify → Team → Usage; Google AI Studio →
the rate-limit page for your project.

## 4. Go-live checklist
- [ ] All SQL files run in order (01 to 13, plus the optional 14 and 15), and the security check (99) is clean.
- [ ] Security Advisor findings reviewed.
- [ ] Only your account is an admin, with a strong password.
- [ ] Custom SMTP set up and a test sign-up email arrives in a real inbox.
- [ ] Supabase URL Configuration points at the live address.
- [ ] `js/data/config.js`: real WhatsApp number, real bank details, legal contact email, `legal.draft` set to
      `false` after the Privacy Policy and Terms have been reviewed. (The WhatsApp number and bank details
      in the file are demo placeholders.)
- [ ] Brand name settled and domain bought.
- [ ] Paystack: live keys in Supabase Secrets, live webhook address set, one small real payment made and refunded.
- [ ] Netlify: deploying from GitHub, `dev` branch workflow understood, credits dashboard checked.
- [ ] You know how to roll back a bad deploy (Netlify → Deploys → Publish deploy).
- [ ] A weekly reminder to export your data and keep the Supabase project from pausing.
