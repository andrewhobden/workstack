const corpusTables = ['source_catalog', 'source_passages', 'knowledge_sources', 'work_items', 'completion_records', 'knowledge_records', 'knowledge_record_reviews', 'project_entities', 'wiki_publication']
export const knowledgeRetrievalMigrations = [{ version: 40, sql: `
  CREATE TABLE retrieval_corpus_state (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
  INSERT INTO retrieval_corpus_state VALUES (1, 0);
  CREATE VIRTUAL TABLE project_entity_search USING fts5(entity_id UNINDEXED, display_name, aliases, definition, tokenize = "unicode61 remove_diacritics 2 tokenchars '_'");
  INSERT INTO project_entity_search SELECT id,display_name,aliases_json,definition FROM project_entities;
  CREATE TRIGGER retrieval_entity_insert AFTER INSERT ON project_entities BEGIN INSERT INTO project_entity_search VALUES (new.id,new.display_name,new.aliases_json,new.definition); END;
  CREATE TRIGGER retrieval_entity_update AFTER UPDATE ON project_entities BEGIN DELETE FROM project_entity_search WHERE entity_id = old.id; INSERT INTO project_entity_search VALUES (new.id,new.display_name,new.aliases_json,new.definition); END;
  CREATE TRIGGER retrieval_entity_delete AFTER DELETE ON project_entities BEGIN DELETE FROM project_entity_search WHERE entity_id = old.id; END;
  CREATE INDEX retrieval_repository_path_idx ON source_catalog(repository_path);
  CREATE TABLE semantic_model_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 0, path TEXT, model_id TEXT, model_version TEXT,
    model_hash TEXT, dimensions INTEGER, vocabulary_size INTEGER, configured_at TEXT
  );
  INSERT INTO semantic_model_settings(id) VALUES (1);
  CREATE TABLE semantic_passage_vectors (
    passage_id TEXT NOT NULL REFERENCES source_passages(id) ON DELETE CASCADE, source_id TEXT NOT NULL REFERENCES source_catalog(id),
    revision_id TEXT NOT NULL REFERENCES source_revisions(id), passage_hash TEXT NOT NULL, input_hash TEXT NOT NULL,
    model_id TEXT NOT NULL, model_version TEXT NOT NULL, model_hash TEXT NOT NULL, dimensions INTEGER NOT NULL,
    vector_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(passage_id, model_hash)
  );
  CREATE TABLE retrieval_index_state (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
  INSERT INTO retrieval_index_state VALUES (1, 0);
  ${['INSERT', 'UPDATE', 'DELETE'].map((action) => `CREATE TRIGGER retrieval_vector_${action.toLowerCase()} AFTER ${action} ON semantic_passage_vectors BEGIN UPDATE retrieval_index_state SET version = version + 1 WHERE id = 1; END;`).join('\n')}
  CREATE INDEX semantic_vectors_model_idx ON semantic_passage_vectors(model_hash, source_id, revision_id);
  ${corpusTables.flatMap((table) => ['INSERT', 'UPDATE', 'DELETE'].map((action) => `CREATE TRIGGER retrieval_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN UPDATE retrieval_corpus_state SET version = version + 1 WHERE id = 1; END;`)).join('\n')}
` }] as const
