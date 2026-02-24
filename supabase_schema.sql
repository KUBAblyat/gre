-- ============================================================
--  GEODUELER — SUPABASE DATABASE SCHEMA v2
--  Run this in Supabase → SQL Editor → New query
-- ============================================================

-- ── ROOMS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rooms (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT UNIQUE NOT NULL,
  host_id       TEXT NOT NULL,
  status        TEXT DEFAULT 'waiting',
  current_round INT DEFAULT 0,
  max_rounds    INT DEFAULT 5,
  time_limit    INT DEFAULT 90,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── PLAYERS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  room_id     UUID REFERENCES rooms(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  score       INT DEFAULT 0,
  is_host     BOOLEAN DEFAULT FALSE,
  ready       BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── ROUNDS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rounds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      UUID REFERENCES rooms(id) ON DELETE CASCADE,
  round_number INT NOT NULL,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── GUESSES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guesses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id    UUID REFERENCES rounds(id) ON DELETE CASCADE,
  player_id   TEXT REFERENCES players(id) ON DELETE CASCADE,
  guess_lat   DOUBLE PRECISION NOT NULL,
  guess_lng   DOUBLE PRECISION NOT NULL,
  distance    DOUBLE PRECISION,
  score       INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(round_id, player_id)
);

-- ── LEADERBOARD ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leaderboard (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_name TEXT NOT NULL,
  score       INT NOT NULL,
  rounds      INT DEFAULT 5,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── ROW LEVEL SECURITY ─────────────────────────────────────
ALTER TABLE rooms       ENABLE ROW LEVEL SECURITY;
ALTER TABLE players     ENABLE ROW LEVEL SECURITY;
ALTER TABLE rounds      ENABLE ROW LEVEL SECURITY;
ALTER TABLE guesses     ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaderboard ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any, then recreate
DO $$ BEGIN
  DROP POLICY IF EXISTS "allow_all_rooms"       ON rooms;
  DROP POLICY IF EXISTS "allow_all_players"     ON players;
  DROP POLICY IF EXISTS "allow_all_rounds"      ON rounds;
  DROP POLICY IF EXISTS "allow_all_guesses"     ON guesses;
  DROP POLICY IF EXISTS "allow_all_leaderboard" ON leaderboard;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE POLICY "allow_all_rooms"       ON rooms       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_players"     ON players     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_rounds"      ON rounds      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_guesses"     ON guesses     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_leaderboard" ON leaderboard FOR ALL USING (true) WITH CHECK (true);

-- ── REALTIME ───────────────────────────────────────────────
-- IMPORTANT: Go to Supabase Dashboard → Database → Replication
-- and enable Realtime for tables: rooms, players, guesses

-- Add ready column if upgrading from v1
ALTER TABLE players ADD COLUMN IF NOT EXISTS ready BOOLEAN DEFAULT FALSE;
