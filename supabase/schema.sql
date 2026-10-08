-- รันไฟล์นี้ครั้งเดียวใน Supabase: Dashboard -> SQL Editor -> New query -> วาง -> Run

-- ห้อง + ผู้สร้างห้อง (เก็บเฉพาะ hash ของรหัสผู้สร้าง ไม่เก็บรหัสจริง)
create table if not exists public.rooms (
  room_id          text primary key,
  host_token_hash  text not null,
  created_at       timestamptz not null default now()
);

-- ข้อมูลไฟล์บันทึก (ตัววิดีโอเก็บใน Storage bucket "recordings")
create table if not exists public.recordings (
  id                uuid primary key default gen_random_uuid(),
  room_id           text not null references public.rooms(room_id) on delete cascade,
  status            text not null default 'recording'
                    check (status in ('recording', 'ready', 'interrupted')),
  mime_type         text not null,
  parts             integer not null default 0,
  size_bytes        bigint not null default 0,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  duration_seconds  integer
);

create index if not exists recordings_room_started_idx
  on public.recordings (room_id, started_at desc);

-- เปิด RLS โดยไม่สร้าง policy = ไม่มีใครอ่าน/เขียนผ่าน API สาธารณะได้
-- มีแค่เซิร์ฟเวอร์ของเราที่ใช้ service_role key เท่านั้นที่เข้าถึงได้
alter table public.rooms enable row level security;
alter table public.recordings enable row level security;

-- Storage bucket แบบ private สำหรับเก็บไฟล์วิดีโอ
insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;
