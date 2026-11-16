CREATE TABLE construction_lines (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    unit TEXT NOT NULL CHECK (unit IN ('pieces', 'meters')),
    planned_amount REAL NOT NULL CHECK (planned_amount > 0),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE construction_progress_entries (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    happened_at TEXT NOT NULL,
    FOREIGN KEY (project_id, line_id)
        REFERENCES construction_lines (project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_construction_lines_project_order
    ON construction_lines (project_id, sort_order, created_at);
CREATE INDEX idx_construction_progress_line_time
    ON construction_progress_entries (project_id, line_id, happened_at DESC);
