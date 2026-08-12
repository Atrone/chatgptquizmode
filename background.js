importScripts("ExtPay.js");

// Keep provider configuration in one place for ExtensionPay setup.
const EXTENSIONPAY_EXTENSION_ID = "chatgpt-quiz-mode-interactive-mcqs";
const EXTENSION_PREFIX = "mcq-radio-extension";
const FREE_QUIZ_KEY = `${EXTENSION_PREFIX}:freeQuizId`;
let freeQuizClaimQueue = Promise.resolve();

// Initialize ExtensionPay background handling once when the service worker starts.
const backgroundExtPay = ExtPay(EXTENSIONPAY_EXTENSION_ID);
backgroundExtPay.startBackground();

/**
 * Handles content-script requests for paywall state and payment actions.
 *
 * @param {{type?: string}} message - Runtime message from a content script.
 * @param {chrome.runtime.MessageSender} sender - Chrome sender metadata.
 * @param {(response: unknown) => void} sendResponse - Callback for async replies.
 * @returns {boolean | undefined} True when the response will be sent asynchronously.
 */
function handleRuntimeMessage(message, sender, sendResponse) {
  // Ignore messages that do not belong to this extension's paywall API.
  if (!message || typeof message.type !== "string" || !message.type.startsWith(`${EXTENSION_PREFIX}:`)) {
    return undefined;
  }

  // Route the request asynchronously so service-worker promises can settle.
  handlePaywallMessage(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse(createErrorResponse(error));
    });

  // Keep the message channel open for the async response above.
  return true;
}

/**
 * Routes a single paywall API message to the appropriate provider action.
 *
 * @param {{type: string, quizId?: string}} message - Namespaced paywall message.
 * @returns {Promise<Record<string, unknown>>} Serializable response payload.
 */
async function handlePaywallMessage(message) {
  // Recreate the client inside callbacks per ExtensionPay MV3 guidance.
  const extpay = createExtPayClient();

  // Expose the current access state to ChatGPT content scripts.
  if (message.type === `${EXTENSION_PREFIX}:getAccessState`) {
    return getAccessState(extpay, message.quizId);
  }

  // Open ExtensionPay's payment picker so the Pay Now button appears directly.
  if (message.type === `${EXTENSION_PREFIX}:openPaymentPage`) {
    await extpay.openPaymentPage();
    return {
      ok: true
    };
  }

  // Open the email login/reactivation page for users who already paid.
  if (message.type === `${EXTENSION_PREFIX}:openLoginPage`) {
    await extpay.openLoginPage();
    return {
      ok: true
    };
  }

  // Report unsupported messages without throwing noisy provider errors.
  return {
    ok: false,
    status: "unknown",
    error: "Unsupported paywall message."
  };
}

/**
 * Computes the current paid/free/locked access state for quiz rendering.
 *
 * @param {{getUser: Function}} extpay - ExtensionPay client for this callback.
 * @param {unknown} quizId - Stable identifier for the quiz requesting access.
 * @returns {Promise<Record<string, unknown>>} Serializable paywall state.
 */
async function getAccessState(extpay, quizId) {
  try {
    // Ask ExtensionPay for the account-backed paid status.
    const user = await extpay.getUser();

    // Paid accounts should always get full access.
    if (user.paid) {
      return createAccessResponse("paid", user);
    }

    // Give unpaid users access only when this is their one claimed free quiz.
    if (await claimFreeQuiz(quizId)) {
      return createAccessResponse("free", user);
    }

    // After one quiz, unpaid users must complete checkout or login.
    return createAccessResponse("locked", user);
  } catch (error) {
    // Provider failures still allow the claimed free quiz but do not unlock others.
    if (await claimFreeQuiz(quizId)) {
      return createAccessResponse("free", null, error);
    }

    // Users beyond the free quiz need a retry/payment path during provider outages.
    return createAccessResponse("unknown", null, error);
  }
}

/**
 * Claims the single free quiz or verifies that the requesting quiz owns it.
 *
 * @param {unknown} quizId - Stable identifier for the quiz requesting access.
 * @returns {Promise<boolean>} Whether the quiz is the user's free quiz.
 */
