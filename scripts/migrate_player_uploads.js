/**
 * Migration Script — player_uploads table + storage bucket
 *
 * Run once:  node scripts/migrate_player_uploads.js
 *
 * Uses the service-role key so it can execute DDL via supabase.rpc('exec_sql')
 * or the REST SQL endpoint.  If your project doesn't expose `exec_sql`, you can
 * paste the SQL into the Supabase SQL Editor instead.
 */

import dotenv from "dotenv";
dotenv.config({ quiet: true });

import { supabaseAdmin } from "../config/supabaseClient.js";

const SQL = `
-- 1. Create table
CREATE TABLE IF NOT EXISTS player_uploads (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  player_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  file_url    TEXT NOT NULL,
  file_type   TEXT NOT NULL,             -- 'image' or 'video'
  mime_type   TEXT,
  file_size   INTEGER,                   -- bytes
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 2. Index
CREATE INDEX IF NOT EXISTS idx_player_uploads_player_id ON player_uploads(player_id);

-- 3. RLS
ALTER TABLE player_uploads ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Players can view own uploads' AND tablename = 'player_uploads') THEN
    CREATE POLICY "Players can view own uploads"
      ON player_uploads FOR SELECT USING (player_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Players can insert own uploads' AND tablename = 'player_uploads') THEN
    CREATE POLICY "Players can insert own uploads"
      ON player_uploads FOR INSERT WITH CHECK (player_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Players can delete own uploads' AND tablename = 'player_uploads') THEN
    CREATE POLICY "Players can delete own uploads"
      ON player_uploads FOR DELETE USING (player_id = auth.uid());
  END IF;
END $$;
`;

const STORAGE_POLICIES_SQL = `
-- Storage policies (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Players upload to own folder' AND tablename = 'objects' AND schemaname = 'storage') THEN
    CREATE POLICY "Players upload to own folder"
      ON storage.objects FOR INSERT
      WITH CHECK (
        bucket_id = 'player_uploads' AND
        (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Players delete own files' AND tablename = 'objects' AND schemaname = 'storage') THEN
    CREATE POLICY "Players delete own files"
      ON storage.objects FOR DELETE
      USING (
        bucket_id = 'player_uploads' AND
        (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public read player_uploads' AND tablename = 'objects' AND schemaname = 'storage') THEN
    CREATE POLICY "Public read player_uploads"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'player_uploads');
  END IF;
END $$;
`;

async function run() {
  console.log("▶ Running player_uploads migration …");

  // --- TABLE + RLS ---
  const { error: sqlErr } = await supabaseAdmin.rpc("exec_sql", { query: SQL });
  if (sqlErr) {
    console.warn("⚠  Could not run SQL via rpc('exec_sql'). You may need to run it in the Supabase SQL Editor.");
    console.warn("   Error:", sqlErr.message);
    console.log("\n--- Copy & paste this SQL into Supabase SQL Editor ---\n");
    console.log(SQL);
    console.log(STORAGE_POLICIES_SQL);
  } else {
    console.log("✅ Table + RLS policies created.");
  }

  // --- STORAGE BUCKET ---
  // Try creating bucket via the Storage API (idempotent-ish)
  const { error: bucketErr } = await supabaseAdmin.storage.createBucket("player_uploads", {
    public: true,
    fileSizeLimit: 52428800, // 50 MB
    allowedMimeTypes: [
      "image/jpeg", "image/png", "image/jpg", "image/webp",
      "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo",
    ],
  });

  if (bucketErr) {
    if (bucketErr.message?.includes("already exists")) {
      console.log("✅ Storage bucket 'player_uploads' already exists.");
    } else {
      console.warn("⚠  Bucket creation issue:", bucketErr.message);
    }
  } else {
    console.log("✅ Storage bucket 'player_uploads' created.");
  }

  // --- STORAGE POLICIES ---
  if (!sqlErr) {
    const { error: spErr } = await supabaseAdmin.rpc("exec_sql", { query: STORAGE_POLICIES_SQL });
    if (spErr) {
      console.warn("⚠  Storage policies via rpc failed:", spErr.message);
      console.log("   Paste the STORAGE_POLICIES_SQL block into the SQL Editor.");
    } else {
      console.log("✅ Storage policies created.");
    }
  }

  console.log("\n✅ Migration complete.");
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
