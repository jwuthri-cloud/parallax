import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { guard, errorResponse, jsonBody } from "../lib/http";

function request(
  headers: Record<string, string> = {},
  url = "http://127.0.0.1:3000/api/records",
) {
  return new NextRequest(url, {
    method: "POST",
    headers: { host: "127.0.0.1:3000", ...headers },
    body: "{}",
  });
}
test("local API accepts loopback clients and same-origin browsers", () => {
  assert.doesNotThrow(() => guard(request()));
  assert.doesNotThrow(() =>
    guard(
      request({
        origin: "http://127.0.0.1:3000",
        "sec-fetch-site": "same-origin",
      }),
    ),
  );
});
test("local API rejects hostile origins, cross-site requests, and DNS rebinding hosts", () => {
  assert.throws(
    () => guard(request({ origin: "https://hostile.example" })),
    /Cross-origin/,
  );
  assert.throws(
    () => guard(request({ "sec-fetch-site": "cross-site" })),
    /Cross-site/,
  );
  assert.throws(
    () => guard(request({ host: "hostile.example:3000" })),
    /local-only/,
  );
  assert.throws(
    () =>
      guard(
        request(
          { host: "hostile.example:3000" },
          "http://hostile.example:3000/api/records",
        ),
      ),
    /local-only/,
  );
});
test("PARALLAX_ALLOWED_HOSTS opts a proxied deployment in, and nothing else", () => {
  const previous = process.env.PARALLAX_ALLOWED_HOSTS;
  process.env.PARALLAX_ALLOWED_HOSTS = " Parallax.Example.com , ";
  try {
    // `next start --hostname 0.0.0.0` builds request URLs from the listen address.
    const proxied = (headers: Record<string, string> = {}) =>
      request(
        { host: "parallax.example.com", ...headers },
        "http://0.0.0.0:3000/api/records",
      );
    assert.doesNotThrow(() => guard(proxied()));
    assert.doesNotThrow(() =>
      guard(
        proxied({
          origin: "https://parallax.example.com",
          "sec-fetch-site": "same-origin",
        }),
      ),
    );
    assert.doesNotThrow(() => guard(request()));
    assert.throws(
      () => guard(proxied({ origin: "https://hostile.example" })),
      /Cross-origin/,
    );
    assert.throws(
      () => guard(proxied({ "sec-fetch-site": "cross-site" })),
      /Cross-site/,
    );
    assert.throws(
      () =>
        guard(
          request(
            { host: "hostile.example" },
            "http://hostile.example/api/records",
          ),
        ),
      /local-only/,
    );
  } finally {
    if (previous === undefined) delete process.env.PARALLAX_ALLOWED_HOSTS;
    else process.env.PARALLAX_ALLOWED_HOSTS = previous;
  }
  // Without the opt-in, listening on every interface stays refused.
  assert.throws(
    () =>
      guard(
        request({ host: "127.0.0.1:3000" }, "http://0.0.0.0:3000/api/records"),
      ),
    /local-only/,
  );
});
test("malformed and oversized JSON produce controlled errors", async () => {
  const bad = new NextRequest("http://localhost/api/records", {
    method: "POST",
    body: "{",
  });
  await assert.rejects(() => jsonBody(bad), SyntaxError);
  const large = new NextRequest("http://localhost/api/records", {
    method: "POST",
    body: JSON.stringify("x".repeat(2 * 1024 * 1024)),
  });
  await assert.rejects(() => jsonBody(large), /too large/);
  assert.equal(errorResponse(new SyntaxError("bad")).status, 400);
});
