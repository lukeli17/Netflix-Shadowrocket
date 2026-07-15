/* Netflix Official Dual Subtitles v1.1 for Shadowrocket.
 * Current selected official track on top, previously selected official track below.
 * Netflix cue line breaks are intentionally flattened before the two tracks are joined.
 */
const KEY = "nf_official_dual_state";
const SCHEMA = 1;
const CACHE_EPOCH = 1;
const MAX = 1048576;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const FETCH_TTL = 10000;
const FAILURE_TTL = 10 * 60 * 1000;
const LEGACY_KEYS = [
  "nf_official_dual_state_v1",
  "nf_official_dual_state_v2",
  "nf_official_dual_state_v3",
  "nf_official_dual_state_v4",
  "nf_official_dual_state_v5",
];

function emptyState() {
  return {
    schema: SCHEMA,
    epoch: CACHE_EPOCH,
    updatedAt: 0,
    lastSwitch: 0,
    lastFetch: 0,
    fetch: null,
    failures: {},
    current: null,
    previous: null,
  };
}

function clearLegacy() {
  for (const key of LEGACY_KEYS) {
    if ($persistentStore.read(key)) $persistentStore.write("", key);
  }
}

function prune(state, now = Date.now()) {
  if (!state || state.schema !== SCHEMA || state.epoch !== CACHE_EPOCH) return emptyState();
  if (state.updatedAt && now - Number(state.updatedAt) > CACHE_TTL) return emptyState();

  state.failures = state.failures && typeof state.failures === "object" ? state.failures : {};
  const failures = Object.entries(state.failures)
    .filter(([, value]) => value && now - Number(value.lastAt || 0) < FAILURE_TTL)
    .sort((a, b) => Number(b[1].lastAt || 0) - Number(a[1].lastAt || 0))
    .slice(0, 8);
  state.failures = Object.fromEntries(failures);
  if (state.fetch && now - Number(state.fetch.startedAt || 0) >= FETCH_TTL) state.fetch = null;
  return state;
}

function load() {
  clearLegacy();
  try {
    return prune(JSON.parse($persistentStore.read(KEY) || "null"));
  } catch (_) {
    return emptyState();
  }
}

function save(state) {
  return $persistentStore.write(JSON.stringify(prune(state)), KEY);
}

function hash(value) {
  let h = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function header(headers, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === wanted) return String(headers[key] || "");
  }
  return "";
}

function ms(value) {
  const a = value.replace(".", ",").split(/[:,]/).map(Number);
  return ((a[0] * 60 + a[1]) * 60 + a[2]) * 1000 + a[3];
}

function clean(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parse(value) {
  const out = [];
  const blocks = String(value || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => /-->/.test(line));
    if (index < 0 || lines.length <= index + 1) continue;
    const match = lines[index].match(/(\d\d:\d\d:\d\d[,.]\d{3})\s*-->\s*(\d\d:\d\d:\d\d[,.]\d{3})/);
    if (!match) continue;
    const text = clean(lines.slice(index + 1).join("\n"));
    if (text) out.push({ head: lines.slice(0, index + 1).join("\n"), s: ms(match[1]), e: ms(match[2]), t: text });
  }
  return out;
}

function addResource(track, resourceId) {
  if (!track || !resourceId) return;
  track.resources = Array.from(new Set([...(track.resources || []), resourceId])).slice(-4);
}

function make(body, resourceId) {
  const cues = parse(body);
  const track = {
    id: hash(cues.map((cue) => `${cue.s}|${cue.e}|${cue.t}`).join("\n")),
    body,
    cues: cues.length,
    last: cues[cues.length - 1]?.e || 0,
    resources: [],
  };
  addResource(track, resourceId);
  return track;
}

function partStats(part, full) {
  if (part.length < 5 || !full.length) return { hits: 0, score: 0 };
  let hits = 0;
  let j = 0;
  for (const cue of part) {
    while (j < full.length && full[j].e < cue.s - 1000) j++;
    for (let k = j; k < full.length && full[k].s < cue.e + 1000; k++) {
      if (Math.abs(full[k].s - cue.s) <= 500 && full[k].t === cue.t) {
        hits++;
        break;
      }
    }
  }
  return { hits, score: hits / part.length };
}

function identify(part, state, resourceId) {
  for (const slot of ["current", "previous"]) {
    if (state[slot]?.resources?.includes(resourceId)) return slot;
  }

  const matches = [];
  for (const slot of ["current", "previous"]) {
    if (!state[slot]?.body) continue;
    const stats = partStats(part, parse(state[slot].body));
    matches.push({ slot, ...stats });
  }
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];
  const second = matches[1];
  if (!best || best.hits < 5 || best.score < 0.8) return null;
  if (second && best.score - second.score < 0.1) return null;
  return best.slot;
}

function titleScore(a, b) {
  if (!a.length || !b.length) return 0;
  let hits = 0;
  let j = 0;
  for (const cue of a) {
    while (j < b.length && b[j].s < cue.s - 600) j++;
    for (let k = j; k < b.length && b[k].s <= cue.s + 600; k++) {
      if (Math.abs(b[k].s - cue.s) <= 400) {
        hits++;
        break;
      }
    }
  }
  return hits / a.length;
}

function sameTitle(a, b) {
  if (!a || !b) return true;
  const aa = parse(a.body);
  const bb = parse(b.body);
  if (aa.length < 10 || bb.length < 10) return false;
  const durationDelta = Math.abs(a.last - b.last) / Math.max(a.last, b.last, 1);
  return durationDelta <= 0.15 && Math.min(titleScore(aa, bb), titleScore(bb, aa)) >= 0.35;
}

