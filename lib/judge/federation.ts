// A key of OpenRouter with no stored key: workload identity federation.
//
// This works on a Google Compute Engine machine whose service account an administrator of the
// OpenRouter account named in a federation policy. Two requests:
// 1. The machine asks its metadata server for an identity token: a text that Google signs, and
//    that names the service account and the audience it is written for.
// 2. OpenRouter takes the token and gives an access token for it (an OAuth token exchange). The
//    access token works as the API key that the policy names, for fifteen minutes at most.
//
// - It is on when `OPENROUTER_FEDERATION_POLICY_ID` is set. The id is an identifier, not a secret.
// - The identity token and the access token stay in the memory of this process. Nothing here
//   writes a file or a log line with them, and an error message never repeats them.
// - Neither request follows a redirect.
// - The exchange goes to the same host as the model calls (`OPENROUTER_BASE_URL`), where a
//   stored key would go too. `GCE_METADATA_HOST` moves the metadata server, as in Google's own
//   client libraries; the tests use both to stay on 127.0.0.1.
import { StoreError } from "../workspaces";

/** Who the identity token is written for. The federation policy names the same audience. */
const AUDIENCE = "https://openrouter.ai/api/v1";
const POLICY_FORM = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** An identity token is three parts of plain characters with a dot between them. */
const IDENTITY_FORM = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_IDENTITY_CHARS = 16384;
/** A key lasts fifteen minutes at most. A reply that names more than a day names no time. */
const MAX_KEY_SECONDS = 86400;
/** Ask for a new key this long before the current one ends. */
const RENEW_BEFORE_SECONDS = 120;

export const federationPolicyId = () =>
  (process.env.OPENROUTER_FEDERATION_POLICY_ID ?? "").trim();

const unavailable = (message: string) =>
  new StoreError(`OpenRouter federation: ${message}`, 503);

/** An identity token of this machine's service account, from its metadata server. */
async function identityToken(): Promise<string> {
  const host =
    (process.env.GCE_METADATA_HOST ?? "").trim() || "metadata.google.internal";
  const url = `http://${host}/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(AUDIENCE)}&format=full`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "Metadata-Flavor": "Google" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw unavailable(
      "the metadata server gave no reply. This works only on a Google Compute Engine machine with a service account.",
    );
  }
  // Only Google's metadata server answers with this header: another host with the name gives no token.
  const fromGoogle =
    response.status === 200 &&
    response.headers.get("metadata-flavor") === "Google";
  const token = fromGoogle ? (await response.text()).trim() : "";
  if (token.length > MAX_IDENTITY_CHARS || !IDENTITY_FORM.test(token))
    throw unavailable(
      `the metadata server gave no identity token (status ${response.status}). The machine needs a service account.`,
    );
  return token;
}

type Key = { value: string; renewAt: number; endsAt: number };

/** Exchange the machine's identity for a key. `exchangeUrl` is OpenRouter's token endpoint. */
async function exchange(policyId: string, exchangeUrl: string): Promise<Key> {
  // The given id is not shown: a key set by mistake in place of an id must not reach a log.
  if (!POLICY_FORM.test(policyId))
    throw unavailable(
      "OPENROUTER_FEDERATION_POLICY_ID must have the form xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.",
    );
  const identity = await identityToken();
  let response: Response;
  try {
    response = await fetch(exchangeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        subject_token: identity,
        federation_policy_id: policyId,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw unavailable("OpenRouter gave no reply to the token exchange.");
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object")
      body = parsed as Record<string, unknown>;
  } catch {
    // not JSON: handled as a reply with no fields
  }
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  if (response.status !== 200) {
    // The error code is a short name; any other text is not shown. A reply can repeat the
    // identity token in its fields, so the description has it cut out.
    const code = text(body.error);
    const said = text(body.error_description)
      .replaceAll(identity, "[token]")
      .slice(0, 300);
    throw unavailable(
      `OpenRouter gave no key for the identity of this machine (status ${response.status}${/^[a-z_]{1,64}$/.test(code) ? ` ${code}` : ""})${said ? `: ${said}` : ""}. The policy must exist, be active and name this machine's service account.`,
    );
  }
  const value = text(body.access_token);
  const seconds = typeof body.expires_in === "number" ? body.expires_in : 0;
  if (
    !value ||
    !(seconds > 0 && seconds <= MAX_KEY_SECONDS) ||
    text(body.token_type).toLowerCase() !== "bearer" ||
    // A key for the management of the account is no key for model calls.
    (body.scope !== undefined &&
      body.scope !== null &&
      body.scope !== "inference")
  )
    throw unavailable(
      "the reply to the token exchange holds no key for model calls.",
    );
  const now = Date.now();
  return {
    value,
    endsAt: now + seconds * 1000,
    renewAt:
      now + (seconds - Math.min(RENEW_BEFORE_SECONDS, seconds / 2)) * 1000,
  };
}

let current: { policyId: string; exchangeUrl: string; key: Key } | undefined;
let pending: Promise<Key> | undefined;

/** The key of the configured policy: the one in memory while it lasts, else a new one. Calls
 *  that arrive during an exchange share it. */
export async function federatedKey(exchangeUrl: string): Promise<string> {
  const policyId = federationPolicyId();
  if (
    current &&
    current.policyId === policyId &&
    current.exchangeUrl === exchangeUrl &&
    Date.now() < current.key.renewAt
  )
    return current.key.value;
  pending ??= exchange(policyId, exchangeUrl).finally(() => {
    pending = undefined;
  });
  const key = await pending;
  current = { policyId, exchangeUrl, key };
  return key.value;
}

/** Forget the key in memory: after OpenRouter refused it, and between tests. */
export function forgetFederatedKey() {
  current = undefined;
}
