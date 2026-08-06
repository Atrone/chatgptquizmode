globalThis.McqQuiz = globalThis.McqQuiz || {};

/**
 * Creates conversation-scoped selection persistence helpers.
 *
 * @param {{EXTENSION_PREFIX: string, CONTEXT_ELEMENT_ID: string}} config - Shared persistence configuration.
 * @returns {Record<string, Function>} Selection persistence service.
 */
globalThis.McqQuiz.createPersistence = function createPersistence(config) {
  // Keep storage naming private while sharing scoring at event time.
  const services = globalThis.McqQuiz.services;
  const { EXTENSION_PREFIX, CONTEXT_ELEMENT_ID } = config;
  /**
   * Stores selected radio or checkbox inputs in conversation-scoped extension state.
   *
   * @param {Event} event - Change event from an answer input.
   */
  async function handleOptionChange(event) {
    // Guard against unexpected events from non-input elements.
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    // Read the existing conversation selections from Chrome storage.
    const selections = await readSelections();
    const quizId = input.dataset.quizId || "";
    const questionIndex = input.dataset.questionIndex || "0";
    const isSata = input.dataset.isSata === "true";

    // Ensure the quiz entry exists before saving the selected answer.
    if (!selections[quizId]) {
      selections[quizId] = {};
    }

    // Store SATA answers as arrays and regular MCQ answers as a single letter.
    if (isSata) {
      const question = input.closest(`.${EXTENSION_PREFIX}-question`);
      selections[quizId][questionIndex] = question ? services.scoring.getSelectedLetters(question) : [];
    } else {
      selections[quizId][questionIndex] = input.value;
    }

    // Persist and mirror the selections into the page-level hidden context element.
    await writeSelections(selections);
    updateConversationContext(selections);
  }

  /**
   * Reads stored selections for the current ChatGPT conversation URL.
   *
   * @returns {Promise<Record<string, Record<string, string>>>} Stored selections.
   */
  async function readSelections() {
    // Build a storage key scoped to the current conversation path.
    const key = getStorageKey();
    const result = await chrome.storage.local.get(key);

    // Return an object even when the conversation has no saved choices yet.
    return result[key] || {};
  }

  /**
   * Writes stored selections for the current ChatGPT conversation URL.
   *
   * @param {Record<string, Record<string, string>>} selections - Selection state to persist.
   */
  async function writeSelections(selections) {
    // Save under the same conversation-scoped key used for reading.
    const key = getStorageKey();
    await chrome.storage.local.set({
      [key]: selections
    });
  }

  /**
   * Creates a storage key for the active ChatGPT conversation.
   *
   * @returns {string} Conversation-scoped storage key.
   */
  function getStorageKey() {
    // The path includes ChatGPT's conversation id for normal chat URLs.
    return `${EXTENSION_PREFIX}:${location.origin}${location.pathname}`;
  }

  /**
   * Mirrors saved selections into a hidden DOM node on the conversation page.
   *
   * @param {Record<string, Record<string, string>>} selections - Selection state to mirror.
   */
  function updateConversationContext(selections) {
    // Reuse a single hidden context node so the page has one source of truth.
    let context = document.getElementById(CONTEXT_ELEMENT_ID);

    // Create the hidden context node if it does not exist yet.
    if (!context) {
      context = document.createElement("div");
      context.id = CONTEXT_ELEMENT_ID;
      context.className = `${EXTENSION_PREFIX}-context`;
      context.setAttribute("aria-hidden", "true");
      document.body.appendChild(context);
    }

    // Store the conversation-scoped selections as JSON for page-level context.
    context.dataset.storageKey = getStorageKey();
    context.textContent = JSON.stringify(selections);
  }

  // Expose persistence helpers through the namespace service registry.
  return {
    handleOptionChange,
    readSelections,
    writeSelections,
    getStorageKey,
    updateConversationContext
  };
};