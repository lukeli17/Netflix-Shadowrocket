/*
 * Netflix mobile manifest probe for Shadowrocket.
 * Diagnostic only: logs metadata and structural markers, then passes traffic
 * through unchanged. It never logs the response body or URL query values.
 */

(function () {
  "use strict";

  const PREFIX = "[NFManifestProbe]";

  function header(headers, name) {
    const wanted = String(name).toLowerCase();
    const keys = Object.keys(headers || {});
    for (let i = 0; i < keys.length; i += 1) {
      if (keys[i].toLowerCase() === wanted) return String(headers[keys[i]]);
    }
    return "";
  }

  function safeTarget(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return `${url.hostname}${url.pathname}`;
    } catch (_) {
      return String(rawUrl || "").split("?")[0];
    }
  }

  function byteInfo(response) {
    try {
      if (response.bodyBytes) {
        const bytes = new Uint8Array(response.bodyBytes);
        const head = [];
        const count = Math.min(bytes.length, 16);
        for (let i = 0; i < count; i += 1) {
          head.push(bytes[i].toString(16).padStart(2, "0"));
        }
        return { length: bytes.length, head: head.join(" ") };
      }
    } catch (_) {}

    const body = typeof response.body === "string" ? response.body : "";
    const head = [];
    const count = Math.min(body.length, 16);
    for (let i = 0; i < count; i += 1) {
      head.push((body.charCodeAt(i) & 0xff).toString(16).padStart(2, "0"));
    }
    return { length: body.length, head: head.join(" ") };
  }

  const target = safeTarget($request && $request.url);

  if (typeof $response === "undefined") {
    const contentType = header($request.headers, "content-type");
    const contentLength = header($request.headers, "content-length");
    console.log(
      `${PREFIX} request method=${$request.method || "?"} target=${target} ` +
      `type=${contentType || "?"} declared=${contentLength || "?"}`
    );
    $done({});
    return;
  }

  const contentType = header($response.headers, "content-type");
  const contentEncoding = header($response.headers, "content-encoding");
  const contentLength = header($response.headers, "content-length");
  const info = byteInfo($response);
  const text = typeof $response.body === "string" ? $response.body : "";
  const markers = [
    "timedtexttracks",
    "ttDownloadables",
    "downloadUrls",
    "ciphertext",
    "payloads",
    "headerdata",
    "errordata"
  ].filter(function (item) {
    return text.indexOf(item) !== -1;
  });

  console.log(
    `${PREFIX} response status=${$response.status || $response.statusCode || "?"} ` +
    `target=${target} type=${contentType || "?"} encoding=${contentEncoding || "none"} ` +
    `declared=${contentLength || "?"} body=${info.length} head=${info.head || "empty"} ` +
    `markers=${markers.length ? markers.join(",") : "none"}`
  );

  $done({});
})();