function claimFreeQuiz(quizId) {
  // Reject missing identifiers so malformed requests cannot bypass the paywall.
  const normalizedQuizId = typeof quizId === "string" ? quizId.trim() : "";
  if (!normalizedQuizId) {
    return Promise.resolve(false);
  }

  // Serialize storage updates so simultaneous page scans cannot claim multiple quizzes.
  const claim = freeQuizClaimQueue.then(readOrClaimFreeQuiz.bind(null, normalizedQuizId));

  // Keep the queue usable even if an individual storage operation fails.
  freeQuizClaimQueue = claim.catch(ignoreClaimFailure);
  return claim;
}

/**
 * Reads the current free-quiz claim and creates it when none exists.
 *
 * @param {string} quizId - Normalized quiz identifier requesting the claim.
 * @returns {Promise<boolean>} Whether this quiz owns the free claim.
 */
async function readOrClaimFreeQuiz(quizId) {
  // Reuse the existing claim when this exact quiz is rendered again.
  const result = await chrome.storage.local.get(FREE_QUIZ_KEY);
  const claimedQuizId = typeof result[FREE_QUIZ_KEY] === "string" ? result[FREE_QUIZ_KEY] : "";
  if (claimedQuizId) {
    return claimedQuizId === quizId;
  }

  // Persist the first quiz before granting its free access.
  await chrome.storage.local.set({
    [FREE_QUIZ_KEY]: quizId
  });
  return true;
}

/**
 * Prevents one failed storage operation from permanently rejecting the claim queue.
 *
 * @returns {undefined} An empty queue recovery value.
 */
function ignoreClaimFailure() {
  // Resolve the internal queue while the original claim still reports its failure.
  return undefined;
}

/**
 * Creates a fresh ExtensionPay client for service-worker callbacks.
 *
 * @returns {{getUser: Function, openPaymentPage: Function, openLoginPage: Function}} ExtensionPay client.
 */
function createExtPayClient() {
  // ExtensionPay recommends redeclaring the client inside MV3 callbacks.
  return ExtPay(EXTENSIONPAY_EXTENSION_ID);
}

/**
 * Converts ExtensionPay or storage date values into valid Date objects.
 *
 * @param {unknown} value - Date-like value to normalize.
 * @returns {Date | null} Valid date or null when unavailable.
 */
function normalizeDate(value) {
  // Keep Date instances when ExtensionPay already returned one.
  const date = value instanceof Date ? value : new Date(String(value || ""));

  // Reject invalid dates so callers can fall back cleanly.
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  // Return a normalized Date for downstream time math.
  return date;
}

/**
 * Creates a serializable access-state response for content scripts.
 *
 * @param {string} status - Access status for UI gating.
 * @param {{email?: string | null, paidAt?: Date | null} | null} user - Optional ExtensionPay user.
 * @param {unknown} [error] - Optional provider error.
 * @returns {Record<string, unknown>} Serializable access response.
 */
function createAccessResponse(status, user, error) {
  // Keep the response small and free of non-serializable Date objects.
  const response = {
    ok: !error,
    status,
    email: user?.email || null,
    paidAt: user?.paidAt ? normalizeDate(user.paidAt)?.toISOString() || null : null
  };

  // Include a concise error message for UI copy and debugging.
  if (error) {
    response.error = getErrorMessage(error);
  }

  // Return the content-script payload.
  return response;
}

/**
 * Converts thrown errors into a serializable failure response.
 *
 * @param {unknown} error - Error thrown while handling a message.
 * @returns {Record<string, unknown>} Serializable error response.
 */
function createErrorResponse(error) {
  // Keep unexpected failures visible without leaking complex objects.
  return {
    ok: false,
    status: "unknown",
    error: getErrorMessage(error)
  };
}

/**
 * Extracts a user-readable message from an unknown error value.
 *
 * @param {unknown} error - Error-like value.
 * @returns {string} Error message.
 */
function getErrorMessage(error) {
  // Prefer native Error messages when available.
  if (error instanceof Error) {
    return error.message;
  }

  // Fall back to string conversion for provider-specific failures.
  return String(error || "Payment status is unavailable.");
}

// Expose private helpers only when the unit-test harness explicitly asks for them.
if (globalThis.__MCQ_RADIO_EXTENSION_ENABLE_TEST_API__) {
  globalThis.__mcqRadioExtensionBackgroundTestApi = {
    handleRuntimeMessage,
    handlePaywallMessage,
    getAccessState,
    claimFreeQuiz,
    createExtPayClient,
    normalizeDate,
    createAccessResponse,
    createErrorResponse,
    getErrorMessage
  };
} else {
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}
