# Deploying Item cart from GitHub to Netlify

Why bother: today you upload the site to Netlify by hand. Putting it on GitHub first gives you
**history** (every change saved) and **undo** (go back to any earlier version), and Netlify
publishes automatically from it.

## 1. Put the project on GitHub
1. Create a free account at github.com and sign in.
2. **New repository** → name it `item-cart` → choose **Private** → Create.
   (Private, because the SQL files and Edge Function code show how your system works, even
   though they contain no secrets.)
3. Upload the project:
   - **On a computer:** unzip the project, open the new repository, **Add file → Upload files**,
     drag in everything, then **Commit changes**. If GitHub says there are too many files, upload
     in two or three batches (for example, the `js` and `css` folders first, then the rest).
   - **Easier long-term:** install **GitHub Desktop**, choose "Add local repository", and press
     Commit and Push whenever you change something.
4. Check that no secret is in there. The site's `js/data/supabaseConfig.js` holds only your
   PUBLIC Supabase key, which is meant to be public and is safe to commit. Your Paystack key, Gemini key
   and Supabase **service** key live only in Supabase's Secrets screen. If one was ever pasted into a
   file, treat it as leaked: create a new one and delete the old one.

## 2. Connect Netlify
1. Netlify → **Add new site → Import an existing project → GitHub** → pick the `item-cart` repository.
2. Branch to deploy: `main`. **Build command:** leave empty. **Publish directory:** `.`
   (a single dot). Netlify also reads `netlify.toml`, which sets this and adds safety headers.
3. **Deploy.** From now on, every change you push to `main` is published automatically.

## 3. Use a test branch (important on Netlify's free plan)
New Netlify free accounts get a monthly allowance of "credits", and each **production** deploy
uses some of them. When the credits run out, the site pauses until next month. Deploys from other
branches and Deploy Previews are free.

So don't push every tiny change to `main`:
1. In GitHub create a branch called `dev`. Make your changes there.
2. Netlify → Site configuration → Build & deploy → Branches → turn on **branch deploys** for `dev`.
   Your changes appear at a test address like `dev--yourname.netlify.app`, for free.
3. When you're happy, merge `dev` into `main` (GitHub: **Pull request → Merge**). That is one
   production deploy.

Careful: the test address talks to your REAL Supabase. Place test orders only in Paystack TEST mode.

## 4. Undo a mistake
- **Fastest (live site is broken):** Netlify → **Deploys** → click an earlier good deploy →
  **Publish deploy**. The old version is live again in seconds.
- **Properly:** GitHub → open the bad commit → **Revert**. That makes a new commit that undoes it.

## 5. After you have your real address or domain
- **Supabase → Authentication → URL Configuration:** set **Site URL** to your live address and add
  it to **Redirect URLs**. Without this, sign-in and password-reset emails can point to the wrong place.
- **Supabase → Edge Functions → Secrets:** set `SITE_URL` (used by online payments) and, if you use
  it, `ALLOWED_ORIGINS` to the same address.
- Replace the placeholders in `js/data/config.js` (legal contact email, WhatsApp number, bank details).
- If you ever move Supabase to a custom address, update the `connect-src` part of the security
  header in `netlify.toml` to match.

## 6. Turning on the stricter security header later
`netlify.toml` ships a Content-Security-Policy in **Report-Only** mode. It never blocks anything.
Browse every page (checkout, messages, admin, Ask Item cart AI) with your browser's developer console open
(it should show no "Content Security Policy" warnings), then rename the header to
`Content-Security-Policy` to start enforcing it. If a warning appears for something you use,
add that address to the policy first.

## 7. Installing Item cart as an app (PWA)
Item cart can be installed from the browser, with no app store. Nothing to set up: deploy as usual.
- **Android / Chrome / Edge:** an **Install app** row appears in the phone menu and the footer
  (or use the browser's own menu → *Install app*).
- **iPhone / iPad:** the same row shows the steps: Share → **Add to Home Screen**.
- It only works on the live `https://` address, not when you open the files from your computer.
- `sw.js` is the helper behind it. It saves only Item cart's own pages and files, always tries the
  internet first, and shows an "You're offline" page when there is none. It never stores accounts,
  orders or messages. After a deploy, phones pick up the change by themselves; you only edit
  `VERSION` at the top of `sw.js` if you ever want every phone to throw away its saved copies.
- If a page looks stuck on an old version while you are testing, Chrome → DevTools → Application
  → Service Workers → **Unregister**, then refresh.
- Alerts for new messages still only arrive while Item cart is open (or recently open) on the phone.
  Alerts to a fully closed app would need push notifications, which is a separate build.

## 8. Link previews and search engines
When someone shares an Item cart link on WhatsApp, the preview shows the Item cart picture, title and a line
of text (`assets/og-image.png` and the tags in each page's `<head>`). `robots.txt` and `sitemap.xml`
tell Google which pages to list; the private pages (account, cart, checkout, messages, admin, vendor
pages) are marked `noindex`.
- **One step is yours:** these files contain the placeholder `https://YOUR-SITE-ADDRESS`. Replace it
  with your real address (no slash at the end) in every file: in VS Code use Find in Files
  (Ctrl+Shift+F), search `YOUR-SITE-ADDRESS`, then Replace All. Do it again if you ever change domain.
- Test: send the link to yourself on WhatsApp. WhatsApp remembers old previews, so a link you already
  sent may keep the old look; a fresh link shows the new one.
- Search: add the site in Google Search Console and submit `sitemap.xml`.
- Product and store pages show the general Item cart preview (their details load after the page opens).

## What is NOT published
`netlify.toml` makes the `database/` and `supabase/` folders and these guides answer "not found"
on the live website, so the project's internal files aren't downloadable by visitors.
