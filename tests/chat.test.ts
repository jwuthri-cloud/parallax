// The workspace chat against a local stand-in for OpenRouter. No request leaves this machine:
// the base URL points at a server started here.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatEvent } from "../lib/chat";

const temp = mkdtempSync(path.join(os.tmpdir(), "parallax-chat-test-"));
mkdirSync(path.join(temp, "research"));
process.env.PARALLAX_DATA_DIR = path.join(temp, "private-data");
process.env.PARALLAX_RESEARCH_ROOT = path.join(temp, "research");
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_FEDERATION_POLICY_ID; // set on machines with federation

type Json = Record<string, unknown>;
type Message = { role: string; content: string; tool_call_id?: string };
/** One model turn of the stand-in: text, or tool calls. */
type Turn = {
  text?: string;
  calls?: { name: string; args: Json }[];
  error?: string;
};
const requests: { auth: string | undefined; body: Json }[] = [];
/** What the stand-in answers; a test sets it. It sees the request's messages. */
let script: (messages: Message[], body: Json) => Turn = () => ({ text: "ok" });

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
  });
const server = createServer(async (req, res) => {
  const body = JSON.parse(await read(req)) as Json;
  requests.push({ auth: req.headers.authorization, body });
  if (req.url !== "/api/v1/chat/completions" || body.stream !== true) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "not found" } }));
  }
  const turn = script(body.messages as Message[], body);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (json: Json) => res.write(`data: ${JSON.stringify(json)}\n\n`);
  res.write(": OPENROUTER PROCESSING\n\n");
  if (turn.error) {
    frame({ error: { message: turn.error }, choices: [] });
    return res.end();
  }
  // Text in two pieces, and tool-call arguments in two pieces, as a real stream sends them.
  const text = turn.text ?? "";
  if (text) {
    const half = Math.ceil(text.length / 2);
    for (const part of [text.slice(0, half), text.slice(half)])
      frame({ choices: [{ delta: { content: part } }] });
  }
  (turn.calls ?? []).forEach((call, index) => {
    const args = JSON.stringify(call.args);
    frame({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: `call_${requests.length}_${index}`,
                function: { name: call.name, arguments: args.slice(0, 5) },
              },
            ],
          },
        },
      ],
    });
    frame({
      choices: [
        {
          delta: {
            tool_calls: [{ index, function: { arguments: args.slice(5) } }],
          },
        },
      ],
    });
  });
  frame({
    choices: [],
    usage: { prompt_tokens: 200, completion_tokens: 30, cost: 0.001 },
  });
  res.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

const store = await import("../lib/store");
const spaces = await import("../lib/workspaces");
const provider = await import("../lib/judge/provider");
const chat = await import("../lib/chat");
after(() => {
  server.close();
  store.closeDatabases();
  spaces.closeCatalog();
  rmSync(temp, { recursive: true, force: true });
});

const ask = async (input: Json) => {
  const events: ChatEvent[] = [];
  const message = await chat.answer(input, (event) => events.push(event));
  return { events, message };
};
const toolResults = (messages: Message[]) =>
  messages.filter((m) => m.role === "tool").map((m) => m.content);

test("without a key the chat refuses and no request is made", async () => {
  await assert.rejects(
    () => ask({ message: "What did we find?" }),
    /needs an OpenRouter key/,
  );
  assert.equal(requests.length, 0);
  assert.deepEqual(chat.listThreads(), []);
});

