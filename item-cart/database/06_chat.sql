-- =====================================================================
-- Item cart — Phase 4: customer ⇄ vendor chat
-- Run AFTER 01, 02, 03, 04 and 05.
-- =====================================================================
-- WHAT: in-site messaging between a signed-in customer and a vendor.
--       Phone numbers are HIDDEN automatically and the message is FLAGGED
--       for you to review in the admin page.
-- WHY:  keeps conversations, orders and payments on Item cart.
-- HOW IT STAYS SAFE:
--   * Messages can only be created through send_message / start_conversation.
--     Nobody can insert a message directly, so the filter can't be skipped.
--   * The ORIGINAL text of a flagged message is stored in message_flags,
--     which only admins can read. The other person only ever receives the
--     hidden version.
--   * People only see conversations they are part of.
-- FUTURE: notify vendors by WhatsApp/email when a message arrives; add
--         photos; add "report this message".
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. VENDOR ACCOUNTS
-- ---------------------------------------------------------------------
-- A vendor logs in with an ordinary Item cart account. You (admin) link that
-- account to their store, and it then unlocks the store's inbox.
create table if not exists vendor_members (
  vendor_id   text not null references vendors(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (vendor_id, user_id)
);

alter table vendor_members enable row level security;
create policy "see own vendor links" on vendor_members for select to authenticated using (user_id = auth.uid());

revoke all on vendor_members from anon;
revoke insert, update, delete on vendor_members from authenticated;
grant select on vendor_members to authenticated;

create or replace function is_vendor_member(p_vendor_id text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from vendor_members where vendor_id = p_vendor_id and user_id = auth.uid()
  );
$$;

-- The stores the signed-in person manages (empty for ordinary customers).
-- JS: supabase.rpc('get_my_vendors')
create or replace function get_my_vendors()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    jsonb_agg(jsonb_build_object('id', v.id, 'storeName', v.store_name) order by v.store_name),
    '[]'::jsonb
  )
  from vendor_members vm
  join vendors v on v.id = vm.vendor_id
  where vm.user_id = auth.uid();
$$;

revoke execute on function get_my_vendors() from public, anon;
grant  execute on function get_my_vendors() to authenticated;


-- ---------------------------------------------------------------------
-- 2. CHAT TABLES
-- ---------------------------------------------------------------------
-- One conversation per customer + vendor pair.
create table conversations (
  id                    uuid primary key default gen_random_uuid(),
  customer_id           uuid not null references auth.users(id) on delete cascade,
  vendor_id             text not null references vendors(id) on delete cascade,
  created_at            timestamptz not null default now(),
  last_message_at       timestamptz not null default now(),
  customer_last_read_at timestamptz,
  vendor_last_read_at   timestamptz,
  unique (customer_id, vendor_id)
);

create index conversations_customer_idx on conversations(customer_id, last_message_at desc);
create index conversations_vendor_idx   on conversations(vendor_id, last_message_at desc);

-- "body" is ALWAYS the safe, hidden version. Both people see this.
create table messages (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  sender_id        uuid not null references auth.users(id) on delete cascade,
  sender_role      text not null check (sender_role in ('customer', 'vendor')),
  body             text not null check (char_length(body) between 1 and 3000),
  flagged          boolean not null default false,
  created_at       timestamptz not null default now()
);

create index messages_conversation_idx on messages(conversation_id, id);
create index messages_sender_idx       on messages(sender_id, created_at);

