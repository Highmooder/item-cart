-- =====================================================================
-- 16_support_chat_and_receipts.sql
-- =====================================================================
-- WHAT: lets a customer send their bank-transfer RECEIPT (a photo) to
--       "Item cart Admin" in the Messages chat, instead of using WhatsApp.
-- HOW:  (1) a hidden "Item cart Admin" store customers can message,
--       (2) a private place to keep receipt photos,
--       (3) one new function that sends a chat message with a photo attached.
-- SAFE: run it once. Running it again changes nothing. It does not change
--       any existing chat function, so ordinary vendor chat is untouched.
-- AFTER RUNNING: in admin.html > Vendors, open "Item cart Admin" > Logins and
--       link YOUR login. Then Messages > "Item cart Admin" tab shows the
--       receipts customers send you.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. The "Item cart Admin" chat inbox
-- ---------------------------------------------------------------------
-- It is a store row so the existing chat (conversations, unread badges,
-- email alerts) works as it is. The shop pages hide it (js/modules/catalog.js)
-- and it has no products, so customers never see it as a store.
-- The id 'runnit-admin' is only an internal key (never shown to anyone). It keeps
-- its old spelling on purpose: js/data/config.js (supportVendorId) must match it.
insert into vendors (id, store_name, owner_name, phone, whatsapp, email,
                     description, category_id, location, school_id, verified, active)
select 'runnit-admin', 'Item cart Admin', 'Item cart', 'n/a', 'n/a', 'n/a',
       'Item cart support inbox for payment receipts.',
       (select id from categories order by name limit 1),
       'Online',
       (select id from schools order by name limit 1),
       true, true
where not exists (select 1 from vendors where id = 'runnit-admin')
  and exists (select 1 from categories)
  and exists (select 1 from schools);


-- ---------------------------------------------------------------------
-- 2. Photos on messages
-- ---------------------------------------------------------------------
alter table messages add column if not exists attachment_path text;


-- ---------------------------------------------------------------------
-- 3. Private storage for receipt photos
-- ---------------------------------------------------------------------
-- Private bucket: nobody can open a receipt by guessing a link. Each customer
-- uploads into their own folder (<their user id>/...). They can add files but
-- not replace or delete them. Only that customer, the Item cart Admin team and
-- admins can view them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-receipts', 'chat-receipts', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = 3145728,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "customers upload own receipts" on storage.objects;
create policy "customers upload own receipts" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "receipts viewable by owner and Item cart team" on storage.objects;
create policy "receipts viewable by owner and Item cart team" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-receipts'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
      or public.is_vendor_member('runnit-admin')
    )
  );


-- ---------------------------------------------------------------------
-- 4. Send a chat message with a receipt photo
-- ---------------------------------------------------------------------
-- JS: supabase.rpc('send_receipt', { p_conversation_id, p_body, p_path })
-- It reuses send_message (so the phone-number hiding, the 20-a-minute limit
-- and the unread/alert behaviour all still apply) and then attaches the photo.
-- Only a customer, only in their own chat with Item cart Admin, and only a file
-- from their own folder.
create or replace function send_receipt(p_conversation_id uuid, p_body text, p_path text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_result jsonb;
  c        conversations%rowtype;
begin
  if v_user is null then raise exception 'Sign in to send messages.'; end if;

  select * into c from conversations where id = p_conversation_id;
  if not found or c.customer_id <> v_user or c.vendor_id <> 'runnit-admin' then
    raise exception 'Receipts can only be sent to Item cart Admin.';
  end if;

  if p_path is null or p_path not like (v_user::text || '/%') or char_length(p_path) > 300 then
    raise exception 'That receipt photo isn''t valid. Please upload it again.';
  end if;

  v_result := send_message(p_conversation_id, p_body);
  update messages set attachment_path = p_path where id = (v_result ->> 'id')::bigint;
  return v_result;
end;
$$;

revoke execute on function send_receipt(uuid, text, text) from public, anon;
grant  execute on function send_receipt(uuid, text, text) to authenticated;
