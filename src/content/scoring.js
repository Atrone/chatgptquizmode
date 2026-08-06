globalThis.McqQuiz = globalThis.McqQuiz || {};

/**
 * Creates score calculation and answer-data normalization helpers.
 *
 * @param {{EXTENSION_PREFIX: string}} config - Shared scoring configuration.
 * @returns {Record<string, Function>} Quiz scoring service.
 */
globalThis.McqQuiz.createScoring = function createScoring(config) {
  // Keep score selectors aligned with the extension-owned DOM prefix.
  const { EXTENSION_PREFIX } = config;
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
   * Calculates quiz scoring details from generated answer controls.
   *
   * @param {Element} quiz - Quiz container to score.
   * @returns {{correct: number, total: number, missing: number, unknown: number, details: Array<Record<string, unknown>>}} Score details.
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
        score.details.push(createScoreDetail(question, questionNumber, "unknown", selectedLetters, correctLetters));
        continue;
      }

      // Count answer-key-backed questions in the total.
      score.total += 1;

      // Report unanswered questions separately from wrong selections.
      if (selectedLetters.length === 0) {
        score.missing += 1;
        score.details.push(createScoreDetail(question, questionNumber, "unanswered", selectedLetters, correctLetters));
        continue;
      }

      // Compare the selected options to the hidden answer key.
      if (areLetterSetsEqual(selectedLetters, correctLetters)) {
        score.correct += 1;
        score.details.push(createScoreDetail(question, questionNumber, "correct", selectedLetters, correctLetters));
      } else {
        score.details.push(createScoreDetail(question, questionNumber, "incorrect", selectedLetters, correctLetters));
      }
    }

    // Return all details needed by the renderer.
    return score;
  }

  /**
   * Calculates scoring details for a single generated question.
   *
   * @param {Element} question - Question container to score.
   * @returns {{correct: number, total: number, missing: number, unknown: number, details: Array<Record<string, unknown>>}} Score details.
   */
  function calculateQuestionScore(question) {
    // Create the same score shape used by whole-quiz rendering.
    const score = {
      correct: 0,
      total: 0,
      missing: 0,
      unknown: 0,
      details: []
    };

    // Reuse the question metadata already stored on the rendered element.
    const questionNumber = Number(question.dataset.questionIndex || "0") + 1;
    const correctLetters = normalizeLetterList(question.dataset.correctLetters || "");
    const selectedLetters = getSelectedLetters(question);

    // Track questions where the output did not include an answer key.
    if (correctLetters.length === 0) {
      score.unknown += 1;
      score.details.push(createScoreDetail(question, questionNumber, "unknown", selectedLetters, correctLetters));
      return score;
    }

    // Count this answer-key-backed question in the total.
    score.total = 1;

    // Report unanswered questions separately from wrong selections.
    if (selectedLetters.length === 0) {
      score.missing = 1;
      score.details.push(createScoreDetail(question, questionNumber, "unanswered", selectedLetters, correctLetters));
      return score;
    }

    // Compare the selected options to the hidden answer key.
    if (areLetterSetsEqual(selectedLetters, correctLetters)) {
      score.correct = 1;
      score.details.push(createScoreDetail(question, questionNumber, "correct", selectedLetters, correctLetters));
    } else {
      score.details.push(createScoreDetail(question, questionNumber, "incorrect", selectedLetters, correctLetters));
    }

    // Return all details needed by the shared renderer.
    return score;
  }

  /**
   * Creates a structured per-question score detail.
   *
   * @param {Element} question - Question wrapper to inspect.
   * @param {number} questionNumber - One-based question number.
   * @param {string} status - Scoring status for this question.
   * @param {string[]} selectedLetters - User-selected option letters.
   * @param {string[]} correctLetters - Correct option letters.
   * @returns {Record<string, unknown>} Render-ready score detail.
   */
  function createScoreDetail(question, questionNumber, status, selectedLetters, correctLetters) {
    // Package letters and option text so score rendering stays presentation-focused.
    return {
      questionNumber,
      status,
      selectedAnswers: getAnswerSummaries(question, selectedLetters),
      correctAnswers: getAnswerSummaries(question, correctLetters),
      rationale: question.dataset.rationale || ""
    };
  }

  /**
   * Reads option text for selected or correct answer letters.
   *
   * @param {Element} question - Question wrapper to inspect.
   * @param {string[]} letters - Option letters to summarize.
   * @returns {Array<{letter: string, text: string}>} Answer summaries.
   */
  function getAnswerSummaries(question, letters) {
    // Map every input by its answer letter for quick lookup.
    const inputs = [...question.querySelectorAll("input[type='radio'], input[type='checkbox']")]
      .filter((input) => input instanceof HTMLInputElement);

    // Return summaries in the requested letter order.
    return letters.map((letter) => {
      const input = inputs.find((candidate) => candidate.value === letter);
      return {
        letter,
        text: input?.dataset.optionText || ""
      };
    });
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

  // Expose calculation and normalization helpers through one service object.
  return {
    normalizeSavedSelection,
    calculateQuizScore,
    calculateQuestionScore,
    createScoreDetail,
    getAnswerSummaries,
    getSelectedLetters,
    normalizeLetterList,
    areLetterSetsEqual,
    formatLetters
  };
};