globalThis.McqQuiz = globalThis.McqQuiz || {};

/**
 * Creates trial and payment-access helpers for the content script.
 *
 * @param {{EXTENSION_PREFIX: string, ACCESS_CACHE_DURATION_MS: number}} config - Shared access configuration.
 * @returns {Record<string, Function>} Access and paywall service.
 */
globalThis.McqQuiz.createAccess = function createAccess(config) {
  // Keep access cache state private to the paywall service.
  const services = globalThis.McqQuiz.services;
  const { EXTENSION_PREFIX, ACCESS_CACHE_DURATION_MS } = config;
  let accessStateCache = null;
  /**
   * Handles payment, login, and retry actions from the paywall panel.
   *
   * @param {Event} event - Click event from a paywall button.
   */
  async function handlePaywallAction(event) {
    // Guard against unexpected event targets.
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    // Locate the surrounding paywall and status region for feedback.
    const paywall = button.closest(`.${EXTENSION_PREFIX}-paywall`);
    const status = paywall?.querySelector(`.${EXTENSION_PREFIX}-paywall-status`);
    const action = button.dataset.paywallAction || "";

    // Disable only the clicked action while the background request is running.
    button.disabled = true;
    setPaywallStatus(status, "Checking payment status...");

    try {
      // Retry requests should immediately re-check and rebuild the locked output.
      if (action === "refreshAccessState") {
        clearAccessStateCache();
        await services.entry.refreshPaywallRoot(paywall?.closest('[data-message-author-role="assistant"]') || null);
        return;
      }

      // Payment and login actions are delegated to the background service worker.
      const response = await sendPaywallMessage(action);
      if (!response?.ok) {
        throw new Error(response?.error || "Unable to open the payment page.");
      }

      // Tell users to finish the provider flow in the newly opened tab.
      setPaywallStatus(status, "A new tab opened. Finish payment or login there, then return to this page.");
    } catch (error) {
      // Show concise failures without exposing stack traces.
      setPaywallStatus(status, getErrorMessage(error));
    } finally {
      // Re-enable the clicked action for retries.
      button.disabled = false;
    }
  }

  /**
   * Reads the current paid/trial/locked state from the background worker.
   *
   * @param {boolean} shouldBypassCache - Whether to force a provider recheck.
   * @returns {Promise<{ok?: boolean, status?: string, trialRemainingMs?: number, error?: string}>} Access state.
   */
  async function readAccessState(shouldBypassCache) {
    // Reuse recent status checks so multiple visible quizzes do not spam the provider.
    if (!shouldBypassCache && accessStateCache && Date.now() - accessStateCache.createdAt < ACCESS_CACHE_DURATION_MS) {
      return accessStateCache.value;
    }

    try {
      // Ask the background worker because ExtensionPay owns the MV3 service worker.
      const response = await sendPaywallMessage("getAccessState");
      const accessState = response || {
        ok: false,
        status: "unknown",
        trialRemainingMs: 0
      };

      // Cache the normalized response for nearby assistant outputs.
      accessStateCache = {
        createdAt: Date.now(),
        value: accessState
      };

      // Return the provider-backed access state.
      return accessState;
    } catch (error) {
      // Surface background failures as an unknown state so expired trials stay gated.
      const accessState = {
        ok: false,
        status: "unknown",
        trialRemainingMs: 0,
        error: getErrorMessage(error)
      };

      // Cache the failure briefly to avoid repeated runtime errors.
      accessStateCache = {
        createdAt: Date.now(),
        value: accessState
      };

      // Return the safe locked/unknown state.
      return accessState;
    }
  }

  /**
   * Sends one paywall message to the extension background worker.
   *
   * @param {string} action - Paywall action without the extension prefix.
   * @returns {Promise<Record<string, any>>} Background response.
   */
  function sendPaywallMessage(action) {
    // Reject immediately when the runtime API is unavailable.
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      return Promise.reject(new Error("Extension runtime is unavailable."));
    }

    // Wrap Chrome's callback API so callers can await the response.
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: `${EXTENSION_PREFIX}:${action}`
        },
        (response) => {
          // Convert Chrome runtime failures into normal promise rejections.
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }

          // Resolve with the background response for normal handling.
          resolve(response || {});
        }
      );
    });
  }

  /**
   * Determines whether the access state should block quiz controls.
   *
   * @param {{status?: string}} accessState - Current access state.
   * @returns {boolean} True when the paywall should be shown.
   */
  function isAccessLocked(accessState) {
    // Only paid and active-trial users can reach the quiz UI.
    return accessState?.status !== "paid" && accessState?.status !== "trial";
  }

  /**
   * Clears the short-lived access-state cache.
   */
  function clearAccessStateCache() {
    // Force the next access check to call the background provider flow.
    accessStateCache = null;
  }

  /**
   * Updates a paywall status region if it exists.
   *
   * @param {Element | null | undefined} status - Status element to update.
   * @param {string} message - Message to display.
   */
  function setPaywallStatus(status, message) {
    // Ignore missing panels from stale DOM events.
    if (!status) {
      return;
    }

    // Write plain text so provider errors cannot inject markup.
    status.textContent = message;
  }

  /**
   * Formats remaining trial time for compact user-facing copy.
   *
   * @param {number} remainingMs - Remaining trial time in milliseconds.
   * @returns {string} Human-readable remaining time.
   */
  function formatTrialRemaining(remainingMs) {
    // Round up so users do not see zero until the trial has actually expired.
    const minutes = Math.max(1, Math.ceil(remainingMs / 60000));

    // Prefer hours for most of the 24-hour trial window.
    if (minutes >= 60) {
      const hours = Math.ceil(minutes / 60);
      return `${hours} ${hours === 1 ? "hour" : "hours"}`;
    }

    // Use minutes near the end of the trial.
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  /**
   * Extracts a message from unknown error values.
   *
   * @param {unknown} error - Error-like value.
   * @returns {string} Readable error message.
   */
  function getErrorMessage(error) {
    // Prefer Error.message when available.
    if (error instanceof Error) {
      return error.message;
    }

    // Fall back to string conversion for Chrome runtime errors.
    return String(error || "Payment status is unavailable.");
  }

  // Expose access helpers without adding separate page globals.
  return {
    handlePaywallAction,
    readAccessState,
    sendPaywallMessage,
    isAccessLocked,
    clearAccessStateCache,
    setPaywallStatus,
    formatTrialRemaining,
    getErrorMessage
  };
};