function second(cue, other, start) {
  const text = [];
  for (let i = start; i < other.length; i++) {
    const candidate = other[i];
    if (candidate.s > cue.e + 300) break;
    const overlap = Math.min(cue.e, candidate.e) - Math.max(cue.s, candidate.s);
    if (overlap >= -150 && candidate.e >= cue.s - 300 && candidate.t !== cue.t && !text.includes(candidate.t)) {
      text.push(candidate.t);
    }
  }
  return text.join(" ");
}

function merge(body, otherBody) {
  const current = parse(body);
  const other = parse(otherBody);
  if (!current.length || !other.length) return body;
  let j = 0;
  const out = [];
  for (const cue of current) {
    while (j < other.length && other[j].e < cue.s - 500) j++;
    const extra = second(cue, other, j);
    out.push(`${cue.head}\n${cue.t}${extra ? `\n${extra}` : ""}`);
  }
  return `${out.join("\n\n")}\n`;
}

function cache(fullBody, state, resourceId) {
  const now = Date.now();
  const next = make(fullBody, resourceId);
  if (state.current?.id === next.id) {
    next.resources = Array.from(new Set([...(state.current.resources || []), ...next.resources])).slice(-4);
    state.current = next;
    state.updatedAt = now;
    return "same-current";
  }
  if (state.previous?.id === next.id) {
    next.resources = Array.from(new Set([...(state.previous.resources || []), ...next.resources])).slice(-4);
    const oldCurrent = state.current;
    state.current = next;
    state.previous = oldCurrent;
    state.lastSwitch = now;
    state.updatedAt = now;
    return "switched-cached";
  }
  if (state.current && !sameTitle(state.current, next)) {
    const fresh = emptyState();
    fresh.current = next;
    fresh.updatedAt = now;
    Object.assign(state, fresh);
    return "new-title";
  }
  state.previous = state.current || null;
  state.current = next;
  state.lastSwitch = now;
  state.updatedAt = now;
  return state.previous ? "new-track" : "first-track";
}

function failureDelay(count) {
  return [2000, 10000, 30000][Math.min(Math.max(count, 1), 3) - 1];
}

function markFailure(state, resourceId, now) {
  const previous = state.failures[resourceId] || {};
  const count = Math.min(Number(previous.count || 0) + 1, 3);
  state.failures[resourceId] = { count, lastAt: now, nextAt: now + failureDelay(count) };
}

function fullRequestHeaders() {
  const headers = { "Accept-Encoding": "identity" };
  for (const [key, value] of Object.entries($request.headers || {})) {
    if (/^(range|host|content-length|connection|accept-encoding)$/i.test(key)) continue;
    headers[key] = value;
  }
  return headers;
}

function render(body, part, state, resourceId) {
  const slot = identify(part, state, resourceId);
  if (!slot) return null;
  const other = slot === "current" ? state.previous : state.current;
  addResource(state[slot], resourceId);
  const now = Date.now();
  if (slot === "previous" && now - Number(state.lastSwitch || 0) > 2000) {
    const oldCurrent = state.current;
    state.current = state.previous;
    state.previous = oldCurrent;
    state.lastSwitch = now;
  }
  state.updatedAt = now;
  save(state);
  return other?.body ? merge(body, other.body) : body;
}

function done(body) {
  $done({ body });
}

function main() {
  const ua = header($request.headers, "User-Agent");
  const range = header($request.headers, "Range");
  const playback = header($request.headers, "X-Playback-Session-Id");
  if (!/^AppleCoreMedia\//.test(ua) || !/^bytes=\d+-\d+$/.test(range) || !playback) return $done({});

  const body = typeof $response.body === "string" ? $response.body : "";
  const part = parse(body);
  if (!part.length) return $done({});

  const resourceId = hash($request.url);
  let state = load();
  const rendered = render(body, part, state, resourceId);
  if (rendered !== null) return done(rendered);

  const now = Date.now();
  const failure = state.failures[resourceId];
  if (
    (state.fetch && now - Number(state.fetch.startedAt || 0) < FETCH_TTL) ||
    now - Number(state.lastFetch || 0) < 1000 ||
    (failure && now < Number(failure.nextAt || 0))
  ) {
    return done(body);
  }

  state.fetch = { resourceId, startedAt: now };
  state.lastFetch = now;
  save(state);
  $httpClient.get(
    { url: $request.url, headers: fullRequestHeaders(), timeout: 6 },
    (error, response, data) => {
      try {
        state = load();
        if (state.fetch?.resourceId === resourceId) state.fetch = null;
        const status = Number(response && (response.status || response.statusCode) || 0);
        const fullCues = typeof data === "string" && data.length <= MAX ? parse(data) : [];
        let action = "failed";
        if (!error && status === 200 && fullCues.length) {
          delete state.failures[resourceId];
          action = cache(data, state, resourceId);
        } else {
          markFailure(state, resourceId, Date.now());
        }
        save(state);
        console.log(`[NFOfficialDual] ${action} track=${resourceId} status=${status} bytes=${typeof data === "string" ? data.length : 0} cues=${fullCues.length}`);
        const output = render(body, part, state, resourceId);
        done(output === null ? body : output);
      } catch (error) {
        console.log(`[NFOfficialDual] callback-error ${String(error)}`);
        done(body);
      }
    },
  );
}

try {
  main();
} catch (error) {
  console.log(`[NFOfficialDual] error ${String(error)}`);
  $done({});
}
