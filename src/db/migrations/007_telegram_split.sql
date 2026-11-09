-- 007_telegram_split: send long Telegram reports as several natural messages (one per section, with a
-- "typing…" indicator in between) instead of one long message. On by default. Additive only.
ALTER TABLE telegram_settings ADD COLUMN split_messages INTEGER NOT NULL DEFAULT 1;
