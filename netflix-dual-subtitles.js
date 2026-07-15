/* Netflix Official Dual Subtitles v1.11 timestamp diagnostic for Shadowrocket.
 * Runs on the first subtitle response without cache, track matching, or a full-file fetch.
 * Keeps cue count, identifiers, and order unchanged while moving one existing cue earlier.
 */
const KEY = "nf_official_dual_state";
const SCHEMA = 1;
const CACHE_EPOCH = 1;
const MAX = 1048576;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const FETCH_TTL = 10000;
const FAILURE_TTL = 10 * 60 * 1000;
const HARD_SNAP_TOLERANCE_MS = 40;
const MIN_PROTECTED_CUE_MS = 240;
const ARTIFICIAL_FRAGMENT_MS = 1000;
const STANDALONE_MAX_CROSS_TRACK_OVERLAP_RATIO = 0.18;
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

function snapBoundaries(top, bottom, side) {
  const topEvents = top.map((cue) => ({ cue, time: cue[side] })).sort((a, b) => a.time - b.time);
  const bottomEvents = bottom.map((cue) => ({ cue, time: cue[side] })).sort((a, b) => a.time - b.time);
  const candidates = [];
  let low = 0;
  for (let i = 0; i < topEvents.length; i++) {
    const time = topEvents[i].time;
    while (low < bottomEvents.length && bottomEvents[low].time < time - HARD_SNAP_TOLERANCE_MS) low++;
    for (let j = low; j < bottomEvents.length && bottomEvents[j].time <= time + HARD_SNAP_TOLERANCE_MS; j++) {
      candidates.push({ i, j, distance: Math.abs(time - bottomEvents[j].time) });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.i - b.i || a.j - b.j);
  const usedTop = new Set();
  const usedBottom = new Set();
  for (const candidate of candidates) {
    if (usedTop.has(candidate.i) || usedBottom.has(candidate.j)) continue;
    const topEvent = topEvents[candidate.i];
    const bottomEvent = bottomEvents[candidate.j];
    const canonical = Math.round((topEvent.time + bottomEvent.time) / 2);
    topEvent.cue[side] = canonical;
    bottomEvent.cue[side] = canonical;
    usedTop.add(candidate.i);
    usedBottom.add(candidate.j);
  }
}

function normalizeBoundaries(top, bottom) {
  snapBoundaries(top, bottom, "s");
  snapBoundaries(top, bottom, "e");
  for (const cue of [...top, ...bottom]) {
    const protectedDuration = Math.min(MIN_PROTECTED_CUE_MS, (cue.originalE - cue.originalS) / 2);
    if (cue.e <= cue.s || cue.e - cue.s < protectedDuration) {
      cue.s = cue.originalS;
      cue.e = cue.originalE;
    }
  }
}

function activeText(active, keepMarkup) {
  const cues = [...active.values()].sort((a, b) => a.sourceIndex - b.sourceIndex);
  const seen = new Set();
  const text = [];
  for (const cue of cues) {
    const value = keepMarkup ? cue.raw : cue.t;
    if (!seen.has(value)) {
      seen.add(value);
      text.push(value);
    }
  }
  return text.join(" ");
}

function buildUnionTimeline(top, bottom) {
  const events = new Map();
  function add(time, action, track, cue) {
    if (!events.has(time)) events.set(time, []);
    events.get(time).push({ action, track, cue });
  }
  for (const cue of top) {
    add(cue.s, "start", "top", cue);
    add(cue.e, "end", "top", cue);
  }
  for (const cue of bottom) {
    add(cue.s, "start", "bottom", cue);
    add(cue.e, "end", "bottom", cue);
  }

  const times = [...events.keys()].sort((a, b) => a - b);
  const activeTop = new Map();
  const activeBottom = new Map();
  const segments = [];
  for (let i = 0; i < times.length - 1; i++) {
    const time = times[i];
    const atTime = events.get(time);
    for (const event of atTime.filter((item) => item.action === "end")) {
      (event.track === "top" ? activeTop : activeBottom).delete(event.cue.id);
    }
    for (const event of atTime.filter((item) => item.action === "start")) {
      (event.track === "top" ? activeTop : activeBottom).set(event.cue.id, event.cue);
    }
    const end = times[i + 1];
    if (end <= time || (!activeTop.size && !activeBottom.size)) continue;
    const topText = activeText(activeTop, true);
    const bottomText = activeText(activeBottom, false);
    const topIds = new Set(activeTop.keys());
    const bottomIds = new Set(activeBottom.keys());
    const previous = segments[segments.length - 1];
    if (previous && previous.e === time && previous.top === topText && previous.bottom === bottomText) {
      previous.e = end;
      for (const id of topIds) previous.topIds.add(id);
      for (const id of bottomIds) previous.bottomIds.add(id);
    } else {
      segments.push({ s: time, e: end, top: topText, bottom: bottomText, topIds, bottomIds });
    }
  }
  return segments;
}

function stateIsSubset(candidate, container) {
  if (!candidate || !container) return false;
  return [...candidate.topIds].every((id) => container.topIds.has(id)) &&
    [...candidate.bottomIds].every((id) => container.bottomIds.has(id));
}

function simplifyArtificialFragments(segments) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < segments.length; i++) {
      const current = segments[i];
      if (current.e - current.s > ARTIFICIAL_FRAGMENT_MS) continue;
      const previous = segments[i - 1];
      const next = segments[i + 1];
      const neighborTopIds = new Set([...(previous?.topIds || []), ...(next?.topIds || [])]);
      const neighborBottomIds = new Set([...(previous?.bottomIds || []), ...(next?.bottomIds || [])]);
      const unique = [...current.topIds].some((id) => !neighborTopIds.has(id)) ||
        [...current.bottomIds].some((id) => !neighborBottomIds.has(id));
      if (unique) continue;
      if (previous && next && previous.e === current.s && current.e === next.s) {
        const boundary = Math.round((current.s + current.e) / 2);
        previous.e = boundary;
        next.s = boundary;
      } else if (previous && previous.e === current.s && stateIsSubset(current, previous)) {
        previous.e = Math.round((current.s + current.e) / 2);
      } else if (next && current.e === next.s && stateIsSubset(current, next)) {
        next.s = Math.round((current.s + current.e) / 2);
      } else if (!previous && next && current.e === next.s) {
        next.s = current.s;
      } else if (previous && !next && previous.e === current.s) {
        previous.e = current.e;
      } else {
        continue;
      }
      segments.splice(i, 1);
      changed = true;
      break;
    }
  }
  return segments;
}

