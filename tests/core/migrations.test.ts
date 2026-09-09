import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { migrate } from '../../src/core/migrations'

describe('project migration recovery', () => {
  it('resumes an interrupted upgrade and keeps deleted display IDs reserved despite malformed historical events', () => {
    const database = new Database(':memory:')
    try {
      const execute = database.exec.bind(database)
      const interruption = vi.spyOn(database, 'exec').mockImplementation((sql) => {
        if (sql.includes('ALTER TABLE work_items ADD COLUMN attention_reason')) {
          execute(sql)
          throw new Error('simulated interrupted schema upgrade')
        }
        return execute(sql)
      })
      expect(() => migrate(database)).toThrow('interrupted schema upgrade')
      interruption.mockRestore()
      expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 7 })
      expect((database.pragma('table_info(work_items)') as Array<{ name: string }>).some((column) => column.name === 'attention_reason')).toBe(false)
      const history = ['{"displayId":"OLD-52"}', '{"displayId":"OLD-91"}', '{"displayId":"OLD-0"}', '{"displayId":"OLD-9007199254740992"}', '{"displayId":"malformed"}', '{"displayId":42}', 'null', 'invalid json']
      history.forEach((payload, index) => database.prepare("INSERT INTO activity_events(id,event_type,actor_type,payload_json,created_at) VALUES (?,'work_item_deleted','human',?,'2026-09-09T00:00:00Z')").run(String(index), payload))
      migrate(database)
      expect(database.prepare('SELECT high_watermark FROM work_item_sequences').get()).toEqual({ high_watermark: 91 })
      database.prepare("INSERT INTO activity_events(id,event_type,actor_type,payload_json,created_at) VALUES ('new','work_item_deleted','human','{\"displayId\":\"OLD-999\"}','2026-09-09T00:00:00Z')").run()
      migrate(database)
      expect(database.prepare('SELECT high_watermark FROM work_item_sequences').get()).toEqual({ high_watermark: 91 })
      expect(database.prepare('SELECT COUNT(*) AS count FROM activity_events').get()).toEqual({ count: 9 })
    } finally { database.close() }
  })
})