-- The ORIGINAL text of flagged messages. Admin-only (see section 5).
create table message_flags (
  message_id    bigint primary key references messages(id) on delete cascade,
  original_body text not null,
  reason        text not null default 'phone_number',
  reviewed      boolean not null default false,
  reviewed_by   uuid references auth.users(id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 3. SECURITY RULES (Row Level Security)
-- ---------------------------------------------------------------------
alter table conversations  enable row level security;
alter table messages       enable row level security;
alter table message_flags  enable row level security;   -- no policies: nobody via the API

create policy "see own conversations" on conversations
  for select to authenticated
  using (customer_id = auth.uid() or is_vendor_member(vendor_id));

create policy "see messages in own conversations" on messages
  for select to authenticated
  using (exists (
    select 1 from conversations c
    where c.id = messages.conversation_id
      and (c.customer_id = auth.uid() or is_vendor_member(c.vendor_id))
  ));

-- Reading only. Writing happens ONLY through the functions below.
revoke all on conversations, messages, message_flags from anon;
revoke all on message_flags from authenticated;
revoke insert, update, delete on conversations, messages from authenticated;
grant select on conversations, messages to authenticated;


-- ---------------------------------------------------------------------
-- 4. THE PHONE-NUMBER FILTER
-- ---------------------------------------------------------------------
-- Finds phone-style numbers and replaces each with "[contact number hidden]".
--   * digits with spaces, dots, dashes or brackets:  0803 111 2222, +234 803-111-2222
--   * spelled-out digits:                            zero eight zero three one one ...
--   * a letter "o" typed between digits:             08o3 111 2222
-- Any run of 10+ digits counts, so bank account numbers are caught too —
-- that is deliberate: it is the same way of taking a deal off Item cart.
-- It can't catch everything (nothing can), but it covers the common tricks.
-- Prices, dates, order ids and quantities are left alone.
--
-- Try it:  select * from mask_contact_details('call me on 0803 111 2222');
create or replace function mask_contact_details(p_body text, out masked text, out was_flagged boolean)
language plpgsql
immutable
as $$
declare
  v_text   text := regexp_replace(coalesce(p_body, ''), '(?<=\d)[oO](?=\d)', '0', 'g');
  v_match  text[];
  v_digits text;
begin
  was_flagged := false;

  -- 1. runs of digits (with separators between them)
  for v_match in
    select regexp_matches(v_text, '(\+?\(?\d[\d\s().\-]{7,}\d)', 'g')
  loop
    v_digits := regexp_replace(v_match[1], '\D', '', 'g');
    if length(v_digits) >= 10 then
      v_text := replace(v_text, v_match[1], '[contact number hidden]');
      was_flagged := true;
    end if;
  end loop;

  -- 2. digits spelled out as words (8 or more in a row)
  for v_match in
    select regexp_matches(
      v_text,
      '\m((?:zero|oh|one|two|three|four|five|six|seven|eight|nine)(?:[\s,.\-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)){7,})\M',
      'gi'
    )
  loop
    v_text := replace(v_text, v_match[1], '[contact number hidden]');
    was_flagged := true;
  end loop;

  masked := case when was_flagged then v_text else coalesce(p_body, '') end;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. SENDING MESSAGES
-- ---------------------------------------------------------------------
-- Send a message in an existing conversation (customer OR the vendor's team).
-- JS: supabase.rpc('send_message', { p_conversation_id, p_body })
create or replace function send_message(p_conversation_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_body    text := btrim(coalesce(p_body, ''));
  v_role    text;
  v_masked  text;
  v_flagged boolean;
  v_id      bigint;
  c         conversations%rowtype;
begin
  if v_user is null then raise exception 'Sign in to send messages.'; end if;
  if char_length(v_body) = 0 then raise exception 'Type a message first.'; end if;
  if char_length(v_body) > 1000 then raise exception 'Messages can be up to 1,000 characters.'; end if;

  select * into c from conversations where id = p_conversation_id;
  if not found then raise exception 'Conversation not found.'; end if;

  if c.customer_id = v_user then
    v_role := 'customer';
  elsif is_vendor_member(c.vendor_id) then
    v_role := 'vendor';
  else
    raise exception 'You can''t send messages in this conversation.';
  end if;

  if v_role = 'customer' and not exists (select 1 from vendors where id = c.vendor_id and active) then
    raise exception 'This vendor isn''t available right now.';
  end if;

  -- Simple spam brake: at most 20 messages a minute.
  if (select count(*) from messages where sender_id = v_user and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'You''re sending messages too quickly. Please wait a moment.';
  end if;

  select f.masked, f.was_flagged into v_masked, v_flagged from mask_contact_details(v_body) f;

  insert into messages (conversation_id, sender_id, sender_role, body, flagged)
  values (c.id, v_user, v_role, v_masked, v_flagged)
  returning id into v_id;

  if v_flagged then
    insert into message_flags (message_id, original_body) values (v_id, v_body);
  end if;

  update conversations
  set last_message_at       = now(),
      customer_last_read_at = case when v_role = 'customer' then now() else customer_last_read_at end,
      vendor_last_read_at   = case when v_role = 'vendor'   then now() else vendor_last_read_at end
  where id = c.id;

  return jsonb_build_object('id', v_id, 'body', v_masked, 'flagged', v_flagged);
end;
$$;

-- A customer's FIRST message to a vendor (creates the conversation).
-- JS: supabase.rpc('start_conversation', { p_vendor_id, p_body })
create or replace function start_conversation(p_vendor_id text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user         uuid := auth.uid();
  v_conversation uuid;
begin
  if v_user is null then raise exception 'Sign in to send messages.'; end if;
  if not exists (select 1 from vendors where id = p_vendor_id and active) then
    raise exception 'This vendor isn''t available right now.';
  end if;
  if is_vendor_member(p_vendor_id) then
    raise exception 'You can''t message your own store.';
  end if;

  insert into conversations (customer_id, vendor_id)
  values (v_user, p_vendor_id)
  on conflict (customer_id, vendor_id) do nothing;

  select id into v_conversation
  from conversations
  where customer_id = v_user and vendor_id = p_vendor_id;

  return send_message(v_conversation, p_body) || jsonb_build_object('conversationId', v_conversation);
end;
$$;

-- Mark everything in a conversation as read (for the person calling).
create or replace function mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;

  update conversations set customer_last_read_at = now()
  where id = p_conversation_id and customer_id = auth.uid();

  update conversations set vendor_last_read_at = now()
  where id = p_conversation_id and is_vendor_member(vendor_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 6. INBOXES
-- ---------------------------------------------------------------------
-- The signed-in customer's conversations, newest first.
-- JS: supabase.rpc('get_my_conversations')
create or replace function get_my_conversations()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'vendorId', c.vendor_id,
        'name', v.store_name,
        'image', v.image,
        'lastMessage', lm.body,
        'lastSenderRole', lm.sender_role,
        'lastMessageAt', c.last_message_at,
        'unread', (
          select count(*) from messages m
          where m.conversation_id = c.id
            and m.sender_role = 'vendor'
            and m.created_at > coalesce(c.customer_last_read_at, '-infinity'::timestamptz)
        )
      )
      order by c.last_message_at desc
    ),
    '[]'::jsonb
  )
  from conversations c
  join vendors v on v.id = c.vendor_id
  left join lateral (
    select m.body, m.sender_role from messages m where m.conversation_id = c.id order by m.id desc limit 1
  ) lm on true
  where c.customer_id = auth.uid();
$$;

-- A store's conversations (only for people linked to that store).
-- JS: supabase.rpc('get_vendor_conversations', { p_vendor_id })
create or replace function get_vendor_conversations(p_vendor_id text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_vendor_member(p_vendor_id) then
    raise exception 'You don''t manage this store.';
  end if;

  return (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'vendorId', c.vendor_id,
          'name', coalesce(p.full_name, 'Customer'),
          'image', null,
          'lastMessage', lm.body,
          'lastSenderRole', lm.sender_role,
          'lastMessageAt', c.last_message_at,
          'unread', (
            select count(*) from messages m
            where m.conversation_id = c.id
              and m.sender_role = 'customer'
              and m.created_at > coalesce(c.vendor_last_read_at, '-infinity'::timestamptz)
          )
        )
        order by c.last_message_at desc
      ),
      '[]'::jsonb
    )
    from conversations c
    left join profiles p on p.user_id = c.customer_id
    left join lateral (
      select m.body, m.sender_role from messages m where m.conversation_id = c.id order by m.id desc limit 1
    ) lm on true
    where c.vendor_id = p_vendor_id
  );
end;
$$;

revoke execute on function send_message(uuid, text)           from public, anon;
revoke execute on function start_conversation(text, text)     from public, anon;
revoke execute on function mark_conversation_read(uuid)       from public, anon;
revoke execute on function get_my_conversations()             from public, anon;
revoke execute on function get_vendor_conversations(text)     from public, anon;
grant  execute on function send_message(uuid, text)           to authenticated;
grant  execute on function start_conversation(text, text)     to authenticated;
grant  execute on function mark_conversation_read(uuid)       to authenticated;
grant  execute on function get_my_conversations()             to authenticated;
grant  execute on function get_vendor_conversations(text)     to authenticated;


-- ---------------------------------------------------------------------
-- 7. ADMIN TOOLS
-- ---------------------------------------------------------------------
-- Flagged messages for review: the original text, who sent it, the last
-- few messages before it (for context), and how many times that sender
-- has been flagged. You see flagged messages and their context, not every
-- chat. JS: supabase.rpc('admin_flagged_messages')
create or replace function admin_flagged_messages()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;

  return coalesce((
    with recent as (
      select f.message_id, f.original_body, f.reason, f.reviewed
      from message_flags f
      order by f.reviewed, f.message_id desc
      limit 200
    )
    select jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'conversationId', m.conversation_id,
        'vendorId', c.vendor_id,
        'vendorName', v.store_name,
        'senderRole', m.sender_role,
        'senderName', case when m.sender_role = 'customer' then coalesce(p.full_name, 'Customer') else v.store_name end,
        'originalBody', r.original_body,
        'maskedBody', m.body,
        'reason', r.reason,
        'reviewed', r.reviewed,
        'createdAt', m.created_at,
        'senderFlagCount', (
          select count(*) from message_flags f2
          join messages m2 on m2.id = f2.message_id
          where m2.sender_id = m.sender_id
        ),
        'context', coalesce((
          select jsonb_agg(jsonb_build_object('role', x.sender_role, 'body', x.body) order by x.id)
          from (
            select m3.id, m3.sender_role, m3.body
            from messages m3
            where m3.conversation_id = m.conversation_id and m3.id < m.id
            order by m3.id desc
            limit 3
          ) x
        ), '[]'::jsonb)
      )
      order by r.reviewed, m.id desc
    )
    from recent r
    join messages m       on m.id = r.message_id
    join conversations c  on c.id = m.conversation_id
    join vendors v        on v.id = c.vendor_id
    left join profiles p  on p.user_id = c.customer_id
  ), '[]'::jsonb);
