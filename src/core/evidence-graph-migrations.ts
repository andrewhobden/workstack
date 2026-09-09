export const evidenceGraphMigrations = [{ version: 31, sql: `
  CREATE TABLE evidence_graph_scopes (scope_key TEXT PRIMARY KEY, revision_id TEXT NOT NULL);
  CREATE TABLE evidence_graph_revisions (
    scope_key TEXT NOT NULL REFERENCES evidence_graph_scopes(scope_key) ON DELETE CASCADE,
    revision_id TEXT NOT NULL, content_hash TEXT NOT NULL, truncated INTEGER NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(scope_key, revision_id)
  );
  CREATE TABLE evidence_graph_nodes (id TEXT PRIMARY KEY, type TEXT NOT NULL, reference TEXT NOT NULL, label TEXT NOT NULL);
  CREATE TABLE evidence_graph_members (
    scope_key TEXT NOT NULL REFERENCES evidence_graph_scopes(scope_key) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES evidence_graph_nodes(id) ON DELETE CASCADE, resolved INTEGER NOT NULL, label TEXT NOT NULL,
    PRIMARY KEY(scope_key, node_id)
  );
  CREATE INDEX evidence_graph_members_node_idx ON evidence_graph_members(node_id);
  CREATE TABLE evidence_graph_edges (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL REFERENCES evidence_graph_scopes(scope_key) ON DELETE CASCADE,
    from_id TEXT NOT NULL REFERENCES evidence_graph_nodes(id), to_id TEXT NOT NULL REFERENCES evidence_graph_nodes(id),
    type TEXT NOT NULL, basis TEXT NOT NULL CHECK(basis IN ('observed','declared','inferred')),
    provenance_json TEXT NOT NULL, revision_id TEXT NOT NULL
  );
  CREATE INDEX evidence_graph_edges_from_idx ON evidence_graph_edges(from_id, type);
  CREATE INDEX evidence_graph_edges_to_idx ON evidence_graph_edges(to_id, type);
  CREATE INDEX evidence_graph_edges_scope_idx ON evidence_graph_edges(scope_key);
` }] as const
