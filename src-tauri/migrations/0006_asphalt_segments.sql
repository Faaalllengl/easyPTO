CREATE TABLE asphalt_segments (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    from_centi_pk INTEGER NOT NULL,
    to_centi_pk INTEGER NOT NULL,
    width_m REAL NOT NULL CHECK (width_m > 0),
    thickness_cm REAL NOT NULL CHECK (thickness_cm > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, id),
    CHECK (to_centi_pk > from_centi_pk),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE INDEX idx_asphalt_segments_project_route
    ON asphalt_segments (project_id, from_centi_pk, to_centi_pk);
