/* Netflix Official Dual Subtitles v2.0 for Shadowrocket.
 * Keeps every selected-track Range cue identifier and timestamp unchanged.
 * Uses cached full tracks only to assign each secondary cue deterministically and once.
 */
const KEY = "nf_official_dual_state";
const SCHEMA = 1;
const CACHE_EPOCH = 2;
const MAX = 1048576;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const FETCH_TTL = 10000;
const FAILURE_TTL = 10 * 60 * 1000;
const EMPTY_TRACK_PLACEHOLDER = "\u200B";
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

function preserveMarkup(value) {
  return String(value || "")
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
    const rawText = preserveMarkup(lines.slice(index + 1).join("\n"));
    const text = clean(rawText);
    if (text) {
      const sourceIndex = out.length;
      out.push({
        id: sourceIndex,
        sourceIndex,
        head: lines.slice(0, index + 1).join("\n"),
        s: ms(match[1]),
        e: ms(match[2]),
        originalS: ms(match[1]),
        originalE: ms(match[2]),
        t: text,
        raw: rawText,
      });
    }
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

function matchTopCues(part, top) {
  const matches = [];
  let low = 0;
  for (const cue of part) {
    while (low < top.length && top[low].e < cue.s - 1000) low++;
    let best = null;
    for (let i = low; i < top.length && top[i].s <= cue.e + 1000; i++) {
      if (top[i].t !== cue.t) continue;
      const distance = Math.abs(top[i].s - cue.s) + Math.abs(top[i].e - cue.e);
      if (!best || distance < best.distance) best = { id: top[i].id, distance };
    }
    matches.push(best && best.distance <= 1000 ? top[best.id] : null);
  }
  return matches;
}

function overlapMs(a, b) {
  return Math.max(0, Math.min(a.e, b.e) - Math.max(a.s, b.s));
}

function assignmentScore(top, bottom, overlap) {
  const topDuration = Math.max(1, top.e - top.s);
  const bottomDuration = Math.max(1, bottom.e - bottom.s);
  const topCoverage = overlap / topDuration;
  const bottomCoverage = overlap / bottomDuration;
  const centerDistance = Math.abs((top.s + top.e) / 2 - (bottom.s + bottom.e) / 2);
  return bottomCoverage * 5 + topCoverage * 2 - centerDistance / 5000;
}

function splitDialogueTurns(text) {
  const value = clean(text);
  if (!/^\s*-/.test(value) || !/\s+-\s*\S/.test(value)) return [];
  const turns = [];
  const pattern = /(?:^|\s)(-\s*\S[\s\S]*?)(?=\s+-\s*\S|$)/g;
  let match;
  while ((match = pattern.exec(value))) {
    const turn = clean(match[1]);
    if (turn) turns.push(turn);
  }
  return turns.length >= 2 ? turns : [];
}

function splitNaturalClauses(text) {
  const value = clean(text);
  if (value.length < 24) return [];
  const marked = value
    .replace(/([,;:!?])\s+/g, "$1\u0000")
    .replace(/\.\s+(?=[A-Z"'])/g, ".\u0000")
    .replace(/\s+(?=(?:and|but|because|so|while|when|although)\b)/gi, "\u0000");
  const clauses = marked.split("\u0000").map(clean).filter(Boolean);
  if (clauses.length < 2) return [];
  if (clauses.some((clause) => clause.length < 5)) return [];
  return clauses;
}

function isShortRepeatable(cue) {
  const value = clean(cue.t);
  const words = value.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g) || [];
  const duration = cue.e - cue.s;
  return value.length <= 45 && duration <= 4000 && (!words.length || words.length <= 8);
}

function distributeFragments(byTop, secondary, candidates, fragments, mode) {
  const distributed = new Map();
  for (let index = 0; index < fragments.length; index++) {
    let owner;
    if (fragments.length >= candidates.length) {
      const ownerIndex = Math.min(candidates.length - 1, Math.floor(index * candidates.length / fragments.length));
      owner = candidates[ownerIndex].primary;
    } else {
      const duration = Math.max(1, secondary.e - secondary.s);
      const virtualTime = secondary.s + ((index + 0.5) / fragments.length) * duration;
      const containing = candidates.filter(({ primary }) => primary.s <= virtualTime && primary.e >= virtualTime);
      const pool = containing.length ? containing : candidates;
      owner = pool.reduce((best, candidate) => {
        const distance = Math.abs((candidate.primary.s + candidate.primary.e) / 2 - virtualTime);
        return !best || distance < best.distance ? { candidate, distance } : best;
      }, null).candidate.primary;
    }
    if (!distributed.has(owner.id)) distributed.set(owner.id, []);
    distributed.get(owner.id).push(fragments[index]);
  }
  if (distributed.size < 2) return false;
  for (const [topId, values] of distributed) {
    addAssignment(byTop, topId, secondary.id, values.join(" "), secondary.sourceIndex, mode);
  }
  return true;
}

function addAssignment(byTop, topId, bottomId, text, order, mode) {
  if (!byTop.has(topId)) byTop.set(topId, []);
  byTop.get(topId).push({ bottomId, text, order, mode });
}

function buildAssignments(top, bottom) {
  const byTop = new Map();
  let assigned = 0;
  let skipped = 0;
  let split = 0;
  let repeated = 0;
  let low = 0;

  for (const secondary of bottom) {
    while (low < top.length && top[low].e <= secondary.s) low++;
    const candidates = [];
    for (let index = low; index < top.length && top[index].s < secondary.e; index++) {
      const primary = top[index];
      const overlap = overlapMs(primary, secondary);
      if (!overlap) continue;
      const primaryDuration = Math.max(1, primary.e - primary.s);
      const secondaryDuration = Math.max(1, secondary.e - secondary.s);
      if (overlap < 120 || overlap / Math.min(primaryDuration, secondaryDuration) < 0.15) continue;
      candidates.push({ primary, overlap, score: assignmentScore(primary, secondary, overlap) });
    }
    if (!candidates.length) {
      skipped++;
      continue;
    }

    candidates.sort((a, b) => a.primary.s - b.primary.s || a.primary.id - b.primary.id);
    let handled = false;
    if (candidates.length >= 2) {
      const turns = splitDialogueTurns(secondary.t);
      const fragments = turns.length >= 2 ? turns : splitNaturalClauses(secondary.t);
      if (fragments.length >= 2 && distributeFragments(byTop, secondary, candidates, fragments, turns.length ? "dialogue" : "clause")) {
        handled = true;
        split++;
      }
    }

    if (!handled && isShortRepeatable(secondary) && candidates.length >= 2) {
      const repeatOwners = candidates
        .filter(({ primary, overlap }) => overlap >= 250 && (
          overlap / Math.max(1, primary.e - primary.s) >= 0.3 &&
          overlap / Math.max(1, secondary.e - secondary.s) >= 0.3
        ))
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .sort((a, b) => a.primary.id - b.primary.id);
      if (repeatOwners.length === 2 && Math.abs(repeatOwners[0].primary.id - repeatOwners[1].primary.id) === 1) {
        for (const owner of repeatOwners) {
          addAssignment(byTop, owner.primary.id, secondary.id, secondary.t, secondary.sourceIndex, "repeat-short");
        }
        handled = true;
        repeated++;
      }
    }

    if (!handled) {
      const owner = candidates.reduce((best, candidate) => !best || candidate.score > best.score ? candidate : best, null).primary;
      addAssignment(byTop, owner.id, secondary.id, secondary.t, secondary.sourceIndex, "single");
    }
    assigned++;
  }

  for (const values of byTop.values()) values.sort((a, b) => a.order - b.order);
  return { byTop, assigned, skipped, split, repeated };
}

function merge(body, currentBody, otherBody) {
  const part = parse(body);
  const top = parse(currentBody);
  const bottom = parse(otherBody);
  if (!part.length || !top.length || !bottom.length) return body;
  const matches = matchTopCues(part, top);
  if (!matches.some(Boolean)) return body;
  const assignments = buildAssignments(top, bottom);
  let mapped = 0;
  const output = `${part.map((cue, index) => {
    const matched = matches[index];
    const values = matched ? assignments.byTop.get(matched.id) || [] : [];
    if (values.length) mapped++;
    const lower = values.map((value) => value.text).join(" ");
    return `${cue.head}\n${cue.raw}\n${lower || EMPTY_TRACK_PLACEHOLDER}`;
  }).join("\n\n")}\n`;
  console.log(`[NFOfficialDual] skeleton-merge range=${part.length}->${part.length} mapped=${mapped} secondary=${assignments.assigned}/${bottom.length} split=${assignments.split} repeatShort=${assignments.repeated} skipped=${assignments.skipped} bytes=${String(body).length}->${output.length}`);
  return output;
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
  const selectedTrack = state[slot];
  const other = slot === "current" ? state.previous : state.current;
  addResource(selectedTrack, resourceId);
  const now = Date.now();
  if (slot === "previous" && now - Number(state.lastSwitch || 0) > 2000) {
    const oldCurrent = state.current;
    state.current = state.previous;
    state.previous = oldCurrent;
    state.lastSwitch = now;
  }
  state.updatedAt = now;
  save(state);
  return other?.body ? merge(body, selectedTrack.body, other.body) : body;
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
