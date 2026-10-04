-- Public send API, incoming calls, weekly WhatsApp checks and 1-Click notifications

-- API keys: only a SHA-256 of the key is stored; the key itself is shown once when created
create table api_keys (
  id           serial primary key,
  name         text not null,
  prefix       text not null,                 -- first characters, to recognise a key in the list
  key_hash     text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

alter table messages
  add column api_key_id int references api_keys(id) on delete set null,
  add column client_ref text;                 -- caller's own id (makes retries safe)
create unique index messages_api_ref_idx on messages(api_key_id, client_ref) where client_ref is not null;
create index on messages(api_key_id, id desc) where api_key_id is not null;

-- Per number: may the app pick it on its own (API sends, WhatsApp checks), and what to do with calls
alter table wa_numbers
  add column auto_use    boolean not null default true,
  add column call_policy text not null default 'ignore',   -- 'ignore' (rings on the phone) | 'reject'
  add column call_reply  text;                              -- message sent after rejecting (empty = none)

create table calls (
  id         bigserial primary key,
  number_id  int references wa_numbers(id) on delete cascade,
  phone      text,                  -- caller (null if WhatsApp hid it)
  video      boolean not null default false,
  action     text not null,         -- 'ignored' | 'rejected' | 'rejected+replied' | 'failed'
  created_at timestamptz not null default now()
);
create index on calls(created_at desc);
create index on calls(phone, created_at desc);

-- Weekly WhatsApp check: oldest first
create index on phone_checks(checked_at);

-- 1-Click notifications: who got which notice (so a second click warns instead of re-sending)
create table oneclick_log (
  id          bigserial primary key,
  kind        text not null,        -- 'marks' | 'fees'
  ref         text not null,        -- marks: "<year>|<assessment group>", fees: 'fees'
  student_id  int references students(id) on delete cascade,
  campaign_id int references campaigns(id) on delete set null,
  summary     text,                 -- e.g. "412/500" or "₹6,000"
  created_at  timestamptz not null default now()
);
create index on oneclick_log(kind, ref, student_id, created_at desc);

-- A personal number is never picked automatically until the admin allows it (Settings → Numbers & calls)
update wa_numbers set auto_use = false where session ilike '%personal%' or label ilike '%personal%';