end;
$$;

-- JS: supabase.rpc('admin_review_flag', { p_message_id })
create or replace function admin_review_flag(p_message_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;

  update message_flags
  set reviewed = true, reviewed_by = auth.uid(), reviewed_at = now()
  where message_id = p_message_id;
end;
$$;

-- Link / unlink a vendor's login to their store.
-- The vendor must already have created a normal Item cart account.
-- JS: supabase.rpc('admin_link_vendor_account', { p_vendor_id, p_email })
create or replace function admin_link_vendor_account(p_vendor_id text, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  if not exists (select 1 from vendors where id = p_vendor_id) then raise exception 'Vendor not found.'; end if;

  select id into v_user from auth.users where lower(email) = lower(btrim(coalesce(p_email, '')));
  if v_user is null then
    raise exception 'No account with that email yet. Ask them to create an account on Item cart first.';
  end if;

  insert into vendor_members (vendor_id, user_id) values (p_vendor_id, v_user)
  on conflict do nothing;

  return jsonb_build_object('userId', v_user);
end;
$$;

create or replace function admin_unlink_vendor_account(p_vendor_id text, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  delete from vendor_members where vendor_id = p_vendor_id and user_id = p_user_id;
end;
$$;

-- JS: supabase.rpc('admin_vendor_accounts', { p_vendor_id })
create or replace function admin_vendor_accounts(p_vendor_id text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('userId', vm.user_id, 'email', u.email) order by u.email)
    from vendor_members vm
    join auth.users u on u.id = vm.user_id
    where vm.vendor_id = p_vendor_id
  ), '[]'::jsonb);
end;
$$;

revoke execute on function admin_flagged_messages()                  from public, anon;
revoke execute on function admin_review_flag(bigint)                 from public, anon;
revoke execute on function admin_link_vendor_account(text, text)     from public, anon;
revoke execute on function admin_unlink_vendor_account(text, uuid)   from public, anon;
revoke execute on function admin_vendor_accounts(text)               from public, anon;
grant  execute on function admin_flagged_messages()                  to authenticated;
grant  execute on function admin_review_flag(bigint)                 to authenticated;
grant  execute on function admin_link_vendor_account(text, text)     to authenticated;
grant  execute on function admin_unlink_vendor_account(text, uuid)   to authenticated;
grant  execute on function admin_vendor_accounts(text)               to authenticated;


-- ---------------------------------------------------------------------
-- 8. LIVE UPDATES (new messages appear without refreshing)
-- ---------------------------------------------------------------------
-- If this line errors, the chat still works — it just refreshes every
-- few seconds instead of instantly.
do $$
begin
  alter publication supabase_realtime add table messages;
exception when others then
  null;
end;
$$;


-- ---------------------------------------------------------------------
-- 9. QUICK SELF-TEST (optional): run these one at a time after the file.
-- ---------------------------------------------------------------------
--  select * from mask_contact_details('call me on 0803 111 2222');
--     → masked: "call me on [contact number hidden]",  was_flagged: true
--  select * from mask_contact_details('zero eight zero three one one one two two two two');
--     → masked: "[contact number hidden]",             was_flagged: true
--  select * from mask_contact_details('I need 2 portions for ₦2,500 each, order RUN-1001');
--     → unchanged,                                     was_flagged: false
