export const taskDependencyMigrations = [{
  version: 30,
  sql: `
    CREATE TABLE task_dependencies (
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      prerequisite_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(work_item_id, prerequisite_id),
      CHECK(work_item_id <> prerequisite_id)
    );
    CREATE INDEX task_dependencies_prerequisite_idx ON task_dependencies(prerequisite_id);
    CREATE TABLE task_related (
      first_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      second_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(first_work_item_id, second_work_item_id),
      CHECK(first_work_item_id < second_work_item_id)
    );
    CREATE TABLE task_declared_scopes (
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('path', 'component')),
      value TEXT NOT NULL,
      PRIMARY KEY(work_item_id, kind, value)
    );
  `
}] as const
