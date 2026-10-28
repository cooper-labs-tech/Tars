/**
 * Preloaded into a server under contract (`node --import`): every HTTPS call it
 * makes goes to the contract's fake instead of SocialData or X, as
 * plain HTTP, with the host it asked for in `x-contract-host`.
 *
 * The servers import `https` as an ES namespace, so the patched functions are
 * pushed into it with syncBuiltinESMExports. Nothing else is changed: the
 * server builds its request as it always does, and this only moves where it
 * lands.
 */
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const port = Number(process.env.CONTRACT_FAKE_PORT);

function toFake(target, callback) {
  const options = target instanceof URL || typeof target === "string"
    ? (() => {
        const url = new URL(target);
        return { hostname: url.hostname, path: `${url.pathname}${url.search}`, method: "GET", headers: {} };
      })()
    : { ...target };
  const host = options.hostname || options.host;
  delete options.host;
  delete options.agent;
  return http.request(
    { ...options, protocol: "http:", hostname: "127.0.0.1", port, headers: { ...(options.headers || {}), "x-contract-host": host } },
    callback,
  );
}

https.request = toFake;
https.get = (target, callback) => {
  const req = toFake(target, callback);
  req.end();
  return req;
};
syncBuiltinESMExports();
