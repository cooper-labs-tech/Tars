import type { ClientRequest, IncomingMessage, RequestOptions } from "http";

/** How every server here says it waited `ms` for an answer and got none. */
export function noAnswerWithin(ms: number): string {
  return `no answer within ${ms / 1000} s`;
}

/** How long a server here waits on Tars before it says so: apiRequest's default too. */
export const TARS_WAIT_MS = 30_000;

/**
 * How long a call to an outside API (SocialData, X) may stay silent
 * before the server says so, where it used to wait for Claude Code to give up
 * on the call, about half an hour later. Silence, not a total: an answer that
 * is only slow gets a minute. Tars makes those calls since 2.0.4
 * (services/api-routes/integration-routes.ts, with the same minute): a server
 * waits this, and Tars's own TARS_WAIT_MS, for Tars's answer.
 */
export const API_WAIT_MS = 60_000;

/**
 * One request over http or https, its answer read whole as text. Reaching the
 * host and reading what it answered is the same for every client here; what
 * each makes of the answer, and how it words a host it could not reach, stays
 * its own. A timeout in the options ends the request with "no answer within
 * N s".
 */
export function send(
  via: { request(options: RequestOptions, onAnswer: (res: IncomingMessage) => void): ClientRequest },
  options: RequestOptions,
  body: string | undefined,
  unreachable: (error: Error) => Error,
): Promise<{ status: number | undefined; data: string }> {
  return new Promise((resolve, reject) => {
    const req = via.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", (err) => reject(unreachable(err)));
    const timeout = options.timeout;
    if (timeout) req.on("timeout", () => req.destroy(new Error(noAnswerWithin(timeout))));
    if (body) req.write(body);
    req.end();
  });
}
