const { getDb } = require('../db/database');

function logAudit({
  eventType,
  entityType,
  entityId,
  actorId = null,
  actorRole = 'system',
  actorEmail = '',
  summary,
  details = {},
  ipAddress = ''
}) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_logs (
        event_type, entity_type, entity_id, actor_id, actor_role, actor_email, summary, details_json, ip_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(eventType),
      String(entityType),
      String(entityId),
      actorId || null,
      String(actorRole || 'system'),
      String(actorEmail || ''),
      String(summary),
      JSON.stringify(details || {}),
      String(ipAddress || '')
    );
  } catch (err) {
    console.error('[AUDIT_LOG_ERROR]', err.message);
  }
}

function getAuditLogs({ limit = 100, eventType = null, entityType = null } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];
  if (eventType) {
    sql += ' AND event_type = ?';
    params.push(eventType);
  }
  if (entityType) {
    sql += ' AND entity_type = ?';
    params.push(entityType);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Number(limit) || 100);

  return db.prepare(sql).all(...params).map((row) => ({
    ...row,
    details: safeParseJson(row.details_json, {})
  }));
}

function safeParseJson(str, fallback) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return fallback;
  }
}

module.exports = {
  logAudit,
  getAuditLogs
};