function standaloneCueIds(cues, opposite) {
  const ids = new Set();
  let low = 0;
  for (const cue of cues) {
    while (low < opposite.length && opposite[low].e <= cue.s) low++;
    let overlap = 0;
    for (let i = low; i < opposite.length && opposite[i].s < cue.e; i++) {
      overlap += Math.max(0, Math.min(cue.e, opposite[i].e) - Math.max(cue.s, opposite[i].s));
    }
    if (Math.min(1, overlap / Math.max(1, cue.e - cue.s)) < STANDALONE_MAX_CROSS_TRACK_OVERLAP_RATIO) ids.add(cue.id);
  }
  return ids;
}

function segmentLines(segment, standaloneTop, standaloneBottom) {
  if (segment.top && segment.bottom) return [segment.top, segment.bottom];
  if (segment.top) {
    const standalone = segment.topIds.size && [...segment.topIds].every((id) => standaloneTop.has(id));
    return standalone ? [segment.top] : [segment.top, EMPTY_TRACK_PLACEHOLDER];
  }
  const standalone = segment.bottomIds.size && [...segment.bottomIds].every((id) => standaloneBottom.has(id));
  return standalone ? [segment.bottom] : [EMPTY_TRACK_PLACEHOLDER, segment.bottom];
}

function formatTime(value) {
  let remaining = Math.max(0, Math.round(value));
  const hours = Math.floor(remaining / 3600000);
  remaining %= 3600000;
  const minutes = Math.floor(remaining / 60000);
  remaining %= 60000;
  const seconds = Math.floor(remaining / 1000);
  const millis = remaining % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function firstCueNumber(part) {
  for (const line of String(part[0]?.head || "").split("\n")) {
    if (/^\d+$/.test(line.trim())) return Number(line.trim());
  }
  return 1;
}

function markOriginalCue(body, target, label) {
  const text = String(body || "");
  const crlfHead = target.head.replace(/\n/g, "\r\n");
  const matchedHead = text.includes(target.head) ? target.head : crlfHead;
  const headAt = text.indexOf(matchedHead);
  if (headAt < 0) return null;
  const searchAt = headAt + matchedHead.length;
  const lfBoundary = text.indexOf("\n\n", searchAt);
  const crlfBoundary = text.indexOf("\r\n\r\n", searchAt);
  let blockEnd = text.length;
  let separator = text.includes("\r\n") ? "\r\n\r\n" : "\n\n";
  if (lfBoundary >= 0 && (crlfBoundary < 0 || lfBoundary < crlfBoundary)) {
    blockEnd = lfBoundary;
    separator = "\n\n";
  } else if (crlfBoundary >= 0) {
    blockEnd = crlfBoundary;
    separator = "\r\n\r\n";
  }
  const newline = separator.startsWith("\r\n") ? "\r\n" : "\n";
  const tailAt = blockEnd < text.length ? blockEnd + separator.length : blockEnd;
  const tail = text.slice(tailAt);
  const suffix = tail ? `${separator}${tail}` : newline;
  return `${text.slice(0, blockEnd)}${newline}${String(label).replace(/\n/g, newline)}${suffix}`;
}

function findProbeGaps(part, limit = 6) {
  const gaps = [];
  for (let index = 0; index < part.length - 1; index++) {
    const start = part[index].e + 50;
    const availableEnd = part[index + 1].s - 50;
    if (availableEnd - start < 350) continue;
    gaps.push({ s: start, e: Math.min(availableEnd, start + 1000), after: index, number: gaps.length + 1 });
    if (gaps.length >= limit) break;
  }
  return gaps;
}

function chooseTimestampProbe(part) {
  let fallback = null;
  for (let index = 1; index < part.length; index++) {
    const available = part[index].s - part[index - 1].e - 100;
    if (available >= 1500) return { index, shift: 1500, original: part[index], previous: part[index - 1] };
    if (available >= 500 && (!fallback || available > fallback.shift)) {
      fallback = { index, shift: available, original: part[index], previous: part[index - 1] };
    }
  }
  return fallback;
}

function retimeOriginalCue(body, target, start, end) {
  const text = String(body || "");
  const crlfHead = target.head.replace(/\n/g, "\r\n");
  const matchedHead = text.includes(target.head) ? target.head : crlfHead;
  const headAt = text.indexOf(matchedHead);
  if (headAt < 0) return null;
  const movedHead = matchedHead.replace(
    /(\d\d:\d\d:\d\d[,.]\d{3})(\s*-->\s*)(\d\d:\d\d:\d\d[,.]\d{3})/,
    (_, _start, arrow) => `${formatTime(start)}${arrow}${formatTime(end)}`,
  );
  return `${text.slice(0, headAt)}${movedHead}${text.slice(headAt + matchedHead.length)}`;
}

function insertCueInTimeOrder(body, cue, start) {
  const text = String(body || "");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const separator = `${newline}${newline}`;
  const timestamps = /(\d\d:\d\d:\d\d[,.]\d{3})\s*-->/g;
  let match;
  while ((match = timestamps.exec(text))) {
    if (ms(match[1]) <= start) continue;
    const boundary = text.lastIndexOf(separator, match.index);
    if (boundary >= 0) {
      const insertAt = boundary + separator.length;
      return `${text.slice(0, insertAt)}${cue}${separator}${text.slice(insertAt)}`;
    }
    break;
  }
  return `${text.replace(/\s+$/, "")}${separator}${cue}${newline}`;
}

function probeRange(body, part) {
  const probe = chooseTimestampProbe(part);
  let output = body;
  for (let index = part.length - 1; index >= 0; index--) {
    let label = "【原时间】";
    if (probe && index === probe.index - 1) {
      label = `【下一条移动块：原 ${formatTime(probe.original.s)}，测试 ${formatTime(probe.original.s - probe.shift)}】`;
    } else if (probe && index === probe.index) {
      label = `【移动块：原 ${formatTime(probe.original.s)}，测试 ${formatTime(probe.original.s - probe.shift)}】`;
    }
    output = markOriginalCue(output, part[index], label);
    if (!output) return body;
  }
  if (probe) {
    output = retimeOriginalCue(
      output,
      probe.original,
      probe.original.s - probe.shift,
      probe.original.e - probe.shift,
    );
    if (!output) return body;
  }
  const requestRange = header($request.headers, "Range") || "-";
  const contentRange = header($response.headers, "Content-Range") || "-";
  const contentLength = header($response.headers, "Content-Length") || "-";
  const windowStart = formatTime(part[0].s);
  const windowEnd = formatTime(Math.max(...part.map((cue) => cue.e)));
  const moved = probe
    ? `${formatTime(probe.original.s)}..${formatTime(probe.original.e)}=>${formatTime(probe.original.s - probe.shift)}..${formatTime(probe.original.e - probe.shift)}`
    : "none";
  console.log(`[NFOfficialDual] timestamp-probe request=${requestRange} response=${contentRange} length=${contentLength} cues=${part.length}->${part.length} window=${windowStart}..${windowEnd} marked=${part.length} moved=${moved} bytes=${String(body).length}->${output.length}`);
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

  // Diagnostic build: modify every subtitle Range immediately, before any cache/state path.
  return done(probeRange(body, part));
}

try {
  main();
} catch (error) {
  console.log(`[NFOfficialDual] error ${String(error)}`);
  $done({});
}
