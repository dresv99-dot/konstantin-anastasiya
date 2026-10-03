CREATE TABLE IF NOT EXISTS rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  attendance TEXT NOT NULL CHECK (attendance IN ('yes', 'no')),
  companion_names TEXT NOT NULL DEFAULT '[]',
  companion_types TEXT NOT NULL DEFAULT '[]',
  diet TEXT NOT NULL DEFAULT '',
  alcohol TEXT NOT NULL DEFAULT '[]',
  alcohol_other TEXT NOT NULL DEFAULT '',
  wine TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
