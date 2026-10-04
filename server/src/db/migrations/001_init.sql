-- All tables live in the `whatsapp` schema (search_path is set by the DB service).

create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- One row per connected WhatsApp number (= one WAHA session)
create table wa_numbers (
  id              serial primary key,
  label           text not null,
  session         text not null unique,          -- WAHA session name
  phone           text,                           -- filled once connected
  push_name       text,
  status          text not null default 'STOPPED',-- WAHA status: STARTING | SCAN_QR_CODE | WORKING | FAILED | STOPPED
  status_at       timestamptz not null default now(),
  paused          boolean not null default false, -- paused by admin or auto-pause
  pause_reason    text,
  -- warm-up inputs (entered by admin)
  age_months      int not null default 0,
  avg_chats_day   int not null default 0,
  is_business     boolean not null default false,
  saved_by_contacts boolean not null default false,
  past_ban        boolean not null default false,
  -- warm-up state
  daily_cap       int not null default 30,        -- today's cap (ramps up)
  max_cap         int not null default 1000,      -- ceiling set by admin
  cap_override    int,                            -- admin hard override (null = automatic)
  ramp_enabled    boolean not null default true,
  sent_today      int not null default 0,
  failed_today    int not null default 0,
  counter_date    date,                           -- IST date the counters belong to
  disconnects_today int not null default 0,
  created_at      timestamptz not null default now()
);

-- Groups + subgroups (one level of nesting via parent_id)
create table contact_groups (
  id         serial primary key,
  parent_id  int references contact_groups(id) on delete cascade,
  name       text not null,
  source     text not null default 'manual',     -- 'frappe' | 'manual'
  source_key text unique,                         -- e.g. 'program:5TH', 'sg:5TH A' for frappe groups
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index on contact_groups(parent_id);

-- Students synced from Frappe (read-only copy)
create table students (
  id             serial primary key,
  frappe_id      text not null unique,
  admission_no   text not null unique,
  student_name   text not null,
  program        text,
  section        text,
  group_id       int references contact_groups(id) on delete set null, -- subgroup
  father_name    text,
  mother_name    text,
  father_phone   text,   -- normalised 91XXXXXXXXXX or null
  mother_phone   text,
  student_phone  text,
  active         boolean not null default true,
  synced_at      timestamptz not null default now()
);
create index on students(group_id);
create index on students(father_phone);
create index on students(mother_phone);

-- Manually managed contacts (staff, imported broadcast lists, ...)
create table contacts (
  id         serial primary key,
  group_id   int not null references contact_groups(id) on delete cascade,
  name       text,
  phone      text not null,
  extra      jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (group_id, phone)
);
create index on contacts(phone);

create table opt_outs (
  phone      text primary key,
  reason     text not null default 'keyword',
  created_at timestamptz not null default now()
);

-- WhatsApp existence cache (avoid sending to numbers that are not on WhatsApp)
create table phone_checks (
  phone      text primary key,
  on_whatsapp boolean not null,
  chat_id    text,
  checked_at timestamptz not null default now()
);

create table media (
  id         serial primary key,
  filename   text not null,
  mimetype   text not null,
  size_bytes int not null,
  path       text not null,
  created_at timestamptz not null default now()
);

create table templates (
  id         serial primary key,
  name       text not null,
  body       text not null,
  media_id   int references media(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- WhatsApp groups visible to each number (refreshed on demand)
create table wa_groups (
  number_id    int not null references wa_numbers(id) on delete cascade,
  chat_id      text not null,
  subject      text,
  participants int,
  refreshed_at timestamptz not null default now(),
  primary key (number_id, chat_id)
);

create table campaigns (
  id              serial primary key,
  name            text not null,
  kind            text not null,                -- 'contacts' | 'wa_groups'
  status          text not null default 'draft',-- draft | running | paused | completed | cancelled
  body            text not null default '',
  media_id        int references media(id) on delete set null,
  audience        jsonb not null default '{}',  -- {groupIds:[], csv:{...}, waGroups:[{numberId,chatId}]}
  recipient_mode  text not null default 'primary', -- father | mother | both | primary | student
  per_child       boolean not null default false,  -- false = one message per parent (siblings merged)
  number_ids      int[] not null default '{}',
  delay_min_ms    int not null default 3000,
  delay_max_ms    int not null default 8000,
  burst_min       int not null default 25,
  burst_max       int not null default 40,
  burst_pause_min_ms int not null default 60000,
  burst_pause_max_ms int not null default 180000,
  typing          boolean not null default true,
  respect_quiet_hours boolean not null default true,
  total           int not null default 0,
  sent            int not null default 0,
  delivered       int not null default 0,
  read            int not null default 0,
  failed          int not null default 0,
  skipped         int not null default 0,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

-- CSV rows uploaded for a campaign (variables per student/contact)
create table campaign_rows (
  id          serial primary key,
  campaign_id int not null references campaigns(id) on delete cascade,
  row_no      int not null,
  key_value   text,           -- admission no / phone from the CSV
  data        jsonb not null,
  student_id  int references students(id) on delete set null,
  matched     boolean not null default false
);
create index on campaign_rows(campaign_id);

-- Outbox: one row per message to send (also the send log)
create table messages (
  id            bigserial primary key,
  campaign_id   int references campaigns(id) on delete cascade,
  number_id     int references wa_numbers(id) on delete set null, -- set when picked (or fixed for group sends)
  fixed_number  boolean not null default false,
  chat_id       text not null,
  phone         text,
  recipient     text,         -- display name, e.g. "Parent of Aarav & Diya"
  body          text not null,
  media_id      int references media(id) on delete set null,
  priority      int not null default 0,
  status        text not null default 'queued', -- queued | sending | sent | delivered | read | failed | skipped
  error         text,
  attempts      int not null default 0,
  not_before    timestamptz,
  waha_id       text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  ack_at        timestamptz
);
create index messages_queue_idx on messages(status, priority desc, id) where status = 'queued';
create index on messages(campaign_id, status);
create index on messages(waha_id);
create index on messages(phone);

create table events (
  id         bigserial primary key,
  level      text not null default 'info', -- info | warn | error
  kind       text not null,
  message    text not null,
  data       jsonb,
  created_at timestamptz not null default now()
);
create index on events(created_at desc);

create table sync_runs (
  id          serial primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  summary     jsonb
);
