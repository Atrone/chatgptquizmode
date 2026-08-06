(function initializeMcqRadioExtension() {
  // Keep all extension-owned DOM identifiers in one place.
  const EXTENSION_PREFIX = "mcq-radio-extension";
  const PROCESSED_ATTRIBUTE = "data-mcq-radio-extension-processed";
  const QUIZ_ATTRIBUTE = "data-mcq-radio-extension-quiz-id";
  const ORIGINAL_OUTPUT_ATTRIBUTE = "data-mcq-radio-extension-original-output";
  const CONTEXT_ELEMENT_ID = "mcq-radio-extension-conversation-context";
  const ENABLED_STORAGE_KEY = `${EXTENSION_PREFIX}:enabled`;
  const STREAM_IDLE_DELAY_MS = 1200;
  const ACCESS_CACHE_DURATION_MS = 30000;
  const OPTION_PATTERN = /^(?:(?:[-*•▪◦‣]|\d+[\.\)])\s*)?(?:(?:option|choice)\s+)?(?:\(([A-Z])\)|\[([A-Z])\]|([A-Z])\s*(?:[\.\):\-–—|]|\t+))\s*(.+)$/i;
  const SATA_PATTERN = /\b(?:sata|select all that apply|choose all that apply|multiple response|multi-select|multiple select)\b/i;
  const INLINE_STOP_PATTERN = /\s+(?:rationale|explanation|ordered response|correct order|next steps|answer key|answers?)\s*[:\-—]/i;
  const ANSWER_RATIONALE_LABEL_PATTERN = /^\s*(?:[✅✔☑]\s*)?(?:correct\s+)?answer(?:\(s\)|s)?\s*(?:and|with|&|\/)\s*rationales?\b/i;
  const ANSWER_PATTERNS = [
    /^\s*(?:[✅✔☑]\s*)?(?:correct\s+)?answer(?:\(s\)|s)?\s*(?:and|with|&|\/)\s*rationales?\s*(?::|\-|–|—)\s*(?:choice|option)?\s*[\(\[]?[A-Z]\b.*$/i,
    /^\s*(?:[✅✔☑]\s*)?(?:answer(?:\(s\)|s)?|correct answer(?:s)?|correct option(?:s)?|correct choice(?:s)?|best answer|solution|key)\s*(?::|\-|–|—|\bis\b|\bare\b)\s*(?:choice|option)?\s*[\(\[]?[A-Z]\b.*$/i,
    /^\s*(?:[✅✔☑]\s*)?(?:the\s+)?(?:correct|best)?\s*answers?\s+(?:is|are)\s+(?:choice|option)?\s*[\(\[]?[A-Z]\b.*$/i,
    /^\s*(?:answers|answer key)\s*[:\-–—]\s*(?:(?:question\s*)?[0-9]+\s*[\.\):\-]?\s*)?[A-Z](?:\s*(?:,|;|and|&|\/)\s*(?:(?:question\s*)?[0-9]+\s*[\.\):\-]?\s*)?[A-Z])*\s*\.?\s*$/i
  ];

  // Track parsed roots so rapid streaming mutations do not duplicate widgets.
  const processedRoots = new WeakSet();
  const processingRoots = new WeakSet();
  const pendingProcessingTimers = new WeakMap();
  let extensionEnabled = true;
  let pageObserver = null;


  // Build ordered services from factories loaded before this entrypoint.
  const McqQuiz = globalThis.McqQuiz;
  const services = McqQuiz.services;
  services.parser = McqQuiz.createParser({
    OPTION_PATTERN,
    SATA_PATTERN,
    INLINE_STOP_PATTERN,
    ANSWER_RATIONALE_LABEL_PATTERN,
    ANSWER_PATTERNS
  });
  services.access = McqQuiz.createAccess({ EXTENSION_PREFIX, ACCESS_CACHE_DURATION_MS });
  services.persistence = McqQuiz.createPersistence({ EXTENSION_PREFIX, CONTEXT_ELEMENT_ID });
  services.scoring = McqQuiz.createScoring({ EXTENSION_PREFIX });
  services.ui = McqQuiz.createUi({ EXTENSION_PREFIX, QUIZ_ATTRIBUTE, ORIGINAL_OUTPUT_ATTRIBUTE });
  services.entry = { refreshPaywallRoot };

  // Keep orchestration readable with local aliases to service methods.
  const { parseMultipleChoiceQuestions } = services.parser;
  const {
    hideAnswerLines,
    restoreAnswerLines,
    hideOriginalOutput,
    restoreOriginalOutput,
    createQuizId,
    buildQuizElement,
    buildPaywallElement
  } = services.ui;
  const { readAccessState, isAccessLocked, clearAccessStateCache } = services.access;
  const { readSelections, updateConversationContext } = services.persistence;

  /**
   * Initializes the extension from its persisted popup setting.
   *
   * @returns {Promise<void>} Resolves after the current setting is applied.
   */
  async function initialize() {
    // Treat a missing setting as enabled to preserve existing install behavior.
    const stored = await chrome.storage.local.get(ENABLED_STORAGE_KEY);
    extensionEnabled = stored[ENABLED_STORAGE_KEY] !== false;

    // Apply the saved state before scanning any ChatGPT output.
    if (extensionEnabled) {
      start();
    } else {
      stop();
    }

    // React immediately when the user changes the switch in the popup.
    chrome.storage.onChanged.addListener(handleStorageChange);
  }

  /**
   * Starts the extension once the ChatGPT page is ready enough to observe.
   */
  function start() {
    // Avoid registering duplicate observers and page event listeners.
    if (pageObserver) {
      return;
    }

    // Parse anything already visible when the content script loads.
    scanPageForMcqOutputs();

    // Watch future streamed responses and route changes in the single-page app.
    pageObserver = new MutationObserver(handleMutations);
    pageObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Refresh gated outputs after users return from checkout or login tabs.
    window.addEventListener("focus", refreshAccessGatedOutputs);
    document.addEventListener("visibilitychange", refreshAccessGatedOutputs);
  }

  /**
   * Stops page processing and restores ChatGPT's original output.
   */
  function stop() {
    // Disconnect observation so disabled mode does not alter future responses.
    pageObserver?.disconnect();
    pageObserver = null;
    window.removeEventListener("focus", refreshAccessGatedOutputs);
    document.removeEventListener("visibilitychange", refreshAccessGatedOutputs);

    // Cancel delayed processing that was scheduled while the extension was enabled.
    for (const root of document.querySelectorAll('[data-message-author-role="assistant"]')) {
      const timer = pendingProcessingTimers.get(root);
      if (timer) {
        window.clearTimeout(timer);
        pendingProcessingTimers.delete(root);
      }

      // Remove generated controls and restore every extension-hidden source node.
      removeExistingQuiz(root);
      restoreAnswerLines(root);
      root.removeAttribute(PROCESSED_ATTRIBUTE);
      processedRoots.delete(root);
    }

    // Remove the hidden selection mirror owned by the extension.
    document.getElementById(CONTEXT_ELEMENT_ID)?.remove();
  }

  /**
   * Applies popup setting changes to the active ChatGPT tab.
   *
   * @param {Record<string, chrome.storage.StorageChange>} changes - Changed storage values.
   * @param {string} areaName - Chrome storage area that emitted the update.
   */
  function handleStorageChange(changes, areaName) {
    // Ignore unrelated keys and storage areas.
    if (areaName !== "local" || !changes[ENABLED_STORAGE_KEY]) {
      return;
    }

    // The extension defaults to enabled unless the popup explicitly stores false.
    extensionEnabled = changes[ENABLED_STORAGE_KEY].newValue !== false;
    if (extensionEnabled) {
      start();
    } else {
      stop();
    }
  }

  /**
   * Handles ChatGPT DOM updates and reparses assistant messages as needed.
   *
   * @param {MutationRecord[]} mutations - Browser mutation records from ChatGPT.
   */
  function handleMutations(mutations) {
    // Collect roots first so one animation frame's mutations share one render delay.
    const changedRoots = new Set();

    // Reset processed markers for edited assistant outputs that are still streaming.
    for (const mutation of mutations) {
      // Ignore mutations caused by the extension's own controls or context mirror.
      if (isExtensionMutation(mutation)) {
        continue;
      }

      // Only text or child changes can affect parsed MCQ content.
      const target = mutation.target;
      const root = findAssistantRoot(target);

      // Ignore page updates outside assistant message output.
      if (!root) {
        continue;
      }

      // Defer visible extension rendering until this output stops changing.
      changedRoots.add(root);

      // Allow the next scan to rebuild a widget when ChatGPT changes a response.
      if (root.hasAttribute(PROCESSED_ATTRIBUTE)) {
        removeExistingQuiz(root, false);
        root.removeAttribute(PROCESSED_ATTRIBUTE);
        processedRoots.delete(root);
      }

      // Once the partial text is recognizable as an MCQ, keep source output hidden.
      if (hasRenderableMcqContent(root)) {
        const placeholder = ensureStreamingPlaceholder(root);
        hideOriginalOutput(root, placeholder);
      }
    }

    // Restart the idle timer for every assistant output that changed.
    for (const root of changedRoots) {
      scheduleAssistantRootProcessing(root);
    }

    // Debounce through the browser event queue so related mutations settle.
    window.requestAnimationFrame(scanPageForMcqOutputs);
  }

  /**
   * Finds assistant response nodes that may contain multiple-choice output.
   */
  function scanPageForMcqOutputs() {
    // Prefer the explicit author-role marker ChatGPT includes on message content.
    const assistantRoots = document.querySelectorAll('[data-message-author-role="assistant"]');

    // Process each assistant output independently so choices are grouped by response.
    for (const root of assistantRoots) {
      // Streaming roots are handled by their quiet-period timer instead.
      if (pendingProcessingTimers.has(root)) {
        continue;
      }

      processAssistantRoot(root);
    }
  }

  /**
   * Schedules assistant output processing after streaming mutations go quiet.
   *
   * @param {Element} root - Assistant message content root.
   */
  function scheduleAssistantRootProcessing(root) {
    // Replace any previous timer so only the completed stream is rendered.
    const existingTimer = pendingProcessingTimers.get(root);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    // Process the final settled DOM after ChatGPT stops appending tokens.
    const nextTimer = window.setTimeout(() => {
      pendingProcessingTimers.delete(root);
      processAssistantRoot(root);
    }, STREAM_IDLE_DELAY_MS);

    // Remember the active timer so scans skip partial streaming output.
    pendingProcessingTimers.set(root, nextTimer);
  }

  /**
   * Determines whether an assistant root currently contains renderable MCQ text.
   *
   * @param {Element} root - Assistant output root.
   * @returns {boolean} True when the source output should be hidden while streaming.
   */
  function hasRenderableMcqContent(root) {
    // Parse the current visible text without creating any extension UI.
    const text = getVisibleText(root);
    const questions = parseMultipleChoiceQuestions(text);

    // Hide only after there is enough structure to avoid blanking normal replies.
    return questions.length > 0;
  }

  /**
   * Ensures a streaming placeholder is visible until the final quiz is ready.
   *
   * @param {Element} root - Assistant output root.
   * @returns {HTMLElement} Existing or newly-created placeholder element.
   */
  function ensureStreamingPlaceholder(root) {
    // Reuse the current placeholder while ChatGPT continues appending tokens.
    const existingPlaceholder = root.querySelector(`.${EXTENSION_PREFIX}-streaming-placeholder`);
    if (existingPlaceholder) {
      return existingPlaceholder;
    }

    // Create an extension-owned card so mutation filters and parsers ignore it.
    const placeholder = document.createElement("section");
    placeholder.className = `${EXTENSION_PREFIX}-quiz ${EXTENSION_PREFIX}-streaming-placeholder`;
    placeholder.setAttribute("aria-live", "polite");

    // Tell the user why the generated answer text is temporarily hidden.
    const title = document.createElement("div");
    title.className = `${EXTENSION_PREFIX}-title`;
    title.textContent = "Quiz is being prepared";
    placeholder.appendChild(title);

    // Explain that controls will appear after the assistant finishes streaming.
    const message = document.createElement("div");
    message.className = `${EXTENSION_PREFIX}-streaming-placeholder-message`;
    message.textContent = "ChatGPT is still writing. Your quiz will appear here soon.";
    placeholder.appendChild(message);

    // Place the placeholder at the end of the assistant response.
    root.appendChild(placeholder);

    // Return the visible placeholder for source-output hiding.
    return placeholder;
  }

  /**
   * Removes any temporary streaming placeholder from an assistant output.
   *
   * @param {Element} root - Assistant output root.
   */
  function removeStreamingPlaceholder(root) {
    // Find all placeholders in case a previous page update duplicated one.
    const placeholders = root.querySelectorAll(`.${EXTENSION_PREFIX}-streaming-placeholder`);

    // Remove the temporary cards before final quiz, paywall, or source output appears.
    for (const placeholder of placeholders) {
      placeholder.remove();
    }
  }

  /**
   * Processes one ChatGPT assistant output and inserts radio choices when MCQs exist.
   *
   * @param {Element} root - Assistant message content root.
   */
  async function processAssistantRoot(root) {
    // Disabled mode must leave both existing and newly-streamed output untouched.
    if (!extensionEnabled) {
      return;
    }

    // Skip extension UI and roots that were already handled after their final mutation.
    if (processedRoots.has(root) || processingRoots.has(root) || root.hasAttribute(PROCESSED_ATTRIBUTE)) {
      return;
    }

    // Mark this root as in-flight while asynchronous storage reads finish.
    processingRoots.add(root);

    // Extract the visible text that ChatGPT rendered for this assistant response.
    const text = getVisibleText(root);
    const questions = parseMultipleChoiceQuestions(text);

    // Mark non-MCQ outputs as processed to avoid repeated parsing.
    if (questions.length === 0) {
      removeStreamingPlaceholder(root);
      restoreOriginalOutput(root);
      root.setAttribute(PROCESSED_ATTRIBUTE, "true");
      processedRoots.add(root);
      processingRoots.delete(root);
      return;
    }

    // Hide answer-key lines before adding selectable options.
    hideAnswerLines(root);

    // Gate the quiz UI after parsing so normal non-MCQ replies stay untouched.
    const accessState = await readAccessState(false);
    if (!extensionEnabled) {
      processingRoots.delete(root);
      restoreAnswerLines(root);
      return;
    }
    if (isAccessLocked(accessState)) {
      const paywall = buildPaywallElement(accessState);
      removeStreamingPlaceholder(root);
      root.appendChild(paywall);
      hideOriginalOutput(root, paywall);
      root.setAttribute(PROCESSED_ATTRIBUTE, "true");
      processedRoots.add(root);
      processingRoots.delete(root);
      return;
    }

    // Build a stable identifier from the conversation URL and response location.
    const quizId = createQuizId(root, questions);
    const savedSelections = await readSelections();
    if (!extensionEnabled) {
      processingRoots.delete(root);
      restoreAnswerLines(root);
      return;
    }
    const quiz = buildQuizElement(quizId, questions, savedSelections, accessState);

    // Insert the quiz after the rendered markdown content for the response.
    removeStreamingPlaceholder(root);
    root.appendChild(quiz);
    hideOriginalOutput(root, quiz);
    root.setAttribute(PROCESSED_ATTRIBUTE, "true");
    processedRoots.add(root);
    processingRoots.delete(root);

    // Keep a hidden DOM copy so selections are available in the page context too.
    updateConversationContext(savedSelections);
  }

  /**
   * Creates visible text while ignoring controls and hidden extension state.
   *
   * @param {Element} root - DOM node to read.
   * @returns {string} Plain visible text.
   */
  function getVisibleText(root) {
    // Clone first so extension UI and hidden answer lines can be removed safely.
    const clone = root.cloneNode(true);
    const ignoredNodes = clone.querySelectorAll(
      `.${EXTENSION_PREFIX}-quiz, .${EXTENSION_PREFIX}-context, script, style, textarea, input, button`
    );

    // Remove controls and extension-owned state from the parse input.
    for (const node of ignoredNodes) {
      node.remove();
    }

    // Return rendered text with browser-normalized line breaks.
    return clone.innerText || clone.textContent || "";
  }

  /**
   * Refreshes locked paywall panels after users return from payment or login.
   */
  function refreshAccessGatedOutputs() {
    // Skip background tab changes until the user returns to ChatGPT.
    if (document.visibilityState === "hidden") {
      return;
    }

    // Force the next access read to verify provider status again.
    clearAccessStateCache();

    // Reprocess each locked output so paid users see quiz controls immediately.
    const paywalls = document.querySelectorAll(`.${EXTENSION_PREFIX}-paywall`);
    for (const paywall of paywalls) {
      refreshPaywallRoot(paywall.closest('[data-message-author-role="assistant"]'));
    }
  }

  /**
   * Rebuilds one assistant output after paywall status may have changed.
   *
   * @param {Element | null} root - Assistant output root to rebuild.
   * @returns {Promise<void>} Resolves after the output has been reprocessed.
   */
  async function refreshPaywallRoot(root) {
    // Ignore stale or already-processing roots.
    if (!root || processingRoots.has(root)) {
      return;
    }

    // Remove the locked UI while keeping the original answer hidden during rebuild.
    removeExistingQuiz(root, false);
    root.removeAttribute(PROCESSED_ATTRIBUTE);
    processedRoots.delete(root);

    // Re-run the normal parser and gate with a fresh access state.
    await processAssistantRoot(root);
  }

  /**
   * Finds the assistant output root that owns a mutation target.
   *
   * @param {Node} node - Mutation target node.
   * @returns {Element | null} Owning assistant output root.
   */
  function findAssistantRoot(node) {
    // Convert text nodes to their parent element before using closest.
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;

    // Return null for detached nodes or extension-owned nodes.
    if (!element || element.closest(`.${EXTENSION_PREFIX}-quiz`)) {
      return null;
    }

    // Locate the nearest ChatGPT assistant message content root.
    return element.closest('[data-message-author-role="assistant"]');
  }

  /**
   * Detects mutations caused by this extension's own DOM updates.
   *
   * @param {MutationRecord} mutation - Browser mutation record.
   * @returns {boolean} True when the mutation should be ignored.
   */
  function isExtensionMutation(mutation) {
    // Ignore direct mutations inside extension-owned elements.
    const target = mutation.target;
    const targetElement = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    if (targetElement?.closest(`.${EXTENSION_PREFIX}-quiz, .${EXTENSION_PREFIX}-context`)) {
      return true;
    }

    // Ignore child-list changes that only add or remove extension-owned nodes.
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    if (changedNodes.length === 0) {
      return false;
    }

    // Treat the mutation as extension-owned only when every changed node is ours.
    for (const node of changedNodes) {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!element?.classList?.contains(`${EXTENSION_PREFIX}-quiz`) && !element?.classList?.contains(`${EXTENSION_PREFIX}-context`)) {
        return false;
      }
    }

    // All changed nodes belonged to extension UI or state.
    return true;
  }

  /**
   * Removes an existing quiz before reparsing a changed assistant output.
   *
   * @param {Element} root - Assistant output root.
   * @param {boolean} [shouldRestoreOriginal=true] - Whether to reveal source output immediately.
   */
  function removeExistingQuiz(root, shouldRestoreOriginal = true) {
    // Reveal source output only for explicit cleanup after the final parse.
    if (shouldRestoreOriginal) {
      restoreOriginalOutput(root);
    }

    // Find extension-owned quiz elements under this response.
    const quizzes = root.querySelectorAll(`.${EXTENSION_PREFIX}-quiz`);

    // Remove stale quiz UI before rebuilding from the latest text.
    for (const quiz of quizzes) {
      quiz.remove();
    }
  }

  // Expose private helpers only when the unit-test harness explicitly asks for them.
  if (globalThis.__MCQ_RADIO_EXTENSION_ENABLE_TEST_API__) {
    globalThis.__mcqRadioExtensionTestApi = {
      ...services.parser,
      ...services.scoring,
      ...services.ui,
      ...services.access,
      ...services.persistence,
      handleMutations,
      scanPageForMcqOutputs,
      scheduleAssistantRootProcessing,
      hasRenderableMcqContent,
      ensureStreamingPlaceholder,
      removeStreamingPlaceholder,
      processAssistantRoot,
      getVisibleText,
      refreshAccessGatedOutputs,
      refreshPaywallRoot,
      findAssistantRoot,
      isExtensionMutation,
      removeExistingQuiz,
      handleStorageChange,
      start,
      stop
    };
  } else if (document.body) {
    initialize();
  } else {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  }
})();
