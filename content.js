(function initializeMcqRadioExtension() {
  // Keep all extension-owned DOM identifiers in one place.
  const EXTENSION_PREFIX = "mcq-radio-extension";
  const PROCESSED_ATTRIBUTE = "data-mcq-radio-extension-processed";
  const QUIZ_ATTRIBUTE = "data-mcq-radio-extension-quiz-id";
  const ORIGINAL_OUTPUT_ATTRIBUTE = "data-mcq-radio-extension-original-output";
  const CONTEXT_ELEMENT_ID = "mcq-radio-extension-conversation-context";
  const STREAM_IDLE_DELAY_MS = 1200;
  const ACCESS_CACHE_DURATION_MS = 30000;
  const OPTION_PATTERN = /^([A-H])[\.\):\-]\s+(.+)$/i;
  const QUESTION_START_PATTERN = /^(?:question\s*)?(\d+)[\.\)]\s*(.+)$/i;
  const SATA_PATTERN = /\b(?:sata|select all that apply|choose all that apply|multiple response|multi-select|multiple select)\b/i;
  const INLINE_STOP_PATTERN = /\s+(?:rationale|explanation|ordered response|correct order|next steps|answer key|answers?)\s*[:\-—]/i;
  const ANSWER_PATTERNS = [
    /^\s*(?:answer|answers|correct answer|correct answers|correct option|correct options|solution)\s*[:\-]\s*[A-H]\b.*$/i,
    /^\s*the\s+correct\s+answers?\s+(?:is|are)\s+[A-H]\b.*$/i,
    /^\s*(?:answers|answer key)\s*[:\-]\s*(?:(?:question\s*)?[0-9]+\s*[\.\):\-]?\s*)?[A-H](?:\s*(?:,|;|and)\s*(?:(?:question\s*)?[0-9]+\s*[\.\):\-]?\s*)?[A-H])*\s*\.?\s*$/i
  ];

  // Track parsed roots so rapid streaming mutations do not duplicate widgets.
  const processedRoots = new WeakSet();
  const processingRoots = new WeakSet();
  const pendingProcessingTimers = new WeakMap();
  let accessStateCache = null;

  /**
   * Starts the extension once the ChatGPT page is ready enough to observe.
   */
  function start() {
    // Parse anything already visible when the content script loads.
    scanPageForMcqOutputs();

    // Watch future streamed responses and route changes in the single-page app.
    const observer = new MutationObserver(handleMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Refresh gated outputs after users return from checkout or login tabs.
    window.addEventListener("focus", refreshAccessGatedOutputs);
    document.addEventListener("visibilitychange", refreshAccessGatedOutputs);
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
        hideOriginalOutput(root, null);
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
   * Processes one ChatGPT assistant output and inserts radio choices when MCQs exist.
   *
   * @param {Element} root - Assistant message content root.
   */
  async function processAssistantRoot(root) {
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
    if (isAccessLocked(accessState)) {
      const paywall = buildPaywallElement(accessState);
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
    const quiz = buildQuizElement(quizId, questions, savedSelections, accessState);

    // Insert the quiz after the rendered markdown content for the response.
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
   * Parses one or more multiple-choice questions from plain rendered text.
   *
   * @param {string} text - ChatGPT assistant output text.
   * @returns {Array<{prompt: string, options: Array<{letter: string, text: string}>, correctLetters: string[], isSata: boolean}>} Parsed questions.
   */
  function parseMultipleChoiceQuestions(text) {
    // Normalize line endings and remove empty lines that split markdown paragraphs.
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const questions = [];
    let pendingPromptLines = [];
    let currentQuestion = null;
    let lastQuestion = null;
    let answerKeyGroups = [];

    // Walk line by line to preserve question prompts that appear before option A.
    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Ignore blank lines during parsing.
      if (!line) {
        continue;
      }

      const answerEntry = parseAnswerEntry(line);

      // Save hidden answer keys for local scoring without rendering them.
      if (answerEntry) {
        const targetQuestion = currentQuestion || lastQuestion;

        // Treat plural unnumbered answer keys as a sequence unless the current question is SATA.
        if (answerEntry.isPotentialSequence && !targetQuestion?.isSata && questions.length > 0) {
          answerKeyGroups = answerEntry.groups[0].map((letter) => [letter]);
        } else if (answerEntry.groups.length > 1) {
          answerKeyGroups = answerEntry.groups;
        } else {
          assignAnswerLetters(targetQuestion, answerEntry.groups[0]);
        }
        continue;
      }

      // Stop option parsing when rationale or follow-up sections begin.
      if (isExplanationBoundary(line)) {
        appendQuestionIfValid(questions, currentQuestion);
        lastQuestion = currentQuestion;
        currentQuestion = null;
        pendingPromptLines = [];
        continue;
      }

      const option = parseOptionLine(line);

      // Option lines start or continue a question group.
      if (option) {
        const questionMatch = option.text.match(QUESTION_START_PATTERN);
        const shouldStartNewQuestion =
          !currentQuestion || option.letter === "A" || questionMatch;

        // A new A option or numbered question marker starts the next question.
        if (shouldStartNewQuestion) {
          appendQuestionIfValid(questions, currentQuestion);
          lastQuestion = currentQuestion;
          currentQuestion = createQuestion(pendingPromptLines, questions.length, questionMatch);
          pendingPromptLines = [];
        }

        // Store the option with a normalized uppercase letter.
        currentQuestion.options.push(option);
        continue;
      }

      const questionStart = line.match(QUESTION_START_PATTERN);

      // Numbered question text starts a new prompt after a finished option group.
      if (currentQuestion && currentQuestion.options.length > 0) {
        appendQuestionIfValid(questions, currentQuestion);
        lastQuestion = currentQuestion;
        currentQuestion = null;
        pendingPromptLines = questionStart ? [questionStart[2].trim()] : [line];
        continue;
      }

      // Otherwise, the line is part of the upcoming question prompt.
      pendingPromptLines.push(questionStart ? questionStart[2].trim() : line);
    }

    // Flush the final parsed question, if it has enough options.
    appendQuestionIfValid(questions, currentQuestion);
    assignAnswerKeyToQuestions(questions, answerKeyGroups);

    // Only consider outputs with at least one real two-option question to be MCQ content.
    return questions;
  }

  /**
   * Parses a single option line like "A. Photosynthesis".
   *
   * @param {string} line - Trimmed line of assistant output.
   * @returns {{letter: string, text: string} | null} Parsed option data.
   */
  function parseOptionLine(line) {
    // Match common option formats: A. text, A) text, A: text, or A - text.
    const match = line.match(OPTION_PATTERN);

    // Return null for non-option lines so callers can handle prompts normally.
    if (!match) {
      return null;
    }

    // Normalize the option letter and keep the human-readable answer text.
    return {
      letter: match[1].toUpperCase(),
      text: cleanOptionText(match[2])
    };
  }

  /**
   * Removes rationale or follow-up text accidentally included on an option line.
   *
   * @param {string} text - Raw option text.
   * @returns {string} Option text safe to render.
   */
  function cleanOptionText(text) {
    // Split at common explanation markers that ChatGPT may put on the same line.
    const stopMatch = text.match(INLINE_STOP_PATTERN);
    const cleanText = stopMatch ? text.slice(0, stopMatch.index).trim() : text.trim();

    // Return the trimmed answer option without hidden rationale content.
    return cleanText;
  }

  /**
   * Creates a parsed question shell and strips inline answer keys from the prompt.
   *
   * @param {string[]} promptLines - Lines seen before the option group.
   * @param {number} questionIndex - Zero-based parsed question index.
   * @param {RegExpMatchArray | null} questionMatch - Optional numbered question match.
   * @returns {{prompt: string, options: Array<{letter: string, text: string}>, correctLetters: string[], isSata: boolean}} Parsed question shell.
   */
  function createQuestion(promptLines, questionIndex, questionMatch = null) {
    // Build the raw prompt first so inline answer keys can be removed in one place.
    const rawPrompt = createPrompt(promptLines, questionIndex, questionMatch);
    const inlineAnswer = extractInlineAnswerKey(rawPrompt);
    const promptCueLines = [...promptLines, questionMatch?.[2] || ""];

    // Return the question metadata used by rendering and scoring.
    return {
      prompt: inlineAnswer.cleanText || `Question ${questionIndex + 1}`,
      options: [],
      correctLetters: inlineAnswer.letters,
      isSata: hasSataCue(promptCueLines) || inlineAnswer.letters.length > 1
    };
  }

  /**
   * Extracts an answer key embedded at the end of a question title.
   *
   * @param {string} text - Raw question prompt text.
   * @returns {{cleanText: string, letters: string[]}} Clean prompt and parsed answer letters.
   */
  function extractInlineAnswerKey(text) {
    // Match title suffixes like "Correct answers: A, C, D" or "(Answer: B)".
    const suffixMatch = text.match(/\s*[\(\[]?\s*(?:answer|answers|correct answer|correct answers|correct option|correct options|answer key|solution)\s*[:\-]\s*([A-H](?:\s*(?:,|;|and|&)\s*[A-H])*)\s*[\)\]]?\.?\s*$/i)
      || text.match(/\s*[\(\[]?\s*the\s+correct\s+answers?\s+(?:is|are)\s+([A-H](?:\s*(?:,|;|and|&)\s*[A-H])*)\s*[\)\]]?\.?\s*$/i);

    // Return the prompt unchanged when no inline answer key is present.
    if (!suffixMatch) {
      return {
        cleanText: text.trim(),
        letters: []
      };
    }

    // Remove only the answer-key suffix, keeping the actual question title.
    return {
      cleanText: text.slice(0, suffixMatch.index).trim(),
      letters: extractUniqueLetters(suffixMatch[1])
    };
  }

  /**
   * Finds answer letters in answer-key lines, including SATA multi-answer keys.
   *
   * @param {string} line - Trimmed rendered line.
   * @returns {{groups: string[][], isPotentialSequence: boolean} | null} Parsed answer groups, or null for non-answer lines.
   */
  function parseAnswerEntry(line) {
    // Parse answer-key prefixes that ChatGPT commonly emits after questions.
    const prefixedMatch = line.match(/^\s*(?:answer|answers|correct answer|correct answers|correct option|correct options|solution|answer key)\s*[:\-]\s*(.+)$/i)
      || line.match(/^\s*the\s+correct\s+answers?\s+(?:is|are)\s+(.+)$/i);

    // Return null when the line is not an answer-key line.
    if (!prefixedMatch) {
      return null;
    }

    // Split the answer body into one or more question-specific answer groups.
    const body = prefixedMatch[1].trim();
    const groups = parseAnswerGroups(body);
    const hasPluralSequencePrefix = /^\s*(?:answers|answer key)\s*[:\-]/i.test(line);
    const isPotentialSequence = hasPluralSequencePrefix && groups.length === 1 && groups[0].length > 1 && !hasGroupedAnswerNumbers(body);

    // Ignore malformed answer lines that do not include option letters.
    if (groups.length === 0) {
      return null;
    }

    // Return grouped letters for single MCQ, SATA, or ordered answer keys.
    return { groups, isPotentialSequence };
  }

  /**
   * Detects numbered answer groups in an answer-key body.
   *
   * @param {string} body - Text after the answer-key prefix.
   * @returns {boolean} True when the key has question-number markers.
   */
  function hasGroupedAnswerNumbers(body) {
    // Match numbered keys like "1. A", "2: C", or "Question 3) B".
    return /(?:^|[;,]\s*)(?:question\s*)?\d+\s*[\.\):\-]\s*[A-H]/i.test(body);
  }

  /**
   * Parses answer-key text into per-question answer groups.
   *
   * @param {string} body - Text after the answer-key prefix.
   * @returns {string[][]} One answer-letter array per question.
   */
  function parseAnswerGroups(body) {
    // Detect grouped keys like "1. A, C; 2. B" before treating letters as one SATA key.
    const groupedMatches = [...body.matchAll(/(?:^|[;,]\s*)(?:question\s*)?\d+\s*[\.\):\-]\s*([A-H](?:\s*(?:,|and|&)\s*[A-H])*)/gi)];

    // Return each numbered group as its own question's correct letters.
    if (groupedMatches.length > 0) {
      return groupedMatches
        .map((match) => extractUniqueLetters(match[1]))
        .filter((letters) => letters.length > 0);
    }

    // Treat unnumbered multi-letter answer keys as SATA for the current question.
    const letters = extractUniqueLetters(body);

    // Return one group when at least one answer letter was found.
    return letters.length > 0 ? [letters] : [];
  }

  /**
   * Extracts unique option letters from answer-key text.
   *
   * @param {string} text - Answer-key text containing option letters.
   * @returns {string[]} Unique uppercase option letters.
   */
  function extractUniqueLetters(text) {
    // Collect standalone option letters in the order they appear.
    const letters = [...text.matchAll(/\b[A-H]\b/gi)].map((match) => match[0].toUpperCase());

    // Remove duplicates so repeated answer wording does not affect scoring.
    return [...new Set(letters)];
  }

  /**
   * Assigns parsed answer letters to the current question or its sequence.
   *
   * @param {{correctLetters: string[], isSata: boolean} | null} question - Question to update.
   * @param {string[]} answerLetters - Parsed answer letters.
   */
  function assignAnswerLetters(question, answerLetters) {
    // Skip answer-key lines that do not map to the current parsed question.
    if (!question || answerLetters.length === 0) {
      return;
    }

    // Store all answer letters so SATA questions can be scored exactly.
    question.correctLetters = answerLetters;
    question.isSata = question.isSata || answerLetters.length > 1;
  }

  /**
   * Assigns a compact answer key across parsed questions.
   *
   * @param {Array<{correctLetters: string[], isSata: boolean}>} questions - Parsed question list.
   * @param {string[][]} answerGroups - Ordered answer-key groups.
   */
  function assignAnswerKeyToQuestions(questions, answerGroups) {
    // Skip when no multi-question answer key was discovered.
    if (answerGroups.length === 0) {
      return;
    }

    // Apply answer groups by question order without overwriting explicit answers.
    for (let index = 0; index < questions.length && index < answerGroups.length; index += 1) {
      if (questions[index].correctLetters.length === 0) {
        questions[index].correctLetters = answerGroups[index];
        questions[index].isSata = questions[index].isSata || answerGroups[index].length > 1;
      }
    }
  }

  /**
   * Detects whether prompt lines describe a SATA-style question.
   *
   * @param {string[]} promptLines - Prompt lines associated with a question.
   * @returns {boolean} True when the prompt asks for multiple selections.
   */
  function hasSataCue(promptLines) {
    // Join prompt text so cues split across lines are still detected.
    const prompt = promptLines.join(" ");

    // Match nursing SATA wording and general multi-select instructions.
    return SATA_PATTERN.test(prompt);
  }

  /**
   * Detects text that starts rationale, explanations, or next-step sections.
   *
   * @param {string} line - Trimmed rendered line.
   * @returns {boolean} True when option parsing should stop.
   */
  function isExplanationBoundary(line) {
    // Match common labels that indicate the answer options have ended.
    return /^(?:rationale|explanation|ordered response|correct order|next steps|teaching point|review)\b/i.test(line);
  }

  /**
   * Appends a parsed question only when it has enough options to be useful.
   *
   * @param {Array<{prompt: string, options: Array<{letter: string, text: string}>}>} questions - Output list.
   * @param {{prompt: string, options: Array<{letter: string, text: string}>} | null} question - Candidate question.
   */
  function appendQuestionIfValid(questions, question) {
    // Require at least two options to avoid false positives on lettered prose.
    if (!question || question.options.length < 2) {
      return;
    }

    // Add the validated question to the render list.
    questions.push(question);
  }

  /**
   * Builds a prompt from preceding text, falling back to a generic label.
   *
   * @param {string[]} promptLines - Lines seen before the option group.
   * @param {number} questionIndex - Zero-based parsed question index.
   * @param {RegExpMatchArray | null} questionMatch - Optional numbered question match.
   * @returns {string} Display prompt.
   */
  function createPrompt(promptLines, questionIndex, questionMatch = null) {
    // Prefer a question marker embedded in a malformed option line.
    if (questionMatch) {
      return questionMatch[2].trim();
    }

    // Use the most recent prompt lines so long explanations do not overwhelm the UI.
    const prompt = promptLines.slice(-3).join(" ").trim();

    // Keep the widget usable even if ChatGPT omitted an explicit question stem.
    return prompt || `Question ${questionIndex + 1}`;
  }

  /**
   * Determines whether a rendered line exposes the correct answer.
   *
   * @param {string} line - Trimmed rendered line.
   * @returns {boolean} True when the line should be hidden.
   */
  function isAnswerLine(line) {
    // Compare against each answer-key pattern.
    for (const pattern of ANSWER_PATTERNS) {
      if (pattern.test(line)) {
        return true;
      }
    }

    // Keep non-answer lines visible.
    return false;
  }

  /**
   * Hides DOM elements that contain answer-key text.
   *
   * @param {Element} root - Assistant output root.
   */
  function hideAnswerLines(root) {
    // Restrict hiding to likely rendered markdown text nodes.
    const candidates = root.querySelectorAll("p, li, span");

    // Hide only small leaf-like elements to avoid removing the full answer.
    for (const candidate of candidates) {
      const text = (candidate.innerText || candidate.textContent || "").trim();

      // Skip elements that contain extension controls or too much unrelated content.
      if (!text || candidate.closest(`.${EXTENSION_PREFIX}-quiz`) || text.length > 180) {
        continue;
      }

      // Hide answer-key lines while preserving layout for the rest of the response.
      if (isAnswerLine(text)) {
        candidate.classList.add(`${EXTENSION_PREFIX}-hidden-answer`);
      }
    }
  }

  /**
   * Hides the original ChatGPT-rendered output after the generated quiz is ready.
   *
   * @param {Element} root - Assistant output root.
   * @param {Element | null} visibleQuiz - Extension quiz that should remain visible.
   */
  function hideOriginalOutput(root, visibleQuiz) {
    // Hide only direct original children so the appended quiz stays visible.
    for (const child of root.children) {
      // Skip the quiz UI and any other extension-owned elements.
      if ((visibleQuiz && child === visibleQuiz) || child.closest(`.${EXTENSION_PREFIX}-quiz, .${EXTENSION_PREFIX}-context`)) {
        continue;
      }

      // Mark original ChatGPT content so it can be restored before a rebuild.
      child.classList.add(`${EXTENSION_PREFIX}-hidden-original`);
      child.setAttribute(ORIGINAL_OUTPUT_ATTRIBUTE, "true");
    }
  }

  /**
   * Restores hidden ChatGPT output before reparsing or removing a generated quiz.
   *
   * @param {Element} root - Assistant output root.
   */
  function restoreOriginalOutput(root) {
    // Find every source node hidden by this extension under the response.
    const hiddenOriginals = root.querySelectorAll(`[${ORIGINAL_OUTPUT_ATTRIBUTE}]`);

    // Remove the extension's visibility markers from original ChatGPT content.
    for (const original of hiddenOriginals) {
      original.classList.remove(`${EXTENSION_PREFIX}-hidden-original`);
      original.removeAttribute(ORIGINAL_OUTPUT_ATTRIBUTE);
    }
  }

  /**
   * Builds a stable quiz id from the page path and parsed question text.
   *
   * @param {Element} root - Assistant output root.
   * @param {Array<{prompt: string, options: Array<{letter: string, text: string}>, correctLetters: string[], isSata: boolean}>} questions - Parsed questions.
   * @returns {string} Stable quiz identifier.
   */
  function createQuizId(root, questions) {
    // Prefer an existing ChatGPT turn identifier when available.
    const turn = root.closest("[data-testid]") || root.closest("article") || root;
    const turnId = turn.getAttribute("data-testid") || `${getElementIndex(root)}`;
    const source = `${location.origin}${location.pathname}|${turnId}|${questions[0].prompt}`;

    // Hash the source into a compact id for storage keys and input names.
    return `quiz-${hashString(source)}`;
  }

  /**
   * Calculates a sibling index for roots that do not expose a stable id.
   *
   * @param {Element} element - DOM element to locate.
   * @returns {number} Element index among assistant roots.
   */
  function getElementIndex(element) {
    // Query all assistant roots and find the current element's position.
    const roots = document.querySelectorAll('[data-message-author-role="assistant"]');

    // Return the matching index when the root is found.
    for (let index = 0; index < roots.length; index += 1) {
      if (roots[index] === element) {
        return index;
      }
    }

    // Fallback to zero for unexpected detached nodes.
    return 0;
  }

  /**
   * Produces a deterministic non-cryptographic hash.
   *
   * @param {string} value - Source string to hash.
   * @returns {string} Positive base36 hash.
   */
  function hashString(value) {
    // Use a compact Java-style string hash for stable client-side identifiers.
    let hash = 0;

    // Fold each character into a signed 32-bit integer.
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash |= 0;
    }

    // Convert to an unsigned base36 value for readable ids.
    return (hash >>> 0).toString(36);
  }

  /**
   * Creates the interactive answer-selection quiz element.
   *
   * @param {string} quizId - Stable quiz id.
   * @param {Array<{prompt: string, options: Array<{letter: string, text: string}>, correctLetters: string[], isSata: boolean}>} questions - Parsed questions.
   * @param {Record<string, Record<string, string>>} savedSelections - Stored selections by quiz id.
   * @param {{status?: string, trialRemainingMs?: number}} accessState - Current paywall access state.
   * @returns {HTMLElement} Renderable quiz container.
   */
  function buildQuizElement(quizId, questions, savedSelections, accessState) {
    // Create an extension-owned container for all parsed questions.
    const quiz = document.createElement("section");
    quiz.className = `${EXTENSION_PREFIX}-quiz`;
    quiz.setAttribute(QUIZ_ATTRIBUTE, quizId);

    // Add a short label so users understand why controls appeared.
    const title = document.createElement("div");
    title.className = `${EXTENSION_PREFIX}-title`;
    title.textContent = "Select your answer(s)";
    quiz.appendChild(title);

    // Show trial status without interrupting the quiz while access is still valid.
    if (accessState?.status === "trial") {
      quiz.appendChild(buildTrialNotice(accessState));
    }

    // Render each parsed question with an independent control group.
    for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
      const question = questions[questionIndex];
      const questionElement = buildQuestionElement(quizId, question, questionIndex, savedSelections);
      quiz.appendChild(questionElement);
    }

    // Add local scoring controls so ChatGPT context is not required for grading.
    const actions = buildScoreActions(quizId);
    quiz.appendChild(actions);

    // Return the finished UI subtree for insertion into ChatGPT output.
    return quiz;
  }

  /**
   * Builds a short notice for users still inside the 24-hour free trial.
   *
   * @param {{trialRemainingMs?: number}} accessState - Current trial timing state.
   * @returns {HTMLElement} Trial notice element.
   */
  function buildTrialNotice(accessState) {
    // Create a compact notice that matches the existing quiz card.
    const notice = document.createElement("div");
    notice.className = `${EXTENSION_PREFIX}-trial-notice`;

    // Explain the deadline and price before the paywall appears.
    notice.textContent = `${formatTrialRemaining(accessState.trialRemainingMs || 0)} left in your free trial. After that, unlock lifetime access for $5.`;

    // Return the finished notice for insertion near the quiz title.
    return notice;
  }

  /**
   * Builds the locked paywall UI shown after the 24-hour trial expires.
   *
   * @param {{status?: string, error?: string}} accessState - Current paywall access state.
   * @returns {HTMLElement} Paywall panel element.
   */
  function buildPaywallElement(accessState) {
    // Use the quiz class so existing mutation filters treat this as extension UI.
    const paywall = document.createElement("section");
    paywall.className = `${EXTENSION_PREFIX}-quiz ${EXTENSION_PREFIX}-paywall`;

    // Add the main locked-state headline.
    const title = document.createElement("div");
    title.className = `${EXTENSION_PREFIX}-title`;
    title.textContent = "Unlock ChatGPT Quiz Mode";
    paywall.appendChild(title);

    // Explain why answer controls are not visible.
    const message = document.createElement("p");
    message.className = `${EXTENSION_PREFIX}-paywall-message`;
    message.textContent = getPaywallMessage(accessState);
    paywall.appendChild(message);

    // Add payment, login, and retry actions in one row.
    const actions = document.createElement("div");
    actions.className = `${EXTENSION_PREFIX}-paywall-actions`;
    actions.appendChild(buildPaywallButton("Pay $5", "openPaymentPage", true));
    actions.appendChild(buildPaywallButton("I already paid", "openLoginPage", false));
    actions.appendChild(buildPaywallButton("Retry status", "refreshAccessState", false));
    paywall.appendChild(actions);

    // Add a live status region for payment/login errors.
    const status = document.createElement("div");
    status.className = `${EXTENSION_PREFIX}-paywall-status`;
    status.setAttribute("aria-live", "polite");
    paywall.appendChild(status);

    // Return the complete locked-state UI.
    return paywall;
  }

  /**
   * Creates a paywall action button.
   *
   * @param {string} label - Visible button label.
   * @param {string} action - Paywall action identifier.
   * @param {boolean} isPrimary - Whether the button is the primary call to action.
   * @returns {HTMLButtonElement} Configured paywall button.
   */
  function buildPaywallButton(label, action, isPrimary) {
    // Create a regular button so ChatGPT page forms are not affected.
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${EXTENSION_PREFIX}-paywall-button${isPrimary ? ` ${EXTENSION_PREFIX}-paywall-button-primary` : ""}`;
    button.dataset.paywallAction = action;
    button.textContent = label;
    button.addEventListener("click", handlePaywallAction);

    // Return the clickable payment/login action.
    return button;
  }

  /**
   * Creates user-facing paywall copy for locked or unknown access states.
   *
   * @param {{status?: string, error?: string}} accessState - Current paywall access state.
   * @returns {string} Message for the paywall panel.
   */
  function getPaywallMessage(accessState) {
    // Explain provider outages separately from normal locked access.
    if (accessState?.status === "unknown") {
      return "Your 24-hour trial has ended, and payment status could not be verified. Retry status, pay $5, or log in with the email you used to pay.";
    }

    // Default locked copy for expired unpaid trials.
    return "Your 24-hour free trial has ended. Pay $5 once to unlock this extension on your account, or log in if you already paid.";
  }

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
        await refreshPaywallRoot(paywall?.closest('[data-message-author-role="assistant"]') || null);
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

  /**
   * Builds one answer-selection question group.
   *
   * @param {string} quizId - Stable quiz id.
   * @param {{prompt: string, options: Array<{letter: string, text: string}>, correctLetters: string[], isSata: boolean}} question - Parsed question.
   * @param {number} questionIndex - Zero-based question index.
   * @param {Record<string, Record<string, string>>} savedSelections - Stored selections by quiz id.
   * @returns {HTMLElement} Question group element.
   */
  function buildQuestionElement(quizId, question, questionIndex, savedSelections) {
    // Create an accessible fieldset-like region without disturbing ChatGPT styles.
    const wrapper = document.createElement("div");
    wrapper.className = `${EXTENSION_PREFIX}-question`;
    wrapper.dataset.questionIndex = String(questionIndex);
    wrapper.dataset.correctLetters = question.correctLetters.join(",");
    wrapper.dataset.isSata = String(question.isSata);

    // Show the prompt above the selectable answer options.
    const prompt = document.createElement("div");
    prompt.className = `${EXTENSION_PREFIX}-prompt`;
    prompt.textContent = question.prompt;
    wrapper.appendChild(prompt);

    // Use an input group name scoped to the quiz and question.
    const groupName = `${EXTENSION_PREFIX}-${quizId}-${questionIndex}`;
    const selectedLetters = normalizeSavedSelection(savedSelections[quizId]?.[String(questionIndex)]);

    // Add a short instruction for SATA questions.
    if (question.isSata) {
      const hint = document.createElement("div");
      hint.className = `${EXTENSION_PREFIX}-sata-hint`;
      hint.textContent = "Select all that apply.";
      wrapper.appendChild(hint);
    }

    // Create each answer option as a label so the whole row is clickable.
    for (const option of question.options) {
      const optionElement = buildOptionElement(quizId, questionIndex, groupName, option, selectedLetters, question.isSata);
      wrapper.appendChild(optionElement);
    }

    // Return the complete question block.
    return wrapper;
  }

  /**
   * Normalizes saved radio or checkbox selections into an array.
   *
   * @param {string | string[] | undefined} savedSelection - Stored selection value.
   * @returns {string[]} Stored option letters.
   */
  function normalizeSavedSelection(savedSelection) {
    // Return existing checkbox selections unchanged.
    if (Array.isArray(savedSelection)) {
      return savedSelection;
    }

    // Convert older radio-style string selections into a one-item array.
    if (typeof savedSelection === "string" && savedSelection) {
      return [savedSelection];
    }

    // Return an empty array when no selection exists.
    return [];
  }

  /**
   * Builds the score button and result container for a quiz.
   *
   * @param {string} quizId - Stable quiz id.
   * @returns {HTMLElement} Score action area.
   */
  function buildScoreActions(quizId) {
    // Create an action row beneath the generated questions.
    const actions = document.createElement("div");
    actions.className = `${EXTENSION_PREFIX}-actions`;

    // Add the score button requested by the user.
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${EXTENSION_PREFIX}-score-button`;
    button.dataset.quizId = quizId;
    button.textContent = "Score";
    button.addEventListener("click", handleScoreClick);

    // Reserve a live result area for the score summary.
    const result = document.createElement("div");
    result.className = `${EXTENSION_PREFIX}-score-result`;
    result.setAttribute("aria-live", "polite");

    // Assemble the score controls.
    actions.appendChild(button);
    actions.appendChild(result);

    // Return the completed action area.
    return actions;
  }

  /**
   * Scores the selected inputs against parsed hidden answer keys.
   *
   * @param {Event} event - Click event from the score button.
   */
  function handleScoreClick(event) {
    // Guard against unexpected events from non-button elements.
    const button = event.target;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    // Find the quiz container that owns the clicked button.
    const quiz = button.closest(`.${EXTENSION_PREFIX}-quiz`);
    if (!quiz) {
      return;
    }

    // Score every question that has parsed correct answers.
    const score = calculateQuizScore(quiz);
    const result = quiz.querySelector(`.${EXTENSION_PREFIX}-score-result`);
    if (!result) {
      return;
    }

    // Render a concise score and per-question feedback.
    result.textContent = createScoreMessage(score);
  }

  /**
   * Calculates quiz scoring details from generated answer controls.
   *
   * @param {Element} quiz - Quiz container to score.
   * @returns {{correct: number, total: number, missing: number, unknown: number, details: string[]}} Score details.
   */
  function calculateQuizScore(quiz) {
    // Initialize counters for score reporting.
    const score = {
      correct: 0,
      total: 0,
      missing: 0,
      unknown: 0,
      details: []
    };

    // Evaluate each generated question independently.
    const questions = quiz.querySelectorAll(`.${EXTENSION_PREFIX}-question`);
    for (const question of questions) {
      const questionNumber = Number(question.dataset.questionIndex || "0") + 1;
      const correctLetters = normalizeLetterList(question.dataset.correctLetters || "");
      const selectedLetters = getSelectedLetters(question);

      // Track questions where the output did not include an answer key.
      if (correctLetters.length === 0) {
        score.unknown += 1;
        score.details.push(`${questionNumber}: no answer key found`);
        continue;
      }

      // Count answer-key-backed questions in the total.
      score.total += 1;

      // Report unanswered questions separately from wrong selections.
      if (selectedLetters.length === 0) {
        score.missing += 1;
        score.details.push(`${questionNumber}: unanswered, correct ${formatLetters(correctLetters)}`);
        continue;
      }

      // Compare the selected options to the hidden answer key.
      if (areLetterSetsEqual(selectedLetters, correctLetters)) {
        score.correct += 1;
        score.details.push(`${questionNumber}: correct (${formatLetters(selectedLetters)})`);
      } else {
        score.details.push(`${questionNumber}: ${formatLetters(selectedLetters)} selected, correct ${formatLetters(correctLetters)}`);
      }
    }

    // Return all details needed by the renderer.
    return score;
  }

  /**
   * Reads selected letters from radio buttons or SATA checkboxes.
   *
   * @param {Element} question - Question wrapper to inspect.
   * @returns {string[]} Selected option letters.
   */
  function getSelectedLetters(question) {
    // Gather all checked inputs for both radio and checkbox question types.
    const selectedInputs = question.querySelectorAll("input[type='radio']:checked, input[type='checkbox']:checked");

    // Return selected option letters in DOM order.
    return [...selectedInputs]
      .filter((input) => input instanceof HTMLInputElement)
      .map((input) => input.value);
  }

  /**
   * Normalizes a comma-separated option-letter list.
   *
   * @param {string} value - Comma-separated option letters.
   * @returns {string[]} Normalized option letters.
   */
  function normalizeLetterList(value) {
    // Split the stored dataset value into uppercase option letters.
    return value
      .split(",")
      .map((letter) => letter.trim().toUpperCase())
      .filter(Boolean);
  }

  /**
   * Compares selected and correct letters as exact unordered sets.
   *
   * @param {string[]} selectedLetters - User-selected option letters.
   * @param {string[]} correctLetters - Correct option letters.
   * @returns {boolean} True when the two sets match exactly.
   */
  function areLetterSetsEqual(selectedLetters, correctLetters) {
    // Sort both arrays so checkbox ordering does not affect scoring.
    const selected = [...selectedLetters].sort();
    const correct = [...correctLetters].sort();

    // Different counts cannot be an exact SATA match.
    if (selected.length !== correct.length) {
      return false;
    }

    // Compare each letter after sorting.
    return selected.every((letter, index) => letter === correct[index]);
  }

  /**
   * Formats answer letters for score messages.
   *
   * @param {string[]} letters - Option letters to display.
   * @returns {string} Human-readable option list.
   */
  function formatLetters(letters) {
    // Join letters with commas for SATA and preserve single-letter display.
    return letters.join(", ");
  }

  /**
   * Creates a readable score message for the quiz UI.
   *
   * @param {{correct: number, total: number, missing: number, unknown: number, details: string[]}} score - Score details.
   * @returns {string} Human-readable score summary.
   */
  function createScoreMessage(score) {
    // Explain when scoring is impossible because no answer keys were parsed.
    if (score.total === 0) {
      return "No answer key was found for this output, so the extension cannot score it.";
    }

    // Build the main score summary.
    const parts = [`Score: ${score.correct}/${score.total}`];

    // Include unanswered and unscored counts when they matter.
    if (score.missing > 0) {
      parts.push(`${score.missing} unanswered`);
    }
    if (score.unknown > 0) {
      parts.push(`${score.unknown} without answer keys`);
    }

    // Add concise per-question feedback after the summary.
    return `${parts.join(" | ")}\n${score.details.join("; ")}`;
  }

  /**
   * Builds a single answer option row.
   *
   * @param {string} quizId - Stable quiz id.
   * @param {number} questionIndex - Zero-based question index.
   * @param {string} groupName - Input group name.
   * @param {{letter: string, text: string}} option - Parsed option.
   * @param {string[]} selectedLetters - Previously selected option letters.
   * @param {boolean} isSata - Whether to render a checkbox for SATA.
   * @returns {HTMLLabelElement} Clickable answer option label.
   */
  function buildOptionElement(quizId, questionIndex, groupName, option, selectedLetters, isSata) {
    // Create a label so clicks on the option text toggle the input.
    const label = document.createElement("label");
    label.className = `${EXTENSION_PREFIX}-option`;

    // Configure the input with persistent metadata.
    const input = document.createElement("input");
    input.type = isSata ? "checkbox" : "radio";
    input.name = groupName;
    input.value = option.letter;
    input.checked = selectedLetters.includes(option.letter);
    input.dataset.isSata = String(isSata);
    input.dataset.quizId = quizId;
    input.dataset.questionIndex = String(questionIndex);
    input.addEventListener("change", handleOptionChange);

    // Render the option letter separately for readability.
    const letter = document.createElement("span");
    letter.className = `${EXTENSION_PREFIX}-option-letter`;
    letter.textContent = `${option.letter}.`;

    // Render option text exactly as parsed from ChatGPT output.
    const text = document.createElement("span");
    text.textContent = option.text;

    // Assemble the row.
    label.appendChild(input);
    label.appendChild(letter);
    label.appendChild(text);

    // Return the interactive option.
    return label;
  }

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
      selections[quizId][questionIndex] = question ? getSelectedLetters(question) : [];
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

  // Start after the body exists; content scripts can run before late page hydration.
  if (document.body) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
})();
