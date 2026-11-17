CREATE TABLE construction_lines_new (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    unit TEXT NOT NULL CHECK (unit IN ('pieces', 'meters', 'kilometers', 'square_meters', 'cubic_meters', 'kilograms', 'tonnes')),
    planned_amount REAL NOT NULL CHECK (planned_amount > 0),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

INSERT INTO construction_lines_new (id, project_id, name, unit, planned_amount, sort_order, created_at, updated_at)
SELECT id, project_id, name, unit, planned_amount, sort_order, created_at, updated_at
FROM construction_lines;

DROP TABLE construction_lines;
ALTER TABLE construction_lines_new RENAME TO construction_lines;

CREATE INDEX idx_construction_lines_project_order
    ON construction_lines (project_id, sort_order, created_at);
