# Ask Item cart AI — setup

Ask Item cart AI is the shopping guide button on the Marketplace and Home pages.
A customer types something like "a bag under ₦2,000 near the main gate" and it
shows matching products that are really on Item cart.

## How it works (so you know what to expect)

- **Only a small button loads with the page.** The chat panel, its styles and the
  search code download only when someone taps "Ask Item cart AI". Visitors who
  never tap it download nothing extra and wait for nothing.
- **The AI only understands the sentence.** It turns it into a few filters (item,
  budget, place). It is never shown your products or prices, so it cannot
  recommend or invent one.
- **The search runs in the customer's browser** on the catalog the page already
  loaded. Every product, price and vendor on screen comes from that catalog.
- **If the AI is slow, busy or out of free quota,** the site switches to a simple
  built-in search automatically. Customers still get real results.
- **Chats are stored in the customer's browser only,** for 3 hours after the last
  message, then wiped. Nothing is saved in Supabase, so it uses none of your free
  database storage. (Change the time in `js/modules/askStore.js`: `CHAT_TTL_MS`.)

## Steps

### 1. Get a free Gemini key
1. Go to **aistudio.google.com/apikey** and sign in with a Google account.
2. Create an API key and copy it.
3. Do NOT turn on billing for that project. Without billing it stays on the free tier.

### 2. Create the function
1. Supabase dashboard → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `ask-runnit` (an internal address that customers never see; the website calls it by this name, so keep it as it is).
3. Paste in the full contents of `supabase/functions/ask-runnit/index.ts`.
4. Deploy. Leave "Verify JWT" **on** (the website sends your public key, which is enough).

### 3. Add the secrets
Edge Functions → **Secrets**. Add:

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | the key from step 1 |
| `GEMINI_MODEL` | optional. Defaults to `gemini-3.1-flash-lite`. See "If the AI stops answering" below |
| `ALLOWED_ORIGINS` | optional, your website address, e.g. `https://item-cart.example`. Leave empty while testing |

### 4. Upload the website files and test
1. Open the Marketplace, tap **Ask Item cart AI**, and ask for something.
2. If answers end with "(Smart search is busy, so I used a simpler search.)", the
   AI isn't being reached. Check **Edge Functions → ask-runnit → Logs**. The log
   shows only a short reason such as `gemini_404` or `gemini_429`, never what the
   customer typed.

## Good to know

- **Free limits.** Google's free tier has per-minute and per-day limits that can
  change. Look at the rate-limit page in your AI Studio project for today's numbers.
  When the free limit is hit, the function pauses AI calls for a minute and the
  basic search covers the gap.
- **Privacy.** On Google's free tier, Google may use prompts and replies to improve
  its products, and people may read them. The panel tells customers not to type
  personal details, and only the one question is ever sent (never names, phone
  numbers, orders or products). Mention this in your privacy policy. Paid usage
  is treated differently by Google, which is the upgrade path if Item cart grows.
- **Age.** Google's terms for the Gemini API restrict services likely to be used by
  people under 18. UNIOSUN students are mostly adults, but keep this in mind.
- **If the AI stops answering.** Google retires models often. If the log shows
  `gemini_404`, set the `GEMINI_MODEL` secret to a current free "flash-lite" model
  from Google's model list. No code change is needed, and the site keeps working
  on basic search in the meantime.
- **Cost protection.** Each visitor is limited to 12 questions a minute. Questions
  longer than 200 characters are refused. The key never reaches the browser.
- **Locations.** Vendors' locations are free text today ("Behind Faculty of Science,
  UNIOSUN"), so "near the main gate" only matches vendors whose address mentions
  the gate. Phase 2 adds a proper "area" for each vendor.

## Phase 3: conversation (what's new)

Ask Item cart AI now remembers the conversation and helps a student who can't decide.

**What students can do**
- **Follow up:** "anything cheaper?", "the second one", "under 3000 instead".
- **Compare:** "jollof vs shawarma", or tap **Compare these** under any results. They get a
  side-by-side table (price, rating, vendor, stock) with the best price and rating highlighted.
- **Get a pick:** "which should I buy?" or tap **Pick for me / Lowest price / Best rated**. The
  answer names one product and gives the reason.
- **Ask about a listing:** tap **Ask** on a product card (or ask "does the hoodie come in black?").
  If the product's own listing answers it, that exact line is shown in quotes. If not, it says the
  listing doesn't say and offers **Ask the vendor**, which opens the vendor chat with the question
  ready in the message box (they still press Send).

**What did NOT change (the safety rules)**
- The AI only works out what the student wants to do. Every price, rating, vendor and difference on
  screen is read from your catalog each time it is drawn, so a stored chat never shows an old price.
- For listing questions, the AI may only point at words that are really in that listing. The server
  checks it, the page checks it again, and anything invented is thrown away.
- Tapping a quick reply never calls the AI. Typed messages use one free call each; a listing question
  uses one more.
- Chats and their memory stay in the student's browser for 3 hours. Nothing is saved in Supabase.
- Nothing downloads until someone taps the button.

**To switch it on**
1. Supabase → Edge Functions → `ask-runnit` → paste in the new
   `supabase/functions/ask-runnit/index.ts` → Deploy. (Same secrets, nothing new to add.)
2. Upload the website files.

**Good to know**
- If the free AI is busy or down, the page understands the common follow-ups itself, so compare,
  pick and "cheaper" keep working. Listing questions fall back to a simple word match and say so.
- "Best rated" is only as meaningful as the ratings in your catalog. They are fixed numbers today.
  Verified-buyer ratings (on your roadmap) will make this much more useful.
- The Privacy Policy and Terms were updated to describe what is now sent to Google (names of
  products already shown, and a listing's text when asked about). Keep them in sync if you change it.
