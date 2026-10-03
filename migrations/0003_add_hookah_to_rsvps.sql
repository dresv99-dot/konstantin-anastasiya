ALTER TABLE rsvps
ADD COLUMN hookah TEXT NOT NULL DEFAULT 'no' CHECK (hookah IN ('yes', 'no'));
