import { canonicalId, canonicalUrl } from '../lib/ids.js';

const API = 'https://api.w2g.tv';

const getSettings = async () => (await chrome.storage.local.get(['apiKey', 'streamkey']));

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fallback when the page gave us no title (YouTube's markup varies by renderer).
async function oembedTitle(id) {
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonicalUrl(id))}`);
    return res.ok ? (await res.json()).title : '';
  } catch {
    return '';
  }
}

// The last failed add is kept so the popup can show why (the button's message is gone after a few seconds)
const fail = async (message) => {
  await chrome.storage.local.set({ lastError: { message, at: Date.now() } });
  return { status: 'error', message };
};

async function addVideo({ url, title }) {
  const { apiKey, streamkey } = await getSettings();
  if (!apiKey || !streamkey) {
    return fail('Set API key and room in the extension popup.');
  }
  const id = canonicalId(url);
  if (!id) return fail('Could not identify the video.');

  title = title?.trim() || (await oembedTitle(id));
  console.log('[Everything for YouTube] adding', id, 'with title:', title || '(none)');
  try {
    const res = await fetchWithTimeout(`${API}/rooms/${encodeURIComponent(streamkey)}/playlists/current/playlist_items/sync_update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        w2g_api_key: apiKey,
        // `thumb` isn't in the official docs; a forum example uses it, so it's sent best-effort.
        add_items: [{ url: canonicalUrl(id), ...(title && { title }), thumb: `https://i.ytimg.com/vi/${id.slice(3)}/hqdefault.jpg` }],
      }),
    });
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? 'Check API key and room membership.'
        : res.status === 404 ? 'Room not found (is this the streamkey?).' : '';
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 150);
      console.warn('[Everything for YouTube] add failed:', res.status, body);
      return fail(`W2G returned ${res.status}. ${hint} ${body}`.trim());
    }
  } catch (err) {
    console.warn('[Everything for YouTube] add failed:', err.name);
    return fail(`Network error reaching W2G (${err.name}). Is access to w2g.tv granted? Turn the W2G switch off and on again.`);
  }
  await chrome.storage.local.remove('lastError');
  return { status: 'added' };
}

async function testConnection() {
  const { apiKey, streamkey } = await getSettings();
  if (!apiKey || !streamkey) return { ok: false, message: 'Save an API key and room first.' };
  try {
    const res = await fetchWithTimeout(`https://w2g.tv/rooms/${encodeURIComponent(streamkey)}`);
    if (!res.ok) return { ok: false, message: `Room page returned ${res.status}. Check the streamkey.` };
  } catch {
    return { ok: false, message: 'Could not reach w2g.tv.' };
  }
  return { ok: true, message: 'Room page reachable. The API key can only be verified by adding a video.' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const job = msg.type === 'add' ? addVideo(msg)
    : msg.type === 'test' ? testConnection()
    : null;
  if (!job) return false;
  job.then(sendResponse, () => sendResponse({ status: 'error', ok: false, message: 'Unexpected error.' }));
  return true; // async response
});

// If access to w2g.tv is taken away (for example from chrome://extensions) no W2G feature can work, so switch them all
// off rather than leaving them on and failing.
async function switchW2gOff() {
  const key = 'settings';
  const current = (await chrome.storage.sync.get(key))[key] || {};
  const { w2g, ...rest } = current; // eslint-disable-line no-unused-vars
  await chrome.storage.sync.set({ [key]: { ...rest, w2gThumbs: false, w2gWatchPage: false, w2gRoomTab: 'off', w2gNoAutoplayAlone: false } });
}
const isW2g = (perms) => perms.origins?.some((o) => o.includes('api.w2g.tv'));
chrome.permissions.onRemoved.addListener((perms) => { if (isW2g(perms)) switchW2gOff(); });

// The w2g.tv scripts are not in the manifest: a w2g.tv content script there would be an install-time permission and
// would disable the extension for existing users until they re-accept. Instead they are registered here, only while the
// matching access is granted and a feature that needs them is on.
//   room.js    on the room page: default sidebar tab, and tells the player whether anyone else is online
//   player.js  inside the player frame (player.w2g.tv, a separate site): pauses on join when alone
const SCRIPTS = [
  {
    id: 'efy-w2g-room',
    matches: ['https://w2g.tv/room/*', 'https://w2g.tv/*/room/*'],
    js: ['lib/settings.js', 'content/w2g/room.js'],
    host: 'https://w2g.tv/*',
    wanted: (s) => s.w2gRoomTab !== 'off' || s.w2gNoAutoplayAlone,
  },
  {
    id: 'efy-w2g-player',
    matches: ['https://player.w2g.tv/*'],
    js: ['lib/settings.js', 'content/w2g/player.js'],
    allFrames: true,
    host: 'https://player.w2g.tv/*',
    wanted: (s) => s.w2gNoAutoplayAlone,
  },
];
async function syncRoomScript() {
  // Defaults as in lib/settings.js (the service worker does not load it)
  const s = { w2gRoomTab: 'off', w2gNoAutoplayAlone: true, ...(await chrome.storage.sync.get('settings')).settings };
  const registered = new Set((await chrome.scripting.getRegisteredContentScripts()).map((r) => r.id));
  for (const { id, matches, js, allFrames = false, host, wanted } of SCRIPTS) {
    const want = !!wanted(s) && await chrome.permissions.contains({ origins: [host] });
    if (want && !registered.has(id)) {
      await chrome.scripting.registerContentScripts([{ id, matches, js, allFrames, runAt: 'document_idle', persistAcrossSessions: true }]);
    } else if (!want && registered.has(id)) {
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
    }
  }
}
const safeSync = () => syncRoomScript().catch((err) => console.warn('Room script sync failed:', err.message));
chrome.runtime.onInstalled.addListener(safeSync);
chrome.runtime.onStartup.addListener(safeSync);
chrome.permissions.onAdded.addListener(safeSync);
chrome.permissions.onRemoved.addListener(safeSync);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'sync' && changes.settings) safeSync(); });

// "What's new": after an update, remember the version the user came from (the oldest one if several updates arrive before
// the popup is opened) and mark the toolbar icon. The popup shows the changes since then; "Got it" clears both.
// Reloading an unpacked copy also reports 'update', but with the same version, so it is ignored.
function showWhatsNewBadge() {
  chrome.action.setBadgeText({ text: 'NEW' });
  chrome.action.setBadgeBackgroundColor({ color: '#3d6fd8' });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
}
chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  if (reason !== 'update' || !previousVersion || previousVersion === chrome.runtime.getManifest().version) return;
  const { whatsNewFrom } = await chrome.storage.local.get('whatsNewFrom');
  await chrome.storage.local.set({ whatsNewFrom: whatsNewFrom || previousVersion });
  showWhatsNewBadge();
});
// Badge text does not survive a browser restart
chrome.runtime.onStartup.addListener(async () => {
  if ((await chrome.storage.local.get('whatsNewFrom')).whatsNewFrom) showWhatsNewBadge();
});
