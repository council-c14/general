CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  submitted_at TEXT NOT NULL,
  answers TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS responses_form ON responses (form_id, submitted_at);
