/** App admin users (Torn player IDs) — shared by VIP admin callables and chain watch support. */
const ADMIN_USER_IDS = [2935825, 2093859];

const adminKeyValidationCache = new Map();
const ADMIN_KEY_CACHE_OK_MS = 24 * 60 * 60 * 1000;
const ADMIN_KEY_CACHE_FAIL_MS = 60 * 60 * 1000;

async function validateAdminApiKey(apiKey) {
  const key = String(apiKey || '')
    .trim()
    .replace(/[^A-Za-z0-9]/g, '');
  if (!key || key.length !== 16) return false;
  const now = Date.now();
  const hit = adminKeyValidationCache.get(key);
  if (hit && now < hit.exp) return hit.ok;

  try {
    const res = await fetch(
      `https://api.torn.com/user/?selections=profile,basic&key=${encodeURIComponent(key)}`
    );
    const data = await res.json();
    if (data.error) {
      adminKeyValidationCache.set(key, { ok: false, exp: now + ADMIN_KEY_CACHE_FAIL_MS });
      return false;
    }
    const pid =
      data.player_id != null
        ? Number(data.player_id)
        : data.id != null
          ? Number(data.id)
          : null;
    const ok = pid != null && ADMIN_USER_IDS.includes(pid);
    adminKeyValidationCache.set(key, {
      ok,
      exp: now + (ok ? ADMIN_KEY_CACHE_OK_MS : ADMIN_KEY_CACHE_FAIL_MS),
    });
    return ok;
  } catch (e) {
    return false;
  }
}

module.exports = { ADMIN_USER_IDS, validateAdminApiKey };
