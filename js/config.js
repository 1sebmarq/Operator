// config.js — deployment settings for cloud upload.
//
// Paste the values from your Apps Script deployment here, then re-upload the app.
// NOTE: the token below ships in the public site, so it only deters casual abuse;
// it is not a true secret. The actual Drive access stays inside the Apps Script.
export const CLOUD = {
  // The Apps Script web-app /exec URL. Leave '' to disable cloud upload entirely
  // (the app still records and stores locally, with manual Share/Download).
  endpoint: 'https://script.google.com/macros/s/AKfycbz6lcwDTTbUdOTSiGXWrbkQsxboxxA6YA-YukazA0KsvT8TNZyrmmwXiw1x_YsqXd7F/exec',

  // Must match SHARED_TOKEN in cloud/Code.gs.
  token: '5V4HZ8VGQY0305MNMZ6Y',

  // Try uploading automatically when a session stops. If false, upload only via
  // the per-session Upload button.
  autoUpload: true,
};

export function cloudEnabled() {
  return typeof CLOUD.endpoint === 'string' && CLOUD.endpoint.startsWith('http');
}
