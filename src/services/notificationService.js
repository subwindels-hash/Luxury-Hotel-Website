const { getDb } = require('../db/database');

function renderTemplate(str, vars = {}) {
  return String(str).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    return vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : '';
  });
}

function sendNotification({
  templateCode,
  reservationId = null,
  userId = null,
  recipientEmail,
  recipientPhone = '',
  variables = {}
}) {
  const db = getDb();
  const tpl = db.prepare('SELECT * FROM notification_templates WHERE code = ? AND is_active = 1').get(templateCode);

  const subject = tpl
    ? renderTemplate(tpl.subject_template, variables)
    : `Maison Aurélia Notification — ${templateCode}`;
  const body = tpl
    ? renderTemplate(tpl.body_template, variables)
    : JSON.stringify(variables, null, 2);
  const channel = tpl ? tpl.channel : 'email';

  const result = db.prepare(`
    INSERT INTO notifications (
      reservation_id, user_id, recipient_email, recipient_phone,
      template_code, channel, subject, body, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent')
  `).run(
    reservationId,
    userId,
    recipientEmail,
    recipientPhone || '',
    templateCode,
    channel,
    subject,
    body
  );

  return {
    id: Number(result.lastInsertRowid),
    templateCode,
    recipientEmail,
    subject,
    body,
    channel,
    sentAt: new Date().toISOString()
  };
}

module.exports = {
  sendNotification,
  renderTemplate
};
