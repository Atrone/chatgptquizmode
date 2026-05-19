const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const BACKGROUND_SCRIPT_PATH = join(__dirname, "..", "background.js");
const BACKGROUND_SCRIPT_SOURCE = readFileSync(BACKGROUND_SCRIPT_PATH, "utf8");
const EXTENSION_PREFIX = "mcq-radio-extension";
const LOCAL_INSTALL_KEY = `${EXTENSION_PREFIX}:installedAt`;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Converts VM-created arrays and objects into this test file's realm.
 *
 * @param {unknown} value - Value returned from the background-script VM.
 * @returns {unknown} JSON-safe value with local prototypes.
 */
function toPlain(value) {
  // Unit assertions only compare serializable background payloads.
  return JSON.parse(JSON.stringify(value));
}

/**
 * Creates a Chrome API mock for background service-worker tests.
 *
 * @param {Record<string, unknown>} storage - Mutable storage backing object.
 * @returns {{chrome: Record<string, unknown>, installedListeners: Function[], messageListeners: Function[]}} Mocked Chrome API and listener captures.
 */
function createBackgroundChromeMock(storage) {
  // Capture listeners so tests can assert registration stays disabled in test mode.
  const installedListeners = [];
  const messageListeners = [];

  // Provide the storage and runtime pieces used by background.js.
  const chrome = {
    storage: {
      local: {
        async get(key) {
          // Return the same object shape as chrome.storage.local.get.
          return {
            [key]: storage[key]
          };
        },
        async set(values) {
          // Persist all values into the mutable backing object.
          Object.assign(storage, values);
        }
      }
    },
    runtime: {
      onInstalled: {
        addListener(listener) {
          // Save listener registrations for assertions.
          installedListeners.push(listener);
        }
      },
      onMessage: {
        addListener(listener) {
          // Save listener registrations for assertions.
          messageListeners.push(listener);
        }
      }
    }
  };

  // Return the mock API and listener arrays.
  return { chrome, installedListeners, messageListeners };
}

/**
 * Loads the background script in a VM with ExtensionPay and Chrome mocked.
 *
 * @param {{storage?: Record<string, unknown>, extpay?: Record<string, Function>}} options - Harness options.
 * @returns {{api: Record<string, Function>, storage: Record<string, unknown>, extpay: Record<string, Function>, installedListeners: Function[], messageListeners: Function[]}} Loaded harness.
 */
function loadBackgroundHarness(options = {}) {
  // Keep a mutable backing object for chrome.storage.local.
  const storage = options.storage || {};
  const chromeMock = createBackgroundChromeMock(storage);
  const extpay = options.extpay || {
    startBackground() {
      // No-op start hook for unit tests.
    },
    async getUser() {
      // Default to a paid user so generic message tests unlock cleanly.
      return {
        paid: true,
        installedAt: new Date(Date.now() - DAY_MS).toISOString(),
        email: "paid@example.com"
      };
    },
    async openPaymentPage() {
      // Mark payment page calls for assertions.
      extpay.openedPaymentPage = true;
    },
    async openLoginPage() {
      // Mark login page calls for assertions.
      extpay.openedLoginPage = true;
    }
  };
  const context = {
    console,
    Date,
    Error,
    Promise,
    String,
    Number,
    Object,
    importScripts() {
      // Avoid loading ExtensionPay from disk during unit tests.
    },
    ExtPay() {
      // Return the configured ExtensionPay mock for every client creation.
      return extpay;
    },
    chrome: chromeMock.chrome,
    __MCQ_RADIO_EXTENSION_ENABLE_TEST_API__: true
  };
  context.globalThis = context;

  // Execute the real background script and return its exposed helper API.
  vm.createContext(context);
  vm.runInContext(BACKGROUND_SCRIPT_SOURCE, context);
  return {
    api: context.__mcqRadioExtensionBackgroundTestApi,
    storage,
    extpay,
    installedListeners: chromeMock.installedListeners,
    messageListeners: chromeMock.messageListeners
  };
}

test("handles install events without resetting non-install profiles", async () => {
  // Load the background helpers and call the install handler directly.
  const { api, storage, installedListeners, messageListeners } = loadBackgroundHarness();
  assert.equal(installedListeners.length, 0);
  assert.equal(messageListeners.length, 0);

  // Non-install events should leave the fallback install key untouched.
  api.handleInstalled({ reason: "update" });
  assert.equal(storage[LOCAL_INSTALL_KEY], undefined);

  // First installs should persist an ISO timestamp.
  api.handleInstalled({ reason: "install" });
  assert.equal(Number.isNaN(new Date(storage[LOCAL_INSTALL_KEY]).getTime()), false);
});

