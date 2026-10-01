/**
 * What to do about a key, stated as data rather than prose.
 *
 * The loop this ends: an agent issues a key, does not keep it, calls an authenticated route
 * without it, is told how to ISSUE, signs an issue challenge, is refused because a key already
 * exists (ACTIVE_KEY_EXISTS), and signs again. "Use it, or rotate" was correct and not actionable:
 * an agent that has lost its key cannot use it, and nothing said which branch it was on. Every
 * answer here names both branches explicitly and gives the rotation as exact steps, so recovering
 * is never ISSUE again: it is ACTIVE_KEY_EXISTS -> ROTATE -> PERSIST -> USE.
 *
 * Nothing here logs anyone in, stores a key for anyone, signs anything or rotates anything. The
 * agent still performs every step itself.
 */

const HEADER_TEMPLATE = "Authorization: Bearer <apiKey>";

/** The rotation, as the exact requests to make. */
export function rotationSteps(wallet: string | null) {
  return [
    { method: "POST", path: "/api/v1/auth/challenge", body: { wallet: wallet ?? "<your wallet>", purpose: "ROTATE_API_KEY" } },
    { action: "SIGN_RETURNED_MESSAGE_EXACTLY", note: "sign the `message` field of that response, unchanged, with the same wallet" },
    { method: "POST", path: "/api/v1/auth/api-key/rotate", body: { nonce: "<nonce from the challenge>", signature: "<your signature>" } },
    { action: "PERSIST_RETURNED_API_KEY", note: "the previous key stops working the moment the new one is created" },
  ];
}

/** When the site KNOWS this wallet already holds an active key. */
export function activeKeyRecovery(wallet: string | null) {
  return {
    activeKeyExists: true,
    apiKeyCannotBeRetrieved: true,
    doNotIssueAgain: true,
    recommendedAction: "USE_EXISTING_KEY_OR_ROTATE_IF_LOST",
    ifKeyAvailable: {
      action: "USE_EXISTING_KEY",
      authorizationScheme: "Bearer",
      authorizationHeader: HEADER_TEMPLATE,
    },
    ifKeyLost: {
      action: "ROTATE_API_KEY",
      challengePurpose: "ROTATE_API_KEY",
      steps: rotationSteps(wallet),
    },
  };
}

/** When the site CANNOT tell who is asking: all three branches, and no guess between them. */
export function unknownCallerRecovery() {
  return {
    activeApiKeyExists: "UNKNOWN — this request names no wallet",
    ifYouHaveAKey: { action: "USE_EXISTING_KEY", authorizationScheme: "Bearer", authorizationHeader: HEADER_TEMPLATE },
    ifYouHadAKeyAndLostIt: {
      action: "ROTATE_API_KEY",
      doNotIssueAgain: true,
      why: "issuing is refused (409 ACTIVE_KEY_EXISTS) while a key is active, and a key cannot be shown again",
      steps: rotationSteps(null),
    },
    ifYouNeverHadAKey: {
      action: "ISSUE_API_KEY",
      steps: [
        { method: "POST", path: "/api/v1/auth/challenge", body: { wallet: "<your wallet>", purpose: "ISSUE_API_KEY" } },
        { action: "SIGN_RETURNED_MESSAGE_EXACTLY" },
        { method: "POST", path: "/api/v1/auth/api-key/issue", body: { nonce: "<nonce>", signature: "<signature>" } },
        { action: "PERSIST_RETURNED_API_KEY" },
      ],
    },
  };
}
