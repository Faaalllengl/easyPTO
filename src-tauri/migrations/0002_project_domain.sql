CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    route_start_centi_pk INTEGER NOT NULL,
    route_end_centi_pk INTEGER NOT NULL,
    bridge_enabled INTEGER NOT NULL DEFAULT 0 CHECK (bridge_enabled IN (0, 1)),
    bridge_area_id TEXT,
    active_calculation_version TEXT NOT NULL DEFAULT '1',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (route_end_centi_pk > route_start_centi_pk),
    CHECK (bridge_enabled = 0 OR bridge_area_id IS NOT NULL),
    FOREIGN KEY (id, bridge_area_id)
        REFERENCES work_areas (project_id, id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE work_areas (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('main', 'bridge', 'custom')),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    PRIMARY KEY (id),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE work_area_intervals (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    work_area_id TEXT NOT NULL,
    from_centi_pk INTEGER NOT NULL,
    to_centi_pk INTEGER NOT NULL,
    CHECK (to_centi_pk > from_centi_pk),
    FOREIGN KEY (project_id, work_area_id)
        REFERENCES work_areas (project_id, id) ON DELETE CASCADE
);

CREATE TABLE layers (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    sort_order INTEGER NOT NULL,
    color TEXT NOT NULL,
    base_layer_id TEXT,
    plan_percent REAL CHECK (plan_percent IS NULL OR (plan_percent >= 0 AND plan_percent <= 100)),
    plan_date TEXT,
    PRIMARY KEY (id),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, base_layer_id)
        REFERENCES layers (project_id, id) ON DELETE RESTRICT
);

CREATE TABLE layer_work_areas (
    project_id TEXT NOT NULL,
    layer_id TEXT NOT NULL,
    work_area_id TEXT NOT NULL,
    PRIMARY KEY (layer_id, work_area_id),
    UNIQUE (project_id, layer_id, work_area_id),
    FOREIGN KEY (project_id, layer_id)
        REFERENCES layers (project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, work_area_id)
        REFERENCES work_areas (project_id, id) ON DELETE CASCADE
);

CREATE TABLE segments (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    layer_id TEXT NOT NULL,
    work_area_id TEXT NOT NULL,
    from_centi_pk INTEGER NOT NULL,
    to_centi_pk INTEGER NOT NULL,
    work_date TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (to_centi_pk > from_centi_pk),
    FOREIGN KEY (project_id, layer_id)
        REFERENCES layers (project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, work_area_id)
        REFERENCES work_areas (project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, layer_id, work_area_id)
        REFERENCES layer_work_areas (project_id, layer_id, work_area_id) ON DELETE RESTRICT
);

CREATE TABLE exclusions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE exclusion_intervals (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    exclusion_id TEXT NOT NULL,
    from_centi_pk INTEGER NOT NULL,
    to_centi_pk INTEGER NOT NULL,
    CHECK (to_centi_pk > from_centi_pk),
    FOREIGN KEY (project_id, exclusion_id)
        REFERENCES exclusions (project_id, id) ON DELETE CASCADE
);

CREATE TABLE exclusion_layers (
    project_id TEXT NOT NULL,
    exclusion_id TEXT NOT NULL,
    layer_id TEXT NOT NULL,
    PRIMARY KEY (exclusion_id, layer_id),
    FOREIGN KEY (project_id, exclusion_id)
        REFERENCES exclusions (project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, layer_id)
        REFERENCES layers (project_id, id) ON DELETE CASCADE
);

CREATE TABLE exclusion_work_areas (
    project_id TEXT NOT NULL,
    exclusion_id TEXT NOT NULL,
    work_area_id TEXT NOT NULL,
    PRIMARY KEY (exclusion_id, work_area_id),
    FOREIGN KEY (project_id, exclusion_id)
        REFERENCES exclusions (project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, work_area_id)
        REFERENCES work_areas (project_id, id) ON DELETE CASCADE
);

CREATE TABLE journal_events (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    happened_at TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    summary TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE INDEX idx_layers_project_order ON layers (project_id, sort_order);
CREATE INDEX idx_segments_project_layer ON segments (project_id, layer_id, from_centi_pk);
CREATE INDEX idx_segments_work_area ON segments (project_id, work_area_id, from_centi_pk);
CREATE INDEX idx_journal_project_time ON journal_events (project_id, happened_at DESC);
