-- =====================================================================
-- Item cart — Basics before real users: spam protection on vendor applications
-- Run AFTER 01–12.
-- =====================================================================
-- WHAT: the "Become a Vendor" form no longer writes straight into the
--       vendor_applications table. It calls submit_vendor_application(),
--       which checks and limits every application first. The old direct
--       write permission is then removed, so a bot can't go around it.
-- WHY:  until now anyone (or any script) could insert unlimited rows. That
--       would fill your free 500 MB database and bury real applications.
-- WHAT IS CHECKED (change the numbers here if you want different limits):
--   * Hidden "website" box (honeypot): people never see it, bots fill it.
--     A filled box is silently ignored, so the bot learns nothing.
--   * The form must have been open for at least 3 seconds.
--   * Basic sanity: valid-looking email, phone numbers, a real school and
--     category, no links in the names, at most 1 link in the description.
--   * One pending application per email or phone at a time (14 days).
--   * At most 3 applications a day per email or phone.
--   * At most 30 applications an hour, and 200 waiting for review, in total.
--     If spam ever fills that queue, reject the spam in Admin and real
--     applicants can apply again straight away.
-- WHAT THIS CANNOT STOP: a determined person using a different email and
--   phone each time, slowly. For that, add a CAPTCHA (Cloudflare Turnstile
--   is free). The limits above keep the damage small until you do.
-- FUTURE: Turnstile in front of this form if spam ever gets through.
-- =====================================================================

create index if not exists vendor_applications_submitted_idx on vendor_applications (submitted_at desc);

create or replace function submit_vendor_application(
  p_store_name  text,
  p_owner_name  text,
  p_phone       text,
  p_whatsapp    text,
  p_email       text,
  p_school_id   text,
  p_category_id text,
  p_location    text,
  p_description text,
  p_website     text    default null,   -- honeypot: real people leave it empty
  p_elapsed_ms  integer default null    -- how long the form was open, in milliseconds
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := lower(trim(coalesce(p_email, '')));
  v_phone    text := regexp_replace(coalesce(p_phone, ''),    '[^0-9]', '', 'g');
  v_whatsapp text := regexp_replace(coalesce(p_whatsapp, ''), '[^0-9]', '', 'g');
begin
  -- 1. Honeypot. Answer "ok" so a bot can't tell it was caught.
  if nullif(trim(coalesce(p_website, '')), '') is not null then
    return jsonb_build_object('ok', true);
  end if;

  -- 2. Too fast to be a person filling in the form.
  if p_elapsed_ms is null or p_elapsed_ms < 3000 then
    raise exception 'That was quick! Please check your details and press Submit again.';
  end if;

  -- 3. Basic sanity (the table's own length checks still apply too).
  if char_length(trim(coalesce(p_store_name, ''))) = 0 or char_length(trim(coalesce(p_owner_name, ''))) = 0
     or char_length(trim(coalesce(p_location, ''))) = 0 then
    raise exception 'Please fill in every field.';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.';
  end if;
  if char_length(v_phone) not between 7 and 15 or char_length(v_whatsapp) not between 7 and 15 then
    raise exception 'Enter valid phone and WhatsApp numbers.';
  end if;
  if p_store_name ~* '(https?://|www\.)' or p_owner_name ~* '(https?://|www\.)' or p_location ~* '(https?://|www\.)' then
    raise exception 'Please remove links from the name and location fields.';
  end if;
  if coalesce(p_description, '') ~* '(https?://|www\.).*(https?://|www\.)' then
    raise exception 'Please keep to one link at most in your description.';
  end if;
  if not exists (select 1 from schools where id = p_school_id and active) then
    raise exception 'Please choose a valid school.';
  end if;
  if not exists (select 1 from categories where id = p_category_id) then
    raise exception 'Please choose a valid category.';
  end if;

  -- One at a time, so two quick submissions can't both slip past the limits below.
  perform pg_advisory_xact_lock(hashtext('vendor-application'));

  -- 4. Already waiting for review?
  if exists (
    select 1 from vendor_applications
    where status = 'pending_review'
      and submitted_at > now() - interval '14 days'
      and (lower(email) = v_email or regexp_replace(phone, '[^0-9]', '', 'g') = v_phone)
  ) then
    raise exception 'You have already applied. We will review your application and be in touch.';
  end if;

  -- 5. Per email/phone daily limit.
  if (
    select count(*) from vendor_applications
    where submitted_at > now() - interval '24 hours'
      and (lower(email) = v_email or regexp_replace(phone, '[^0-9]', '', 'g') = v_phone)
  ) >= 3 then
    raise exception 'Too many applications from these contact details today. Please try again tomorrow.';
  end if;

  -- 6. Overall limits (protects your free database from a flood).
  if (select count(*) from vendor_applications where submitted_at > now() - interval '1 hour') >= 30
     or (select count(*) from vendor_applications where status = 'pending_review') >= 200 then
    raise exception 'We are getting a lot of applications right now. Please try again in a little while.';
  end if;

  insert into vendor_applications (store_name, owner_name, phone, whatsapp, email, school_id, category_id, location, description)
  values (trim(p_store_name), trim(p_owner_name), trim(p_phone), trim(p_whatsapp), trim(p_email), p_school_id, p_category_id, trim(p_location), trim(p_description));

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function submit_vendor_application(text, text, text, text, text, text, text, text, text, text, integer) from public;
grant  execute on function submit_vendor_application(text, text, text, text, text, text, text, text, text, text, integer) to anon, authenticated;

-- Close the old door: the website can no longer insert applications directly.
drop policy if exists "anyone can apply" on vendor_applications;
revoke insert on vendor_applications from anon, authenticated;


-- ---------------------------------------------------------------------
-- CHECK IT WORKED (optional)
-- ---------------------------------------------------------------------
--  1. Submit a normal application on the website: it appears in Admin → Applications.
--  2. Submit the same one again: "You have already applied."
--  3. In your browser, a direct insert into the table must now be REFUSED:
--        POST https://YOUR-PROJECT.supabase.co/rest/v1/vendor_applications
--     with your anon key. Expect "permission denied".
