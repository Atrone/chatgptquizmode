globalThis.McqQuiz = globalThis.McqQuiz || {};

/**
 * Creates DOM construction and event-presentation helpers for quiz output.
 *
 * @param {Record<string, string>} config - Shared DOM names and attributes.
 * @returns {Record<string, Function>} Quiz UI presentation service.
 */
globalThis.McqQuiz.createUi = function createUi(config) {
  // Resolve ordered services only after their factories have initialized.
  const services = globalThis.McqQuiz.services;
  const { isAnswerLine } = services.parser;
  const { formatTrialRemaining, handlePaywallAction } = services.access;
  const { handleOptionChange } = services.persistence;
  const { normalizeSavedSelection, calculateQuizScore, calculateQuestionScore } = services.scoring;
  const {
    EXTENSION_PREFIX,
    QUIZ_ATTRIBUTE,
    ORIGINAL_OUTPUT_ATTRIBUTE
  } = config;
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
   * Reveals answer-key lines previously hidden by the extension.
   *
   * @param {Element} root - Assistant output root.
   */
  function restoreAnswerLines(root) {
    // Remove only the answer visibility class owned by this extension.
    const hiddenAnswers = root.querySelectorAll(`.${EXTENSION_PREFIX}-hidden-answer`);
    for (const answer of hiddenAnswers) {
      answer.classList.remove(`${EXTENSION_PREFIX}-hidden-answer`);
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
   * @param {Array<{prompt: string, options: Array<{letter: string, text: string}>, correctLetters: string[], rationale: string, isSata: boolean}>} questions - Parsed questions.
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
   * @param {Array<{prompt: string, options: Array<{letter: string, text: string}>, correctLetters: string[], rationale: string, isSata: boolean}>} questions - Parsed questions.
   * @param {Record<string, Record<string, string>>} savedSelections - Stored selections by quiz id.
   * @param {{status?: string, trialRemainingMs?: number}} accessState - Current paywall access state.
   * @returns {HTMLElement} Renderable quiz container.
   */
  function buildQuizElement(quizId, questions, savedSelections, accessState) {
    // Create an extension-owned container for all parsed questions.
    const quiz = document.createElement("section");
    quiz.className = `${EXTENSION_PREFIX}-quiz`;
    quiz.setAttribute(QUIZ_ATTRIBUTE, quizId);

    // Add the quiz title and per-question scoring toggle above the questions.
    const header = buildQuizHeader(quizId);
    quiz.appendChild(header);

    // Recommend a prompt format that lets the parser match answers more reliably.
    quiz.appendChild(buildReliabilityTip());

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
   * Builds the top row for a generated quiz.
   *
   * @param {string} quizId - Stable quiz id.
   * @returns {HTMLElement} Header with title and score-mode toggle.
   */
  function buildQuizHeader(quizId) {
    // Create a flex row so the toggle can sit at the top right of the quiz.
    const header = document.createElement("div");
    header.className = `${EXTENSION_PREFIX}-header`;

    // Add a short label so users understand why controls appeared.
    const title = document.createElement("div");
    title.className = `${EXTENSION_PREFIX}-title`;
    title.textContent = "Select your answer(s)";
    header.appendChild(title);

    // Add the score-mode checkbox requested by the user.
    const toggle = buildScoreEachQuestionToggle(quizId);
    header.appendChild(toggle);

    // Return the assembled quiz header.
    return header;
  }

  /**
   * Builds prompt guidance that improves answer-to-question matching reliability.
   *
   * @returns {HTMLElement} Reliability guidance element.
   */
  function buildReliabilityTip() {
    // Keep the lengthy guidance collapsed until a user wants help.
    const tip = document.createElement("details");
    tip.className = `${EXTENSION_PREFIX}-reliability-tip`;

    // Give the collapsed tip a clear purpose and a short supporting label.
    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="${EXTENSION_PREFIX}-reliability-tip-title">Improve quiz reliability</span>
      <span class="${EXTENSION_PREFIX}-reliability-tip-hint">Prompt formatting tip</span>`;
    tip.appendChild(summary);

    // Separate the recommended prompt text from its explanation.
    const content = document.createElement("div");
    content.className = `${EXTENSION_PREFIX}-reliability-tip-content`;
    const intro = document.createElement("p");
    intro.textContent = "Add this instruction to the end of your prompt:";
    content.appendChild(intro);

    // Highlight the exact instruction so it is easy to scan and copy.
    const instruction = document.createElement("blockquote");
    instruction.className = `${EXTENSION_PREFIX}-reliability-tip-instruction`;
    instruction.textContent = "Add the answer and a short rationale immediately after each question, rather than putting all answers at the end of the response.";
    content.appendChild(instruction);

    // Introduce the longer sample independently from the actionable instruction.
    const exampleLabel = document.createElement("div");
    exampleLabel.className = `${EXTENSION_PREFIX}-reliability-tip-example-label`;
    exampleLabel.textContent = "Example question format";
    content.appendChild(exampleLabel);

    // Preserve line breaks in the example while allowing long lines to wrap.
    const example = document.createElement("pre");
    example.className = `${EXTENSION_PREFIX}-reliability-tip-example`;
    example.textContent = `Question 1

Question Stem

A. Option A
B. Option B
C. Option C
D. Option D

Answer: Option X

Rationale: One to two sentences explaining the answer and the other choices.`;
    content.appendChild(example);
    tip.appendChild(content);

    // Return the completed guidance element.
    return tip;
  }

  /**
   * Builds the checkbox that switches between quiz-level and per-question scoring.
   *
   * @param {string} quizId - Stable quiz id.
   * @returns {HTMLLabelElement} Label containing the checkbox.
   */
  function buildScoreEachQuestionToggle(quizId) {
    // Create a label so clicking the text toggles the checkbox too.
    const label = document.createElement("label");
    label.className = `${EXTENSION_PREFIX}-score-mode-toggle`;

    // Configure the checkbox with the owning quiz id for event handling.
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.quizId = quizId;
    input.addEventListener("change", handleScoreEachQuestionToggle);

    // Add the visible toggle text.
    const text = document.createElement("span");
    text.textContent = "Score each question";

    // Assemble and return the clickable toggle.
    label.appendChild(input);
    label.appendChild(text);
    return label;
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
    actions.appendChild(buildPaywallButton("Pay Now - $5", "openPaymentPage", true));
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
   * Builds one answer-selection question group.
   *
   * @param {string} quizId - Stable quiz id.
   * @param {{prompt: string, options: Array<{letter: string, text: string}>, correctLetters: string[], rationale: string, isSata: boolean}} question - Parsed question.
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
    wrapper.dataset.rationale = question.rationale || "";
    wrapper.dataset.isSata = String(question.isSata);

    // Add the question number on its own line above the prompt.
    const number = document.createElement("div");
    number.className = `${EXTENSION_PREFIX}-question-number`;
    number.textContent = String(questionIndex + 1);
    wrapper.appendChild(number);

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

    // Prepare a hidden score action that appears when per-question scoring is enabled.
    const scoreActions = buildQuestionScoreActions(quizId, questionIndex);
    wrapper.appendChild(scoreActions);

    // Return the complete question block.
    return wrapper;
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
   * Builds a per-question score button and result container.
   *
   * @param {string} quizId - Stable quiz id.
   * @param {number} questionIndex - Zero-based question index.
   * @returns {HTMLElement} Per-question score action area.
   */
  function buildQuestionScoreActions(quizId, questionIndex) {
    // Create an action row that starts hidden until the quiz-level toggle is checked.
    const actions = document.createElement("div");
    actions.className = `${EXTENSION_PREFIX}-question-actions`;
    actions.hidden = true;

    // Add a score button scoped to this question only.
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${EXTENSION_PREFIX}-score-button ${EXTENSION_PREFIX}-question-score-button`;
    button.dataset.quizId = quizId;
    button.dataset.questionIndex = String(questionIndex);
    button.textContent = "Score";
    button.addEventListener("click", handleQuestionScoreClick);

    // Reserve a live result area directly under the question.
    const result = document.createElement("div");
    result.className = `${EXTENSION_PREFIX}-score-result ${EXTENSION_PREFIX}-question-score-result`;
    result.setAttribute("aria-live", "polite");

    // Assemble and return the per-question controls.
    actions.appendChild(button);
    actions.appendChild(result);
    return actions;
  }

  /**
   * Switches between whole-quiz scoring and per-question scoring controls.
   *
   * @param {Event} event - Change event from the score-mode checkbox.
   */
  function handleScoreEachQuestionToggle(event) {
    // Guard against unexpected events from non-checkbox elements.
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    // Locate the quiz that owns the checkbox so multiple quizzes stay independent.
    const quiz = input.closest(`.${EXTENSION_PREFIX}-quiz`);
    if (!quiz) {
      return;
    }

    // Toggle a state class for styling hooks and make the two scoring modes exclusive.
    const shouldScoreEachQuestion = input.checked;
    quiz.classList.toggle(`${EXTENSION_PREFIX}-score-each-question-enabled`, shouldScoreEachQuestion);
    setScoreModeVisibility(quiz, shouldScoreEachQuestion);
  }

  /**
   * Shows the active scoring controls and hides the inactive scoring controls.
   *
   * @param {Element} quiz - Quiz container whose controls should be updated.
   * @param {boolean} shouldScoreEachQuestion - Whether per-question scoring is enabled.
   */
  function setScoreModeVisibility(quiz, shouldScoreEachQuestion) {
    // Hide the bottom whole-quiz action whenever per-question scoring is enabled.
    const quizActions = quiz.querySelector(`.${EXTENSION_PREFIX}-actions`);
    if (quizActions) {
      quizActions.hidden = shouldScoreEachQuestion;
    }

    // Show or hide every per-question action row together.
    const questionActions = quiz.querySelectorAll(`.${EXTENSION_PREFIX}-question-actions`);
    for (const actions of questionActions) {
      actions.hidden = !shouldScoreEachQuestion;
    }
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
    const result = button.parentElement?.querySelector(`.${EXTENSION_PREFIX}-score-result`);
    if (!result) {
      return;
    }

    // Render structured feedback so answers and rationales are easy to scan.
    renderScoreResult(result, score);
  }

  /**
   * Scores only the question that owns the clicked score button.
   *
   * @param {Event} event - Click event from a per-question score button.
   */
  function handleQuestionScoreClick(event) {
    // Guard against unexpected events from non-button elements.
    const button = event.target;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    // Find the question container that owns the clicked button.
    const question = button.closest(`.${EXTENSION_PREFIX}-question`);
    if (!question) {
      return;
    }

    // Find the local result container under this same question.
    const result = question.querySelector(`.${EXTENSION_PREFIX}-question-score-result`);
    if (!result) {
      return;
    }

    // Render feedback for this question without including the rest of the quiz.
    const score = calculateQuestionScore(question);
    renderScoreResult(result, score);
  }

  /**
   * Renders readable score feedback for the quiz UI.
   *
   * @param {Element} result - Score result container.
   * @param {{correct: number, total: number, missing: number, unknown: number, details: Array<Record<string, unknown>>}} score - Score details.
   */
  function renderScoreResult(result, score) {
    // Clear the previous score so repeated clicks refresh cleanly.
    result.replaceChildren();

    // Explain when scoring is impossible because no answer keys were parsed.
    if (score.total === 0) {
      const emptyMessage = document.createElement("div");
      emptyMessage.className = `${EXTENSION_PREFIX}-score-summary`;
      emptyMessage.textContent = "No answer key was found for this output, so the extension cannot score it.";
      result.appendChild(emptyMessage);
      return;
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

    // Render the main summary before the detailed question cards.
    const summary = document.createElement("div");
    summary.className = `${EXTENSION_PREFIX}-score-summary`;
    summary.textContent = parts.join(" | ");
    result.appendChild(summary);

    // Add one detail card per generated question.
    const details = document.createElement("ol");
    details.className = `${EXTENSION_PREFIX}-score-details`;
    for (const detail of score.details) {
      details.appendChild(buildScoreDetailElement(detail));
    }
    result.appendChild(details);
  }

  /**
   * Builds one structured score detail item.
   *
   * @param {Record<string, unknown>} detail - Render-ready question feedback.
   * @returns {HTMLLIElement} Score detail list item.
   */
  function buildScoreDetailElement(detail) {
    // Create a status-specific list item for styling.
    const item = document.createElement("li");
    item.className = `${EXTENSION_PREFIX}-score-detail ${EXTENSION_PREFIX}-score-detail-${detail.status}`;

    // Add the question status line.
    const title = document.createElement("div");
    title.className = `${EXTENSION_PREFIX}-score-detail-title`;
    title.textContent = `Question ${detail.questionNumber}: ${getScoreStatusLabel(String(detail.status || ""))}`;
    item.appendChild(title);

    // Add the selected and correct answer rows.
    item.appendChild(buildAnswerFeedbackLine("Your answer", detail.selectedAnswers, "None selected"));
    if (detail.status !== "unknown") {
      item.appendChild(buildAnswerFeedbackLine("Correct answer", detail.correctAnswers, "Unavailable"));
    }

    // Add the rationale when the assistant output provided one.
    if (detail.rationale) {
      const rationale = document.createElement("div");
      rationale.className = `${EXTENSION_PREFIX}-score-rationale`;
      rationale.textContent = String(detail.rationale);
      item.appendChild(rationale);
    }

    // Return the finished score item.
    return item;
  }

  /**
   * Builds a labelled answer feedback row.
   *
   * @param {string} label - Row label.
   * @param {unknown} answers - Answer summaries to render.
   * @param {string} emptyText - Text to show when no answers are present.
   * @returns {HTMLElement} Answer feedback row.
   */
  function buildAnswerFeedbackLine(label, answers, emptyText) {
    // Normalize unknown detail data into an array.
    const answerList = Array.isArray(answers) ? answers : [];
    const row = document.createElement("div");
    row.className = `${EXTENSION_PREFIX}-answer-feedback`;

    // Render the row label before answer text.
    const labelElement = document.createElement("span");
    labelElement.className = `${EXTENSION_PREFIX}-answer-feedback-label`;
    labelElement.textContent = `${label}:`;
    row.appendChild(labelElement);

    // Render either formatted answers or the empty state.
    const value = document.createElement("span");
    value.className = `${EXTENSION_PREFIX}-answer-feedback-value`;
    value.textContent = answerList.length > 0 ? formatAnswerSummaries(answerList) : emptyText;
    row.appendChild(value);

    // Return the completed answer row.
    return row;
  }

  /**
   * Formats answer summaries with letters and option text.
   *
   * @param {Array<{letter?: string, text?: string}>} answers - Answer summaries to format.
   * @returns {string} Human-readable answer text.
   */
  function formatAnswerSummaries(answers) {
    // Include option text when available, falling back to the letter only.
    return answers
      .map((answer) => answer.text ? `${answer.letter}. ${answer.text}` : String(answer.letter || ""))
      .filter(Boolean)
      .join("; ");
  }

  /**
   * Converts score statuses into readable labels.
   *
   * @param {string} status - Score detail status.
   * @returns {string} Human-readable status label.
   */
  function getScoreStatusLabel(status) {
    // Keep labels short so the answer details carry the explanation.
    if (status === "correct") {
      return "Correct";
    }
    if (status === "incorrect") {
      return "Incorrect";
    }
    if (status === "unanswered") {
      return "Unanswered";
    }

    // Unknown means no answer key was parsed for that question.
    return "Not scored";
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
    input.dataset.optionText = option.text;
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

  // Expose DOM construction and presentation helpers through one service object.
  return {
    hideAnswerLines,
    restoreAnswerLines,
    hideOriginalOutput,
    restoreOriginalOutput,
    createQuizId,
    getElementIndex,
    hashString,
    buildQuizElement,
    buildQuizHeader,
    buildReliabilityTip,
    buildScoreEachQuestionToggle,
    buildTrialNotice,
    buildPaywallElement,
    buildPaywallButton,
    getPaywallMessage,
    buildQuestionElement,
    buildScoreActions,
    buildQuestionScoreActions,
    handleScoreEachQuestionToggle,
    setScoreModeVisibility,
    handleScoreClick,
    handleQuestionScoreClick,
    renderScoreResult,
    buildScoreDetailElement,
    buildAnswerFeedbackLine,
    formatAnswerSummaries,
    getScoreStatusLabel,
    buildOptionElement
  };
};