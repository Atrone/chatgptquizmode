importScripts("ExtPay.js");

// Keep provider configuration in one place for ExtensionPay setup.
const EXTENSIONPAY_EXTENSION_ID = "chatgpt-quiz-mode-interactive-mcqs";
const EXTENSIONPAY_PLAN_NICKNAME = "lifetime";
const EXTENSION_PREFIX = "mcq-radio-extension";
const TRIAL_DURATION_MS = 24 * 60 * 60 * 1000;
const LOCAL_INSTALL_KEY = `${EXTENSION_PREFIX}:installedAt`;

// Initialize ExtensionPay background handling once when the service worker starts.
const backgroundExtPay = ExtPay(EXTENSIONPAY_EXTENSION_ID);
backgroundExtPay.startBackground();

/**
 * Stores a fallback install timestamp when Chrome first installs the extension.
 *
 * @param {chrome.runtime.InstalledDetails} details - Chrome install/update metadata.
 */
function handleInstalled(details) {
  // Only first installs should start a new local fallback trial.
  if (details.reason !== "install") {
    return;
  }

  // Persist an install timestamp for local development and provider outages.
  chrome.storage.local.set({
    [LOCAL_INSTALL_KEY]: new Date().toISOString()
  });
}

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
 * @param {{type: string}} message - Namespaced paywall message.
 * @returns {Promise<Record<string, unknown>>} Serializable response payload.
 */
async function handlePaywallMessage(message) {
  // Recreate the client inside callbacks per ExtensionPay MV3 guidance.
  const extpay = createExtPayClient();

  // Expose the current access state to ChatGPT content scripts.
  if (message.type === `${EXTENSION_PREFIX}:getAccessState`) {
    return getAccessState(extpay);
  }

  // Open the one-time payment page for the configured plan.
  if (message.type === `${EXTENSION_PREFIX}:openPaymentPage`) {
    await extpay.openPaymentPage(EXTENSIONPAY_PLAN_NICKNAME);
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
 * Computes the current paid/trial/locked access state for quiz rendering.
 *
 * @param {{getUser: Function}} extpay - ExtensionPay client for this callback.
 * @returns {Promise<Record<string, unknown>>} Serializable paywall state.
 */
async function getAccessState(extpay) {
  // Ensure the local fallback install time exists before checking provider state.
  const fallbackInstalledAt = await ensureLocalInstalledAt();

  try {
    // Ask ExtensionPay for the account-backed paid and install status.
    const user = await extpay.getUser();
    const installedAt = normalizeDate(user.installedAt) || fallbackInstalledAt;
    const trialRemainingMs = getTrialRemainingMs(installedAt);

    // Paid accounts should always get full access.
    if (user.paid) {
      return createAccessResponse("paid", installedAt, trialRemainingMs, user);
    }

    // Unpaid users can use the extension during the first 24 hours.
    if (trialRemainingMs > 0) {
      return createAccessResponse("trial", installedAt, trialRemainingMs, user);
    }

    // After the trial ends, unpaid users must complete checkout or login.
    return createAccessResponse("locked", installedAt, 0, user);
  } catch (error) {
    // Provider failures still allow the local trial but do not unlock expired users.
    const trialRemainingMs = getTrialRemainingMs(fallbackInstalledAt);
    if (trialRemainingMs > 0) {
      return createAccessResponse("trial", fallbackInstalledAt, trialRemainingMs, null, error);
    }

    // Expired users need a retry/payment path when provider status is unavailable.
    return createAccessResponse("unknown", fallbackInstalledAt, 0, null, error);
  }
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
 * Ensures a local fallback install timestamp exists in Chrome storage.
 *
 * @returns {Promise<Date>} Stored or newly-created fallback install date.
 */
async function ensureLocalInstalledAt() {
  // Read the saved fallback timestamp from extension storage.
  const result = await chrome.storage.local.get(LOCAL_INSTALL_KEY);
  const existingDate = normalizeDate(result[LOCAL_INSTALL_KEY]);

  // Reuse valid stored dates to avoid resetting trials.
  if (existingDate) {
    return existingDate;
  }

  // Store a new timestamp if development loading skipped the install event.
  const installedAt = new Date();
  await chrome.storage.local.set({
    [LOCAL_INSTALL_KEY]: installedAt.toISOString()
  });

  // Return the fallback date used for this browser profile.
  return installedAt;
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
 * Calculates how much time remains in the 24-hour install trial.
 *
 * @param {Date} installedAt - First install timestamp.
 * @returns {number} Remaining trial time in milliseconds.
 */
function getTrialRemainingMs(installedAt) {
  // Clamp negative values to zero so expired trials are unambiguous.
  return Math.max(0, TRIAL_DURATION_MS - (Date.now() - installedAt.getTime()));
}

/**
 * Creates a serializable access-state response for content scripts.
 *
 * @param {string} status - Access status for UI gating.
 * @param {Date} installedAt - Install timestamp used for the decision.
 * @param {number} trialRemainingMs - Remaining trial time in milliseconds.
 * @param {{email?: string | null, paidAt?: Date | null} | null} user - Optional ExtensionPay user.
 * @param {unknown} [error] - Optional provider error.
 * @returns {Record<string, unknown>} Serializable access response.
 */
function createAccessResponse(status, installedAt, trialRemainingMs, user, error) {
  // Keep the response small and free of non-serializable Date objects.
  const response = {
    ok: !error,
    status,
    installedAt: installedAt.toISOString(),
    trialRemainingMs,
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

chrome.runtime.onInstalled.addListener(handleInstalled);
chrome.runtime.onMessage.addListener(handleRuntimeMessage);
