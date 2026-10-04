-- People with several labelled numbers; lists contain people. Message types pick which number(s) to use.

create table people (
  id         serial primary key,
  name       text,
  notes      text,
  rules      jsonb not null default '{}',   -- exceptions: {"<message type>": NumberRule, "*": NumberRule}
  created_at timestamptz not null default now()
);

create table person_phones (
  id         serial primary key,
  person_id  int not null references people(id) on delete cascade,
  phone      text not null unique,          -- a number belongs to exactly one person
  label      text not null default 'Mobile',
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create index on person_phones(person_id);
create unique index person_phones_one_primary on person_phones(person_id) where is_primary;

create table list_members (
  group_id   int not null references contact_groups(id) on delete cascade,
  person_id  int not null references people(id) on delete cascade,
  extra      jsonb not null default '{}',   -- list-specific CSV columns (route, department…)
  created_at timestamptz not null default now(),
  primary key (group_id, person_id)
);
create index on list_members(person_id);

alter table contact_groups add column rules jsonb not null default '{}';   -- {"<message type>": NumberRule}

-- Existing contacts → one person per number (labelled Mobile, primary), memberships keep their columns
alter table people add column _phone text;
insert into people(name, created_at, _phone)
  select distinct on (phone) name, created_at, phone from contacts order by phone, (name is null), created_at;
insert into person_phones(person_id, phone, label, is_primary, created_at)
  select id, _phone, 'Mobile', true, created_at from people;
insert into list_members(group_id, person_id, extra, created_at)
  select c.group_id, p.id, c.extra, c.created_at from contacts c join people p on p._phone = c.phone;
alter table people drop column _phone;
alter table contacts rename to contacts_legacy;

-- Campaigns: what the message is for, an optional number rule for this campaign only, SOS opt-out override
alter table campaigns
  add column message_type text,
  add column number_rule jsonb,
  add column override_opt_out boolean not null default false;

alter table messages
  add column phone_label text,
  add column ignore_opt_out boolean not null default false;