test("routes runtime messages to access, payment, login, and unsupported responses", async () => {
  // Load a background harness with the default paid ExtensionPay mock.
  const { api, extpay } = loadBackgroundHarness();

  // Ignore unrelated messages without keeping the channel open.
  assert.equal(api.handleRuntimeMessage({ type: "other:message" }, {}, () => {}), undefined);

  // Valid paywall messages should resolve asynchronously through sendResponse.
  const accessResponse = await new Promise((resolve) => {
    const keepOpen = api.handleRuntimeMessage({ type: `${EXTENSION_PREFIX}:getAccessState` }, {}, resolve);
    assert.equal(keepOpen, true);
  });
  assert.equal(accessResponse.status, "paid");

  // Direct route tests verify payment and login action side effects.
  assert.deepEqual(toPlain(await api.handlePaywallMessage({ type: `${EXTENSION_PREFIX}:openPaymentPage` })), { ok: true });
  assert.equal(extpay.openedPaymentPage, true);
  assert.deepEqual(toPlain(await api.handlePaywallMessage({ type: `${EXTENSION_PREFIX}:openLoginPage` })), { ok: true });
  assert.equal(extpay.openedLoginPage, true);
  assert.deepEqual(toPlain(await api.handlePaywallMessage({ type: `${EXTENSION_PREFIX}:unknown` })), {
    ok: false,
    status: "unknown",
    error: "Unsupported paywall message."
  });
});

test("computes paid, trial, locked, and provider-failure access states", async () => {
  // Paid users should remain unlocked even after the trial window.
  const paidHarness = loadBackgroundHarness({
    storage: { [LOCAL_INSTALL_KEY]: new Date(Date.now() - 2 * DAY_MS).toISOString() }
  });
  const paid = await paidHarness.api.getAccessState({
    async getUser() {
      // Return an expired paid user to verify payment takes precedence.
      return {
        paid: true,
        installedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
        email: "paid@example.com",
        paidAt: new Date().toISOString()
      };
    }
  });
  assert.equal(paid.status, "paid");
  assert.equal(paid.email, "paid@example.com");

  // Recent unpaid installs should receive trial access.
  const trialHarness = loadBackgroundHarness({
    storage: { [LOCAL_INSTALL_KEY]: new Date(Date.now() - 60 * 60 * 1000).toISOString() }
  });
  const trial = await trialHarness.api.getAccessState({
    async getUser() {
      // Return an unpaid user within the trial window.
      return {
        paid: false,
        installedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
      };
    }
  });
  assert.equal(trial.status, "trial");
  assert.equal(trial.trialRemainingMs > 0, true);

  // Expired unpaid installs should be locked.
  const lockedHarness = loadBackgroundHarness({
    storage: { [LOCAL_INSTALL_KEY]: new Date(Date.now() - 2 * DAY_MS).toISOString() }
  });
  const locked = await lockedHarness.api.getAccessState({
    async getUser() {
      // Return an unpaid user beyond the trial window.
      return {
        paid: false,
        installedAt: new Date(Date.now() - 2 * DAY_MS).toISOString()
      };
    }
  });
  assert.equal(locked.status, "locked");

  // Provider failures allow active local trials but unknown-lock expired installs.
  const failureTrialHarness = loadBackgroundHarness({
    storage: { [LOCAL_INSTALL_KEY]: new Date(Date.now() - 60 * 60 * 1000).toISOString() }
  });
  const failureTrial = await failureTrialHarness.api.getAccessState({
    async getUser() {
      // Throw to simulate ExtensionPay being unavailable.
      throw new Error("provider down");
    }
  });
  assert.equal(failureTrial.status, "trial");
  assert.equal(failureTrial.ok, false);

  const failureExpiredHarness = loadBackgroundHarness({
    storage: { [LOCAL_INSTALL_KEY]: new Date(Date.now() - 2 * DAY_MS).toISOString() }
  });
  const failureExpired = await failureExpiredHarness.api.getAccessState({
    async getUser() {
      // Throw to simulate ExtensionPay being unavailable after trial expiry.
      throw new Error("provider down");
    }
  });
  assert.equal(failureExpired.status, "unknown");
  assert.equal(failureExpired.error, "provider down");
});

test("normalizes dates, trial math, and serializable responses", async () => {
  // Load the helper API for pure background utility functions.
  const { api, storage } = loadBackgroundHarness();
  const now = Date.now();
  const oldDate = new Date(now - 5000);
  const newDate = new Date(now);

  // Date helpers should reject invalid input and choose the earliest valid date.
  assert.equal(api.normalizeDate("not a date"), null);
  assert.equal(api.normalizeDate(oldDate).toISOString(), oldDate.toISOString());
  assert.equal(api.getEarliestDate(newDate, oldDate).toISOString(), oldDate.toISOString());
  assert.equal(api.getTrialRemainingMs(new Date(now - 2 * DAY_MS)), 0);

  // Missing local install timestamps should be created once and then reused.
  const installedAt = await api.ensureLocalInstalledAt();
  assert.equal(storage[LOCAL_INSTALL_KEY], installedAt.toISOString());
  const reusedInstalledAt = await api.ensureLocalInstalledAt();
  assert.equal(reusedInstalledAt.toISOString(), installedAt.toISOString());

  // Response helpers should produce serializable payloads for the content script.
  const accessResponse = api.createAccessResponse("paid", oldDate, 123, {
    email: "user@example.com",
    paidAt: newDate
  });
  assert.deepEqual(toPlain(accessResponse), {
    ok: true,
    status: "paid",
    installedAt: oldDate.toISOString(),
    trialRemainingMs: 123,
    email: "user@example.com",
    paidAt: newDate.toISOString()
  });
  assert.deepEqual(toPlain(api.createErrorResponse(new Error("bad"))), {
    ok: false,
    status: "unknown",
    error: "bad"
  });
  assert.equal(api.getErrorMessage(null), "Payment status is unavailable.");
});
