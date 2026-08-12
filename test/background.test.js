const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const BACKGROUND_SCRIPT_PATH = join(__dirname, "..", "background.js");
const BACKGROUND_SCRIPT_SOURCE = readFileSync(BACKGROUND_SCRIPT_PATH, "utf8");
const EXTENSION_PREFIX = "mcq-radio-extension";
const FREE_QUIZ_KEY = `${EXTENSION_PREFIX}:freeQuizId`;
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

test("claims one free quiz and preserves it across checks", async () => {
  // Load the background helpers with empty local storage.
  const { api, storage, installedListeners, messageListeners } = loadBackgroundHarness();
  assert.equal(installedListeners.length, 0);
  assert.equal(messageListeners.length, 0);

  // Simultaneous identifiers must still produce exactly one successful claim.
  const simultaneousClaims = await Promise.all([
    api.claimFreeQuiz("quiz-one"),
    api.claimFreeQuiz("quiz-two")
  ]);
  assert.deepEqual(simultaneousClaims, [true, false]);
  assert.equal(storage[FREE_QUIZ_KEY], "quiz-one");

  // The first identifier is reusable while every different quiz is rejected.
  assert.equal(await api.claimFreeQuiz("quiz-one"), true);
  assert.equal(await api.claimFreeQuiz("quiz-two"), false);
  assert.equal(await api.claimFreeQuiz(""), false);
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

test("computes paid, free, locked, and provider-failure access states", async () => {
  // Paid users should remain unlocked without consuming a free quiz.
  const paidHarness = loadBackgroundHarness();
  const paid = await paidHarness.api.getAccessState({
    async getUser() {
      // Return a paid user to verify payment takes precedence.
      return {
        paid: true,
        email: "paid@example.com",
        paidAt: new Date().toISOString()
      };
    }
  }, "paid-quiz");
  assert.equal(paid.status, "paid");
  assert.equal(paid.email, "paid@example.com");
  assert.equal(paidHarness.storage[FREE_QUIZ_KEY], undefined);

  // The first unpaid quiz should claim free access.
  const freeHarness = loadBackgroundHarness();
  const free = await freeHarness.api.getAccessState({
    async getUser() {
      // Return an unpaid user for the local quiz claim.
      return { paid: false };
    }
  }, "quiz-one");
  assert.equal(free.status, "free");
  assert.equal(freeHarness.storage[FREE_QUIZ_KEY], "quiz-one");

  // A different unpaid quiz should be locked after the claim.
  const lockedHarness = loadBackgroundHarness({
    storage: { [FREE_QUIZ_KEY]: "quiz-one" }
  });
  const locked = await lockedHarness.api.getAccessState({
    async getUser() {
      // Return an unpaid user after the free quiz was claimed.
      return { paid: false };
    }
  }, "quiz-two");
  assert.equal(locked.status, "locked");

  // Provider failures allow the free quiz but unknown-lock every other quiz.
  const failureFreeHarness = loadBackgroundHarness();
  const failureFree = await failureFreeHarness.api.getAccessState({
    async getUser() {
      // Throw to simulate ExtensionPay being unavailable.
      throw new Error("provider down");
    }
  }, "quiz-one");
  assert.equal(failureFree.status, "free");
  assert.equal(failureFree.ok, false);

  const failureLockedHarness = loadBackgroundHarness({
    storage: { [FREE_QUIZ_KEY]: "quiz-one" }
  });
  const failureLocked = await failureLockedHarness.api.getAccessState({
    async getUser() {
      // Throw to simulate ExtensionPay being unavailable after free use.
      throw new Error("provider down");
    }
  }, "quiz-two");
  assert.equal(failureLocked.status, "unknown");
  assert.equal(failureLocked.error, "provider down");
});

test("normalizes dates and creates serializable access responses", async () => {
  // Load the helper API for pure background utility functions.
  const { api } = loadBackgroundHarness();
  const newDate = new Date();

  // Date normalization should reject invalid input and preserve valid dates.
  assert.equal(api.normalizeDate("not a date"), null);
  assert.equal(api.normalizeDate(newDate).toISOString(), newDate.toISOString());

  // Response helpers should produce serializable payloads for the content script.
  const accessResponse = api.createAccessResponse("paid", {
    email: "user@example.com",
    paidAt: newDate
  });
  assert.deepEqual(toPlain(accessResponse), {
    ok: true,
    status: "paid",
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

/**
 * Verifies malformed messages and asynchronous provider failures are handled safely.
 */
test("rejects malformed runtime messages and serializes route failures", async () => {
  // Configure payment opening to fail after the runtime route accepts the message.
  const extpay = {
    startBackground() {
      // Keep service-worker startup inert in the test harness.
    },
    async getUser() {
      // Return a paid user for unrelated access-state behavior.
      return { paid: true, installedAt: new Date().toISOString() };
    },
    async openPaymentPage() {
      // Simulate a provider failure from the checkout action.
      throw new Error("checkout unavailable");
    },
    async openLoginPage() {
      // Keep the login action available for the client shape.
    }
  };
  const { api } = loadBackgroundHarness({ extpay });

  assert.equal(api.handleRuntimeMessage(null, {}, () => {}), undefined);
  assert.equal(api.handleRuntimeMessage({ type: 42 }, {}, () => {}), undefined);

  const response = await new Promise((resolve) => {
    // Exercise the runtime handler's rejected-route catch branch.
    const keepOpen = api.handleRuntimeMessage({
      type: `${EXTENSION_PREFIX}:openPaymentPage`
    }, {}, resolve);
    assert.equal(keepOpen, true);
  });
  assert.deepEqual(toPlain(response), {
    ok: false,
    status: "unknown",
    error: "checkout unavailable"
  });
});

/**
 * Verifies ExtensionPay client creation and date helper edge cases.
 */
test("creates provider clients and rejects malformed free quiz ids", async () => {
  // Use a complete provider mock so client creation can be compared by identity.
  const { api, extpay } = loadBackgroundHarness();
  assert.equal(api.createExtPayClient(), extpay);

  // Normalize supported date values and reject missing quiz identifiers.
  assert.equal(api.normalizeDate("2026-02-03T04:05:06.000Z").toISOString(), "2026-02-03T04:05:06.000Z");
  assert.equal(api.normalizeDate(undefined), null);
  assert.equal(await api.claimFreeQuiz(null), false);
  assert.equal(await api.claimFreeQuiz("   "), false);
});

/**
 * Verifies response fallbacks serialize without provider account details.
 */
test("normalizes access response fallbacks", async () => {
  // Build an errored free response with empty and invalid account fields.
  const { api } = loadBackgroundHarness();
  const response = api.createAccessResponse("free", {
    email: "",
    paidAt: "invalid"
  }, "provider warning");
  assert.deepEqual(toPlain(response), {
    ok: false,
    status: "free",
    email: null,
    paidAt: null,
    error: "provider warning"
  });
  assert.deepEqual(toPlain(api.createErrorResponse("plain error")), {
    ok: false,
    status: "unknown",
    error: "plain error"
  });
});
