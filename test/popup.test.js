const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const POPUP_SCRIPT_SOURCE = readFileSync(join(__dirname, "..", "popup.js"), "utf8");
const ENABLED_STORAGE_KEY = "mcq-radio-extension:enabled";

/**
 * Loads the popup script with a mutable Chrome storage mock.
 *
 * @param {{storedValue?: boolean, setError?: Error}} options - Popup harness behavior.
 * @returns {{window: Window, document: Document, storage: Record<string, unknown>, api: Record<string, Function>}} Loaded popup harness.
 */
async function loadPopupHarness(options = {}) {
  // Create only the elements required by the production popup script.
  const dom = new JSDOM(`<!doctype html><body>
    <input id="extension-enabled" type="checkbox">
    <p id="status"></p>
  </body>`, {
    url: "https://extension-popup.test/",
    runScripts: "outside-only"
  });
  const storage = {};
  if (Object.hasOwn(options, "storedValue")) {
    storage[ENABLED_STORAGE_KEY] = options.storedValue;
  }

  // Match the promise-based Chrome storage API used by the popup.
  dom.window.chrome = {
    storage: {
      local: {
        async get(key) {
          // Return the requested setting in Chrome's keyed result shape.
          return { [key]: storage[key] };
        },
        async set(values) {
          // Simulate write failures when requested by a test.
          if (options.setError) {
            throw options.setError;
          }
          Object.assign(storage, values);
        }
      }
    }
  };

  // Export lexical popup helpers from the same evaluated script for direct unit tests.
  dom.getInternalVMContext().eval(`${POPUP_SCRIPT_SOURCE}
    globalThis.__popupTestApi = { loadEnabledState, handleToggleChange, updateStatus };`);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  return {
    window: dom.window,
    document: dom.window.document,
    storage,
    api: dom.window.__popupTestApi
  };
}

/**
 * Verifies missing and false settings load into the expected popup state.
 */
test("loads enabled popup state and defaults missing settings to on", async () => {
  // Missing settings preserve the extension's default-enabled behavior.
  const defaultHarness = await loadPopupHarness();
  assert.equal(defaultHarness.document.getElementById("extension-enabled").checked, true);
  assert.equal(defaultHarness.document.getElementById("status").textContent, "Quiz mode is on.");

  // An explicitly disabled setting must remain disabled when the popup opens.
  const disabledHarness = await loadPopupHarness({ storedValue: false });
  assert.equal(disabledHarness.document.getElementById("extension-enabled").checked, false);
  assert.equal(disabledHarness.document.getElementById("status").textContent, "Quiz mode is off.");
});

/**
 * Verifies toggle changes persist and update visible status copy.
 */
test("persists popup toggle changes", async () => {
  // Change the loaded control and invoke the production change handler.
  const { document, storage, api } = await loadPopupHarness({ storedValue: false });
  const toggle = document.getElementById("extension-enabled");
  toggle.checked = true;
  await api.handleToggleChange();

  assert.equal(storage[ENABLED_STORAGE_KEY], true);
  assert.equal(toggle.disabled, false);
  assert.equal(document.getElementById("status").textContent, "Quiz mode is on.");
});

/**
 * Verifies failed writes still restore interaction and direct status updates work.
 */
test("restores the popup toggle after storage failures", async () => {
  // Reject the storage write to exercise the handler's finally branch.
  const { document, api } = await loadPopupHarness({
    storedValue: true,
    setError: new Error("storage failed")
  });
  const toggle = document.getElementById("extension-enabled");
  await assert.rejects(api.handleToggleChange(), /storage failed/);
  assert.equal(toggle.disabled, false);

  // Exercise both direct status-message branches.
  api.updateStatus(false);
  assert.equal(document.getElementById("status").textContent, "Quiz mode is off.");
  api.updateStatus(true);
  assert.equal(document.getElementById("status").textContent, "Quiz mode is on.");
});
