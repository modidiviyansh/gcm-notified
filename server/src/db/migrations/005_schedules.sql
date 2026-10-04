-- Scheduling: spread-out sending, repeating and date-based campaigns, birthdays, holidays

alter table campaigns
  add column schedule    jsonb,                                              -- null = send now (see campaigns/schedule.ts)
  add column parent_id   int references campaigns(id) on delete set null,   -- this campaign is one run of a scheduled one
  add column run_day     date,                                               -- the day a run belongs to
  add column next_run_at timestamptz,
  add column runs        int not null default 0,
  add column last_run_at timestamptz;
create index on campaigns(parent_id);
create index on campaigns(status, next_run_at);

alter table students add column dob date;

-- School holidays (from Frappe's Holiday List when readable; extra days can be added in Settings)
create table holidays (
  day    date primary key,
  name   text,
  source text not null default 'frappe'
);

-- Per-person daily cap looks up today's messages by phone
create index on messages(phone, sent_at);
