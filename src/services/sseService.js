const clients = new Set();
const recentEvents = [];
const MAX_RECENT_EVENTS = 25;

function registerSseClient(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send initial handshake + recent events
  res.write(
    `data: ${JSON.stringify({
      type: 'CONNECTED',
      message: 'Live Front-Desk SSE Stream Connected',
      timestamp: new Date().toISOString(),
      recentEvents
    })}\n\n`
  );

  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    } catch (_) {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 20000);
  if (heartbeat.unref) heartbeat.unref();

  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

function broadcastFrontDeskEvent(event) {
  const payload = {
    id: `EVT-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    type: event.type || 'FRONT_DESK_EVENT',
    title: event.title || event.type,
    message: event.message || '',
    bookingReference: event.bookingReference || null,
    roomNumber: event.roomNumber || null,
    timestamp: new Date().toISOString()
  };

  recentEvents.unshift(payload);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.length = MAX_RECENT_EVENTS;
  }

  const serialized = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.write(serialized);
    } catch (_) {
      clients.delete(client);
    }
  }

  return payload;
}

function getRecentFrontDeskEvents() {
  return [...recentEvents];
}

module.exports = {
  registerSseClient,
  broadcastFrontDeskEvent,
  getRecentFrontDeskEvents
};
