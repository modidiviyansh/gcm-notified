// All runtime configuration comes from environment variables (set in Coolify).
// Secrets are never hard-coded or committed.

function req(name: string): string {
  const v = process.env[name];
  if (!v || v === 'CHANGE_ME') throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
function opt(name: string, fallback = ''): string {
  const v = process.env[name];
  return v && v !== 'CHANGE_ME' ? v : fallback;
}

export const config = {
  port: Number(opt('PORT', '3000')),
  publicUrl: opt('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
  dataDir: opt('DATA_DIR', '/data'),
  timezone: opt('APP_TIMEZONE', 'Asia/Kolkata'),

  databaseUrl: req('DATABASE_URL'),
  databaseSsl: opt('DATABASE_SSL', 'false') === 'true',

  adminUsername: req('ADMIN_USERNAME'),
  adminPassword: req('ADMIN_PASSWORD'),
  sessionSecret: req('SESSION_SECRET'),

  wahaUrl: req('WAHA_URL').replace(/\/$/, ''),
  wahaApiKey: req('WAHA_API_KEY'),
  webhookSecret: req('WEBHOOK_SECRET'),

  frappeUrl: opt('FRAPPE_URL').replace(/\/$/, ''),
  frappeApiKey: opt('FRAPPE_API_KEY'),
  frappeApiSecret: opt('FRAPPE_API_SECRET'),

  smtp: {
    host: opt('SMTP_HOST'),
    port: Number(opt('SMTP_PORT', '587')),
    user: opt('SMTP_USER'),
    pass: opt('SMTP_PASS'),
    from: opt('SMTP_FROM'),
  },

  // Set to "false" only for local development without a real WAHA (messages are logged, not sent)
  sendingEnabled: opt('SENDING_ENABLED', 'true') === 'true',
};

export const frappeConfigured = () => !!(config.frappeUrl && config.frappeApiKey && config.frappeApiSecret);
export const smtpConfigured = () => !!(config.smtp.host && config.smtp.user && config.smtp.pass);
