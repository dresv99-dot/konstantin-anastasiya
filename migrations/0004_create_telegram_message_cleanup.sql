CREATE TABLE IF NOT EXISTS telegram_message_cleanup (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  delete_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_message_cleanup_delete_at
ON telegram_message_cleanup (delete_at);
