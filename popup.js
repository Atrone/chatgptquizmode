const ENABLED_STORAGE_KEY = "mcq-radio-extension:enabled";
const enabledToggle = document.getElementById("extension-enabled");
const status = document.getElementById("status");

/**
 * Loads the persisted extension state into the popup switch.
 *
 * @returns {Promise<void>} Resolves after the popup reflects saved state.
 */
async function loadEnabledState() {
  // Keep existing and new installs enabled until a user explicitly turns them off.
  const stored = await chrome.storage.local.get(ENABLED_STORAGE_KEY);
  enabledToggle.checked = stored[ENABLED_STORAGE_KEY] !== false;
  updateStatus(enabledToggle.checked);
}

/**
 * Persists the state selected in the popup.
 *
 * @returns {Promise<void>} Resolves after Chrome storage is updated.
 */
async function handleToggleChange() {
  // Disable the switch briefly so rapid clicks cannot race storage writes.
  enabledToggle.disabled = true;
  try {
    // Content scripts receive this storage change and apply it without a refresh.
    await chrome.storage.local.set({
      [ENABLED_STORAGE_KEY]: enabledToggle.checked
    });
    updateStatus(enabledToggle.checked);
  } finally {
    // Restore interaction after either a successful or failed storage request.
    enabledToggle.disabled = false;
  }
}

/**
 * Updates the concise state message below the switch.
 *
 * @param {boolean} isEnabled - Whether quiz mode is currently enabled.
 */
function updateStatus(isEnabled) {
  // Confirm whether ChatGPT pages will be modified.
  status.textContent = isEnabled ? "Quiz mode is on." : "Quiz mode is off.";
}

// Save every user-initiated switch change.
enabledToggle.addEventListener("change", handleToggleChange);

// Populate the popup from Chrome storage when it opens.
loadEnabledState();
