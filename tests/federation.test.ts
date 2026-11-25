// OpenRouter with no stored key (workload identity federation), against local stand-ins for the
// metadata server of the machine and for OpenRouter. No request leaves this machine.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "parallax-federation-test-"));
mkdirSync(path.join(temp, "research"));
process.env.PARALLAX_DATA_DIR = path.join(temp, "private-data");
process.env.PARALLAX_RESEARCH_ROOT = path.join(temp, "research");
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_FEDERATION_POLICY_ID;

const POLICY = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const IDENTITY = "aGVhZGVy.cGF5bG9hZC1maXh0dXJl.c2lnbmF0dXJl"; // three parts, as a signed token
type Call = {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
};
const calls: Call[] = [];
/** What the stand-ins answer; a test changes it. */
const fake = {
  metadata: { status: 200, flavor: "Google" as string | null, body: IDENTITY },
  exchange: {
    status: 200,
    json: {} as Record<string, unknown>,
  },
  chatStatus: 200,
  issued: 0,
};
const reset = () => {
  calls.length = 0;
  fake.metadata = { status: 200, flavor: "Google", body: IDENTITY };
  fake.exchange = {
    status: 200,
    json: { token_type: "Bearer", expires_in: 900, scope: "inference" },
  };
  fake.chatStatus = 200;
};

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
  });
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "", "http://stand-in");
  calls.push({
    path: url.pathname + url.search,
    headers: req.headers,
    body: await read(req),
  });
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (
    url.pathname ===
    "/computeMetadata/v1/instance/service-accounts/default/identity"
  ) {
    res.writeHead(fake.metadata.status, {
      "content-type": "text/plain",
      ...(fake.metadata.flavor
        ? { "Metadata-Flavor": fake.metadata.flavor }
        : {}),
    });
    return res.end(fake.metadata.body);
  }
  if (url.pathname === "/api/v1/oauth/token") {
    if (fake.exchange.status !== 200)
      return json(fake.exchange.status, fake.exchange.json);
    fake.issued++;
    return json(200, {
      access_token: `short-lived-key-${fake.issued}`,
      ...fake.exchange.json,
    });
  }
  if (url.pathname === "/api/v1/chat/completions") {
    if (fake.chatStatus !== 200)
      return json(fake.chatStatus, { error: { message: "No auth" } });
    return json(200, {
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }
  json(404, { error: { message: "not found" } });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}/api/v1`;
process.env.GCE_METADATA_HOST = `127.0.0.1:${port}`;

const provider = await import("../lib/judge/provider");
const federation = await import("../lib/judge/federation");
const store = await import("../lib/store");
const spaces = await import("../lib/workspaces");
after(() => {
  server.close();
  store.closeDatabases();
  spaces.closeCatalog();
  rmSync(temp, { recursive: true, force: true });
});
beforeEach(() => {
  reset();
  federation.forgetFederatedKey();
  provider.clearKey();
  process.env.OPENROUTER_FEDERATION_POLICY_ID = POLICY;
});
const paths = () => calls.map((call) => call.path.split("?")[0]);
const auth = () =>
  calls
    .filter((call) => call.path === "/api/v1/chat/completions")
    .map((call) => call.headers.authorization);

test("with no key and no policy nothing is configured and nothing is sent", async () => {
  delete process.env.OPENROUTER_FEDERATION_POLICY_ID;
  assert.equal(provider.llmEnabled(), false);
  assert.deepEqual(provider.keyStatus(), {
    configured: false,
    source: null,
    hint: "",
  });
  await assert.rejects(
    () => provider.runText("hello"),
    /No OpenRouter API key/,
  );
  assert.equal(calls.length, 0);
});

test("a policy id gets a key for the machine's identity and reuses it", async () => {
  assert.equal(provider.llmEnabled(), true);
  assert.deepEqual(provider.keyStatus(), {
    configured: true,
    source: "federation",
    hint: "policy …e0f9",
  });
  assert.equal(calls.length, 0); // the status asks nobody

  assert.equal((await provider.runText("hello")).text, "ok");
  await provider.runText("again");

  // One identity token and one exchange for both model calls.
  assert.deepEqual(paths(), [
    "/computeMetadata/v1/instance/service-accounts/default/identity",
    "/api/v1/oauth/token",
    "/api/v1/chat/completions",
    "/api/v1/chat/completions",
  ]);
  const [metadata, exchange] = calls;
  assert.equal(
    metadata.path,
    "/computeMetadata/v1/instance/service-accounts/default/identity?audience=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&format=full",
  );
  assert.equal(metadata.headers["metadata-flavor"], "Google");
  assert.equal(
    exchange.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(exchange.headers.authorization, undefined);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(exchange.body)), {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: IDENTITY,
    federation_policy_id: POLICY,
  });
  const [first, second] = auth();
  assert.match(first ?? "", /^Bearer short-lived-key-\d+$/);
  assert.equal(second, first);
});

test("a key is renewed before it ends, and dropped when OpenRouter refuses it", async () => {
  fake.exchange.json = { token_type: "Bearer", expires_in: 0.4 };
  await provider.runText("one");
  await new Promise((resolve) => setTimeout(resolve, 250)); // past half of its life
  await provider.runText("two");
  const [first, second] = auth();
  assert.notEqual(second, first);

  // A refused key (401) is forgotten: the next call asks for a new one.
  reset();
  federation.forgetFederatedKey();
  fake.chatStatus = 401;
  await assert.rejects(() => provider.runText("three"), /OpenRouter 401/);
  fake.chatStatus = 200;
  await provider.runText("four");
  assert.equal(paths().filter((p) => p === "/api/v1/oauth/token").length, 2);
});

test("a stored key wins over the policy", async () => {
  provider.saveKey("sk-or-stored-key-1234");
  assert.equal(provider.keyStatus().source, "saved");
  await provider.runText("hello");
  assert.deepEqual(paths(), ["/api/v1/chat/completions"]);
  assert.deepEqual(auth(), ["Bearer sk-or-stored-key-1234"]);
  // Removing it falls back to the policy.
  assert.equal(provider.clearKey().source, "federation");
});

test("failures say what to fix and never repeat a token or a wrong id", async () => {
  // Not Google's metadata server: no token is taken from it.
  fake.metadata.flavor = null;
  await assert.rejects(
    () => provider.runText("x"),
    /OpenRouter federation: the metadata server gave no identity token \(status 200\)/,
  );
  assert.deepEqual(paths().includes("/api/v1/oauth/token"), false);

  // A refused exchange: the code and the description, with the identity token cut out.
  reset();
  fake.exchange = {
    status: 403,
    json: {
      error: "access_denied",
      error_description: `subject ${IDENTITY} is not named by the policy`,
    },
  };
  await assert.rejects(
    () => provider.runText("x"),
    (error: Error) => {
      assert.match(
        error.message,
        /gave no key for the identity of this machine \(status 403 access_denied\): subject \[token\] is not named by the policy/,
      );
      assert.equal(error.message.includes(IDENTITY), false);
      return true;
    },
  );
  assert.deepEqual(paths().includes("/api/v1/chat/completions"), false);

  // A reply that is no key for model calls.
  for (const json of [
    { token_type: "Bearer", expires_in: 900, scope: "management" },
    { token_type: "mac", expires_in: 900 },
    { token_type: "Bearer", expires_in: 0 },
    { token_type: "Bearer", expires_in: 9_000_000 },
  ]) {
    reset();
    fake.exchange.json = json;
    await assert.rejects(
      () => provider.runText("x"),
      /holds no key for model calls/,
    );
  }

  // Another text pasted by mistake as the policy id (a key, for example) is refused before any
  // request, and not shown.
  reset();
  process.env.OPENROUTER_FEDERATION_POLICY_ID = "not-an-id-pasted-by-mistake";
  await assert.rejects(
    () => provider.runText("x"),
    (error: Error) => {
      assert.match(error.message, /must have the form xxxxxxxx-/);
      assert.equal(error.message.includes("pasted-by-mistake"), false);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("the model list works with federation and survives a failed exchange", async () => {
  fake.exchange = { status: 403, json: { error: "access_denied" } };
  const models = await provider.listModels(); // the catalog call fails: the static list is served
  assert.ok(models.some((m) => m.id === "openai/gpt-6-luna"));
  assert.ok(models.some((m) => m.kind === "decision")); // offered: a policy is configured
});
