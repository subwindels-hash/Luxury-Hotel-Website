const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = createApp();

app.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'SERVER_STARTED',
      message: `Maison Aurélia Luxury Hotel & Reservation Engine listening on http://${HOST}:${PORT}`,
      port: PORT,
      timestamp: new Date().toISOString()
    })
  );
});
