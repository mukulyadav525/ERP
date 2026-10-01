// Configuration, validated once at boot. A missing or obviously-wrong value should
// stop the process here rather than surface as a confusing runtime failure later.
import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  return n;
}

const isProd = process.env.NODE_ENV === 'production';

// The session-token signing secret. Refusing to boot in production without an
// explicit secret is deliberate: a silently-generated one would invalidate every
// session on restart and differ between instances behind a load balancer.
const sessionSecret = process.env.SESSION_SECRET;
if (isProd && (!sessionSecret || sessionSecret.length < 32)) {
  throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
}

// In production the web app's address must be named: the localhost default would
// make the browser's every request fail its CORS check.
if (isProd && !process.env.CORS_ORIGINS) {
  throw new Error('CORS_ORIGINS must be set in production to the web app address(es), e.g. https://shop.example.com');
}

export const env = {
  isProd,
  databaseUrl: required('DATABASE_URL'),
  port: int('PORT', 4000),
  host: process.env.HOST ?? '0.0.0.0',
  sessionSecret: sessionSecret || 'dev-only-insecure-session-secret-change-me',
  sessionTtlMinutes: int('SESSION_TTL_MINUTES', 720),
  googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
  otpExpiryMinutes: int('OTP_EXPIRY_MINUTES', 5),
  resetExpiryMinutes: int('RESET_EXPIRY_MINUTES', 30),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // An IANA zone name. Validated because it is interpolated into the connection
  // options string: anything but a plain zone name is refused at boot.
  businessTimezone: (() => {
    const tz = process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata';
    if (!/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(tz)) {
      throw new Error(`BUSINESS_TIMEZONE must be an IANA zone name such as Asia/Kolkata, got "${tz}"`);
    }
    return tz;
  })(),
  whatsapp: {
    token: process.env.WHATSAPP_CLOUD_API_TOKEN ?? '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    get enabled() { return Boolean(process.env.WHATSAPP_CLOUD_API_TOKEN); },
  },
  // Returning the OTP/reset code in the API response makes the flow testable
  // without an SMS gateway. It is gated on an EXPLICIT opt-in as well as on
  // NODE_ENV, because "we forgot to set NODE_ENV" is a real deployment mistake and
  // its consequence here would be handing out live credentials over HTTP.
  exposeDevOtp: !isProd && process.env.EXPOSE_DEV_OTP === 'true',
};
