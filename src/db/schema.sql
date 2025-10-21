-- D1 schema for strings table
CREATE TABLE IF NOT EXISTS strings (
  id TEXT PRIMARY KEY,           
  value TEXT NOT NULL UNIQUE,   
  is_palindrome INTEGER NOT NULL, 
  unique_characters INTEGER NOT NULL,
  word_count INTEGER NOT NULL,
  character_frequency_map TEXT NOT NULL,
  created_at TEXT NOT NULL      
);
CREATE INDEX IF NOT EXISTS idx_strings_value ON strings(value);
CREATE INDEX IF NOT EXISTS idx_strings_created_at ON strings(created_at);