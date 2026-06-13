-- Inventory categorization facets for filtering (packages).
-- Stored in meta JSON already, but promoted to columns for fast WHERE/GROUP.
ALTER TABLE inventory ADD COLUMN category TEXT;   -- system|library|user
ALTER TABLE inventory ADD COLUMN priority TEXT;   -- required|important|standard|optional
ALTER TABLE inventory ADD COLUMN section  TEXT;   -- libs|utils|admin|devel|...
CREATE INDEX IF NOT EXISTS idx_inventory_category ON inventory(kind, category);
