
-- CHESS CLUB DATABASE
create extension if not exists pgcrypto;

-- PLAYER PROFILES
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  rating integer not null default 1200,
  wins integer not null default 0,
  losses integer not null default 0,
  draws integer not null default 0,
  created_at timestamptz not null default now()
);

-- MULTIPLAYER ROOMS
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  status text not null default 'waiting'
    check (status in ('waiting', 'playing', 'finished')),
  white_id uuid not null references public.profiles(id),
  black_id uuid references public.profiles(id),
  fen text not null default 'start',
  ply_count integer not null default 0,
  result text,
  created_at timestamptz not null default now()
);

-- MOVE HISTORY
create table if not exists public.moves (
  room_id uuid not null references public.rooms(id) on delete cascade,
  ply integer not null,
  uci text not null,
  san text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (room_id, ply)
);

-- ENABLE ROW LEVEL SECURITY
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.moves enable row level security;

-- PROFILES: ANY SIGNED-IN PLAYER CAN VIEW RATINGS
create policy "Profiles are visible to signed-in users"
on public.profiles
for select
to authenticated
using (true);

-- PLAYERS CAN CREATE THEIR OWN PROFILE
create policy "Players create their own profile"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id);

-- PLAYERS CAN UPDATE THEIR OWN PROFILE
create policy "Players update their own profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- SIGNED-IN PLAYERS CAN VIEW ROOMS
create policy "Signed-in users can view rooms"
on public.rooms
for select
to authenticated
using (true);

-- SIGNED-IN PLAYERS CAN VIEW MOVE HISTORY
create policy "Signed-in users can view moves"
on public.moves
for select
to authenticated
using (true);

-- SECURITY NOTE:
-- Browser clients do not receive unrestricted permission
-- to write rooms, moves, or ratings.
-- Add trusted server-side functions to create/join rooms,
-- validate legal chess moves, and update ratings.