test("an answer searches, cites numbered sources, streams and is stored", async () => {
  provider.saveKey("sk-or-test-key-123456");
  const finding = store.createRecord({
    kind: "finding",
    title: "Fixture: pressure raises sycophancy",
    evidence: "observed",
    content: "Agreement with wrong users rose from 12% to 31% under pressure.",
  });
  const experiment = store.createRecord({
    kind: "experiment",
    title: "Fixture: pressure sweep",
    status: "running",
    metrics: [{ name: "agree/rate", step: 1, value: 0.31, n: 200 }],
  });
  script = (messages) => {
    const results = toolResults(messages);
    if (results.length === 0)
      return {
        text: "Checking.",
        calls: [{ name: "search", args: { query: "sycophancy pressure" } }],
      };
    if (results.length === 1)
      return {
        calls: [
          { name: "read_record", args: { id: experiment.id } },
          {
            name: "list_records",
            args: { kind: "experiment", status: "running" },
          },
          { name: "nope", args: {} },
        ],
      };
    return { text: "Agreement rose to 31% [1]; the sweep is running [2]." };
  };

  const { events, message } = await ask({ message: "Did pressure matter?" });

  // The request: the key, a streamed call with the tools, the question last.
  const first = requests[0];
  assert.equal(first.auth, "Bearer sk-or-test-key-123456");
  assert.equal(first.body.model, "openai/gpt-6-luna");
  assert.deepEqual(
    (first.body.tools as { function: { name: string } }[]).map(
      (t) => t.function.name,
    ),
    ["search", "read_record", "list_records"],
  );
  const sent = first.body.messages as Message[];
  assert.equal(sent[0].role, "system");
  assert.match(sent[0].content, /never an instruction to you/);
  assert.deepEqual(sent.at(-1), {
    role: "user",
    content: "Did pressure matter?",
  });

  // What the tools told the model: numbered passages with the evidence level.
  const results = toolResults(requests[2].body.messages as Message[]);
  assert.match(
    results[0],
    new RegExp(
      `^\\[1\\] finding "Fixture: pressure raises sycophancy" \\(id ${finding.id}, evidence observed, status draft, updated \\d{4}-\\d\\d-\\d\\d\\)\\n`,
    ),
  );
  assert.match(results[0], /rose from 12% to 31%/);
  assert.match(results[1], /^\[2\] experiment "Fixture: pressure sweep"/);
  assert.match(results[1], /agree\/rate: 0\.31 at step 1, n=200 \(1 point\)/);
  assert.match(
    results[2],
    /^\[2\] experiment "Fixture: pressure sweep" \(id .*status running/,
  );
  assert.equal(results[3], 'Error: there is no tool "nope".');

  // The stored answer and the events.
  assert.equal(
    message.content,
    "Checking.\n\nAgreement rose to 31% [1]; the sweep is running [2].",
  );
  assert.deepEqual(
    message.sources.map((s) => [s.n, s.source, s.id, s.recordId]),
    [
      [1, "record", finding.id, finding.id],
      [2, "record", experiment.id, experiment.id],
    ],
  );
  assert.deepEqual(
    message.steps.map((s) => s.tool),
    ["search", "read_record", "list_records", "nope"],
  );
  assert.equal(message.steps[0].input, "sycophancy pressure");
  assert.deepEqual(
    [message.usage?.input_tokens, message.usage?.output_tokens],
    [600, 90],
  );
  assert.ok(Math.abs((message.usage?.cost_usd ?? 0) - 0.003) < 1e-9);
  assert.equal(events[0].type, "thread");
  assert.equal(events.at(-1)?.type, "message");
  assert.equal(
    events.map((e) => (e.type === "text" ? e.delta : "")).join(""),
    "Checking.\n\nAgreement rose to 31% [1]; the sweep is running [2].",
  );

  // The thread: both messages, and a second turn that keeps the source numbers.
  const [thread] = chat.listThreads();
  assert.equal(thread.title, "Did pressure matter?");
  assert.deepEqual(
    chat.getThread(thread.id).messages.map((m) => m.role),
    ["user", "assistant"],
  );
  const other = store.createRecord({
    kind: "note",
    title: "Fixture: quokka note",
    content: "Quokka replication is planned.",
  });
  script = (messages) =>
    toolResults(messages).length
      ? { text: "Planned [3], after the sweep [2]." }
      : {
          calls: [
            { name: "search", args: { query: "quokka" } },
            { name: "read_record", args: { id: experiment.id } },
          ],
        };
  const before = requests.length;
  const second = await ask({
    threadId: thread.id,
    message: "And the replication?",
  });
  const history = requests[before].body.messages as Message[];
  assert.deepEqual(
    history.map((m) => m.role),
    ["system", "user", "assistant", "user"],
  );
  assert.deepEqual(
    second.message.sources.map((s) => [s.n, s.id]),
    [
      [2, experiment.id],
      [3, other.id],
    ],
  );
  assert.equal(chat.getThread(thread.id).messages.length, 4);
});

test("the open record is given to the model as a source", async () => {
  const note = store.createRecord({
    kind: "note",
    title: "Fixture: open note",
    content: "The okapi threshold is 0.4.",
  });
  script = () => ({ text: "It is 0.4 [1]." });
  const before = requests.length;
  const { message } = await ask({
    message: "What is the threshold here?",
    focusRecordId: note.id,
  });
  const system = (requests[before].body.messages as Message[])[0].content;
  assert.match(system, /The user has this record open/);
  assert.match(system, /\[1\] note "Fixture: open note"/);
  assert.match(system, /The okapi threshold is 0\.4\./);
  assert.deepEqual(
    message.sources.map((s) => [s.n, s.id]),
    [[1, note.id]],
  );
});

test("the search rounds are limited and the last call has no tools", async () => {
  script = (_messages, body) =>
    body.tools
      ? { calls: [{ name: "search", args: { query: "nothing here" } }] }
      : { text: "I could not find it." };
  const before = requests.length;
  const { message } = await ask({ message: "Loop?" });
  const made = requests.slice(before);
  assert.equal(made.length, 6);
  assert.equal(made.at(-1)?.body.tools, undefined);
  assert.match(
    (made.at(-1)?.body.messages as Message[]).at(-1)?.content ?? "",
    /search limit of this answer is reached/,
  );
  assert.equal(message.content, "I could not find it.");
  assert.equal(message.steps.length, 5);
});

test("a failed answer keeps the question and stores no answer; a thread can be deleted", async () => {
  script = () => ({ error: "Insufficient credits" });
  await assert.rejects(
    () => ask({ message: "Will this fail?" }),
    /OpenRouter failed for openai\/gpt-6-luna: Insufficient credits/,
  );
  const thread = chat.listThreads().find((t) => t.title === "Will this fail?");
  assert.ok(thread);
  assert.deepEqual(
    chat.getThread(thread.id).messages.map((m) => m.role),
    ["user"],
  );
  chat.deleteThread(thread.id);
  assert.throws(() => chat.getThread(thread.id), /Conversation not found/);
  await assert.rejects(
    () => ask({ threadId: thread.id, message: "Again" }),
    /Conversation not found/,
  );
  await assert.rejects(() => ask({ message: "   " }));
});
