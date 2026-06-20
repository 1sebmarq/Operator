// config.example.js — TEMPLATE. Copy to config.js for LOCAL testing.
//
//   cp js/config.example.js js/config.js   (then fill in your values)
//
// config.js is gitignored, so your real endpoint/token are never committed. On
// GitHub, the deploy workflow generates config.js from repo Secrets at build
// time. If config.js is absent, the app runs fine with cloud upload disabled.
export const CLOUD = {
  // Apps Script web-app /exec URL (leave '' to disable cloud upload).
  endpoint: '',

  // Must match SHARED_TOKEN in cloud/Code.gs.
  token: 'change-me-to-a-long-random-string',

  // Upload automatically when a session stops (false = manual Upload button only).
  autoUpload: true,
};

export function cloudEnabled() {
  return typeof CLOUD.endpoint === 'string' && CLOUD.endpoint.startsWith('http');
}
