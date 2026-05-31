const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const CONTENT_SCRIPT_PATH = join(__dirname, "..", "content.js");
const CONTENT_SCRIPT_SOURCE = readFileSync(CONTENT_SCRIPT_PATH, "utf8");
const EXTENSION_PREFIX = "mcq-radio-extension";

/**
 * Converts VM-created arrays and objects into this test file's realm.
 *
 * @param {unknown} value - Value returned from the content-script VM.
 * @returns {unknown} JSON-safe value with local prototypes.
 */
function toPlain(value) {
  // Unit assertions only compare serializable parser and storage payloads.
  return JSON.parse(JSON.stringify(value));
}

/**
 * Adds innerText support that is sufficient for content-script parsing tests.
 *
 * @param {Window} window - JSDOM window under test.
 */
function installInnerTextPolyfill(window) {
  // JSDOM intentionally omits layout-driven innerText, so mirror textContent.
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      // Return the node text as browsers do for simple rendered markup.
      return this.textContent;
    },
    set(value) {
      // Keep assignments useful for code paths that write innerText.
      this.textContent = value;
    }
  });
}

/**
 * Creates a Chrome API mock with async storage and callback runtime messaging.
 *
 * @param {Record<string, unknown>} storage - Mutable storage backing object.
 * @param {Array<Record<string, unknown>>} runtimeResponses - Queued runtime responses.
 * @returns {{chrome: Record<string, unknown>, sentMessages: Array<Record<string, unknown>>}} Mocked Chrome API and calls.
 */
function createChromeMock(storage, runtimeResponses = []) {
  // Record runtime messages so tests can assert extension API routing.
  const sentMessages = [];

  // Return a minimal Chrome extension API used by the content script.
  const chrome = {
    storage: {
      local: {
        async get(key) {
          // Match Chrome's object result shape for string keys.
          if (typeof key === "string") {
            return {
              [key]: storage[key]
            };
          }

          // Support array reads for future tests without changing behavior.
          if (Array.isArray(key)) {
            return key.reduce((result, nextKey) => {
              result[nextKey] = storage[nextKey];
              return result;
            }, {});
          }

          // Object defaults are merged with stored values like Chrome storage.
          return Object.keys(key || {}).reduce((result, nextKey) => {
            result[nextKey] = storage[nextKey] ?? key[nextKey];
            return result;
          }, {});
        },
        async set(values) {
          // Persist all values into the mutable backing object.
          Object.assign(storage, values);
        }
      }
    },
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        // Save the outgoing message for later assertions.
        sentMessages.push(message);
        const response = runtimeResponses.length > 0 ? runtimeResponses.shift() : { ok: true, status: "paid" };

        // Simulate Chrome's callback-based runtime response.
        callback(response);
      }
    }
  };

  // Return both the mock API and the captured message list.
  return { chrome, sentMessages };
}

/**
 * Loads the content script in an isolated JSDOM page with test helpers exposed.
 *
 * @param {{url?: string, storage?: Record<string, unknown>, runtimeResponses?: Array<Record<string, unknown>>}} options - Harness options.
 * @returns {{window: Window, document: Document, api: Record<string, Function>, storage: Record<string, unknown>, sentMessages: Array<Record<string, unknown>>}} Loaded harness.
 */
function loadContentHarness(options = {}) {
  // Create a page that looks like a ChatGPT conversation URL.
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: options.url || "https://chatgpt.com/c/unit-test",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  const storage = options.storage || {};
  const chromeMock = createChromeMock(storage, options.runtimeResponses || []);

  // Install browser globals that the content script expects.
  installInnerTextPolyfill(window);
  window.chrome = chromeMock.chrome;
  window.__MCQ_RADIO_EXTENSION_ENABLE_TEST_API__ = true;

  // Execute the real content script and return its test-only helper API.
  dom.getInternalVMContext().eval(CONTENT_SCRIPT_SOURCE);
  return {
    window,
    document: window.document,
    api: window.__mcqRadioExtensionTestApi,
    storage,
    sentMessages: chromeMock.sentMessages
  };
}

test("parses MCQ, SATA, answer-key, and rationale variants", () => {
  // Load parser helpers from the real content script.
  const { api } = loadContentHarness();

  // Verify a standard single-answer question with a trailing rationale.
  const single = api.parseMultipleChoiceQuestions(`
    What is the capital of France?
    A. Berlin
    B. Madrid
    C. Paris
    D. Rome
    Answer: C - because Paris is the capital.
  `);
  assert.equal(single.length, 1);
  assert.equal(single[0].prompt, "What is the capital of France?");
  assert.deepEqual(toPlain(single[0].correctLetters), ["C"]);
  assert.equal(single[0].rationale, "because Paris is the capital.");

  // Verify SATA prompts and multi-letter answer keys.
  const sata = api.parseMultipleChoiceQuestions(`
    SATA: Which findings should be reported? Select all that apply.
    A. Chest pain
    B. Normal temperature
    C. Shortness of breath
    D. New confusion
    Correct answers: A, C, D
  `);
  assert.equal(sata[0].isSata, true);
  assert.deepEqual(toPlain(sata[0].correctLetters), ["A", "C", "D"]);

  // Verify grouped answer keys are assigned across multiple questions.
  const grouped = api.parseMultipleChoiceQuestions(`
    1. First question?
    A. Alpha
    B. Beta
    2. Second question?
    A. Gamma
    B. Delta
    Answer key: 1. B; 2. A
    Rationales:
    1. Beta is correct.
    2. Gamma is correct.
  `);
  assert.deepEqual(toPlain(grouped.map((question) => question.correctLetters)), [["B"], ["A"]]);
  assert.deepEqual(toPlain(grouped.map((question) => question.rationale)), ["Beta is correct.", "Gamma is correct."]);

  // Verify final answer sections with numbered lines assign keys to every question.
  const finalNumberedKey = api.parseMultipleChoiceQuestions(`
    1. First final-key question?
    A. Alpha
    B. Beta
    2. Second final-key question?
    A. Gamma
    B. Delta
    Answers:
    1. B
    2. A
  `);
  assert.deepEqual(toPlain(finalNumberedKey.map((question) => question.correctLetters)), [["B"], ["A"]]);

  // Verify compact whitespace-separated answer keys still map across questions.
  const compactFinalKey = api.parseMultipleChoiceQuestions(`
    1. First compact-key question?
    A. Alpha
    B. Beta
    2. Second compact-key question?
    A. Gamma
    B. Delta
    Answer key: 1. B 2. A
  `);
  assert.deepEqual(toPlain(compactFinalKey.map((question) => question.correctLetters)), [["B"], ["A"]]);
});

test("keeps pharmacokinetic range options attached to their questions", () => {
  // Load parser helpers from the real content script.
  const { api } = loadContentHarness();

  // Verify compact and spaced ranges do not become accidental question starts.
  const questions = api.parseMultipleChoiceQuestions(`
    32. What is the listed onset of atovaquone alone? A. 8 - 24 hr B. 1 - 2 weeks C. 1.5 - 4 hr D. Less than 24 hr Answer: A. 8 - 24 hr Rationale: Atovaquone alone has an onset of 8 - 24 hours.
    33. What is the listed peak/Tmax of atovaquone alone?
    A. 24 - 96 hr
    B. 1 - 2 hr
    C. 17 hr
    D. 1.5 - 4 hr
    Answer: A. 24 - 96 hr
    Rationale: Atovaquone alone peaks at 24 - 96 hours.
    34. What is the listed half-life of doxycycline?
    A. 18 - 22 hr
    B. 3 - 5 days
    C. 40 days
    D. 21 - 22 days
    Answer: A. 18 - 22 hr
    Rationale: Doxycycline's T1/2 is 18 - 22 hours.
  `);

  assert.equal(questions.length, 3);
  assert.deepEqual(toPlain(questions.map((question) => question.correctLetters)), [["A"], ["A"], ["A"]]);
  assert.deepEqual(toPlain(questions.map((question) => question.options.map((option) => option.letter))), [
    ["A", "B", "C", "D"],
    ["A", "B", "C", "D"],
    ["A", "B", "C", "D"]
  ]);
  assert.equal(questions[2].options[3].text, "21 - 22 days");
});

test("covers low-level parsing and formatting helpers", () => {
  // Load helper functions from the content script.
  const { api, window } = loadContentHarness();

  // Option parsing cleans inline explanations and normalizes option letters.
  assert.deepEqual(toPlain(api.parseOptionLine("a) Photosynthesis rationale: extra")), {
    letter: "A",
    text: "Photosynthesis"
  });
  assert.equal(api.parseOptionLine("Not an option"), null);
  assert.deepEqual(toPlain(api.parseQuestionStart("Question 3: Which value?")), { index: 2, text: "Which value?" });
  assert.deepEqual(toPlain(api.extractInlineAnswerKey("Which value? Correct answers: A and C")), {
    cleanText: "Which value?",
    letters: ["A", "C"]
  });

  // Answer parsing separates grouped keys and rationale text.
  assert.deepEqual(toPlain(api.parseAnswerEntry("Answers: A, C")), {
    groups: [["A", "C"]],
    isPotentialSequence: true,
    rationale: ""
  });
  assert.equal(api.isAnswerKeyHeading("Answers:"), true);
  assert.deepEqual(toPlain(api.parseNumberedAnswerKeyEntry("2. D - because it fits")), {
    index: 1,
    letters: ["D"],
    rationale: "because it fits"
  });
  assert.deepEqual(toPlain(api.parseNumberedAnswerEntry("Question 2 Answer: D - because it fits")), {
    index: 1,
    letters: ["D"],
    rationale: "because it fits"
  });
  assert.deepEqual(toPlain(api.splitAnswerBodyRationale("B - because it is safest")), {
    answerText: "B",
    rationale: "because it is safest"
  });
  assert.deepEqual(toPlain(api.parseAnswerGroups("1. A, C; 2. B")), [["A", "C"], ["B"]]);
  assert.deepEqual(toPlain(api.extractUniqueLetters("A, a, C and H")), ["A", "C", "H"]);

  // Boundary and display helpers keep parser output concise.
  assert.equal(api.isQuestionSectionHeading("Questions 1-10"), true);
  assert.deepEqual(toPlain(api.parseStandaloneQuestionLabel("Question 4:")), { index: 3 });
  assert.deepEqual(toPlain(api.parseRationaleEntry("Rationales:")), { text: "", isPlural: true });
  assert.deepEqual(toPlain(api.parseNumberedRationale("2) Because.")), { index: 1, text: "Because." });
  assert.equal(api.hasSataCue(["Choose all that apply."]), true);
  assert.equal(api.isExplanationBoundary("Next steps:"), true);
  assert.equal(api.createPrompt([], 2), "Question 3");
  assert.equal(api.isAnswerLine("Correct answer: B"), true);
  assert.equal(api.formatTrialRemaining(65 * 60000), "2 hours");
  assert.equal(api.formatTrialRemaining(30 * 1000), "1 minute");
  assert.equal(api.getErrorMessage(new window.Error("boom")), "boom");
});

test("renders quiz controls, hides source output, and scores selections", () => {
  // Create a browser-like page for DOM rendering.
  const { document, api } = loadContentHarness();
  const questions = api.parseMultipleChoiceQuestions(`
    What is 2 + 2?
    A. 3
    B. 4
    Answer: B
    Select all prime numbers. Select all that apply.
    A. 2
    B. 4
    C. 5
    Correct answers: A, C
  `);

  // Build a quiz and verify saved selections restore both radio and checkbox state.
  const quiz = api.buildQuizElement("quiz-test", questions, {
    "quiz-test": {
      0: "B",
      1: ["A", "C"]
    }
  }, { status: "trial", trialRemainingMs: 3600000 });
  document.body.appendChild(quiz);
  assert.equal(quiz.querySelectorAll(`.${EXTENSION_PREFIX}-question`).length, 2);
  assert.deepEqual(
    Array.from(quiz.querySelectorAll(`.${EXTENSION_PREFIX}-question-number`)).map((node) => node.textContent),
    ["1", "2"]
  );
  assert.equal(quiz.querySelectorAll("input[type='radio']:checked").length, 1);
  assert.equal(quiz.querySelectorAll("input[type='checkbox']:checked").length, 2);
  assert.match(quiz.textContent, /left in your free trial/);

  // Score the restored selections and render readable feedback.
  const score = api.calculateQuizScore(quiz);
  assert.equal(score.correct, 2);
  assert.equal(score.total, 2);
  const result = document.createElement("div");
  api.renderScoreResult(result, score);
  assert.match(result.textContent, /Score: 2\/2/);
  assert.match(result.textContent, /Question 1: Correct/);

  // Toggle per-question scoring visibility.
  api.setScoreModeVisibility(quiz, true);
  assert.equal(quiz.querySelector(`.${EXTENSION_PREFIX}-actions`).hidden, true);
  assert.equal(quiz.querySelector(`.${EXTENSION_PREFIX}-question-actions`).hidden, false);
});

test("hides answer lines, original output, and extension-owned text", () => {
  // Create assistant markup with answer-key text and extension UI.
  const { document, api } = loadContentHarness();
  const root = document.createElement("div");
  root.setAttribute("data-message-author-role", "assistant");
  root.innerHTML = `
    <p>Question?</p>
    <p>A. One</p>
    <p>B. Two</p>
    <p>Answer: B</p>
  `;
  document.body.appendChild(root);
  const quiz = document.createElement("section");
  quiz.className = `${EXTENSION_PREFIX}-quiz`;
  quiz.textContent = "Extension text";
  root.appendChild(quiz);

  // Hide answer-key lines and original output while keeping quiz text ignored by parsing.
  api.hideAnswerLines(root);
  assert.equal(root.querySelectorAll(`.${EXTENSION_PREFIX}-hidden-answer`).length, 1);
  api.hideOriginalOutput(root, quiz);
  assert.equal(root.querySelectorAll(`[data-${EXTENSION_PREFIX}-original-output]`).length, 4);
  assert.doesNotMatch(api.getVisibleText(root), /Extension text/);

  // Restore original output and remove stale generated quiz nodes.
  api.restoreOriginalOutput(root);
  assert.equal(root.querySelectorAll(`[data-${EXTENSION_PREFIX}-original-output]`).length, 0);
  api.removeExistingQuiz(root);
  assert.equal(root.querySelectorAll(`.${EXTENSION_PREFIX}-quiz`).length, 0);
});

test("processes assistant roots for paid and locked access states", async () => {
  // Exercise the high-level assistant processing path for paid users.
  const paidHarness = loadContentHarness({
    runtimeResponses: [{ ok: true, status: "paid" }]
  });
  const paidRoot = paidHarness.document.createElement("div");
  paidRoot.setAttribute("data-message-author-role", "assistant");
  paidRoot.innerHTML = `
    <p>Question?</p>
    <p>A. One</p>
    <p>B. Two</p>
    <p>Answer: B</p>
  `;
  paidHarness.document.body.appendChild(paidRoot);
  await paidHarness.api.processAssistantRoot(paidRoot);
  assert.equal(paidRoot.querySelectorAll(`.${EXTENSION_PREFIX}-quiz`).length, 1);
  assert.match(paidRoot.textContent, /Select your answer/);

  // Exercise the locked path to confirm paywall rendering replaces quiz controls.
  const lockedHarness = loadContentHarness({
    runtimeResponses: [{ ok: true, status: "locked", trialRemainingMs: 0 }]
  });
  const lockedRoot = lockedHarness.document.createElement("div");
  lockedRoot.setAttribute("data-message-author-role", "assistant");
  lockedRoot.innerHTML = `
    <p>Question?</p>
    <p>A. One</p>
    <p>B. Two</p>
    <p>Answer: B</p>
  `;
  lockedHarness.document.body.appendChild(lockedRoot);
  await lockedHarness.api.processAssistantRoot(lockedRoot);
  assert.equal(lockedRoot.querySelectorAll(`.${EXTENSION_PREFIX}-paywall`).length, 1);
  assert.match(lockedRoot.textContent, /Unlock ChatGPT Quiz Mode/);
});

test("stores option changes and mirrors conversation context", async () => {
  // Build a SATA question so change handling stores an array of selected letters.
  const { document, api, storage } = loadContentHarness();
  const question = {
    prompt: "Select all primes.",
    options: [
      { letter: "A", text: "2" },
      { letter: "B", text: "4" },
      { letter: "C", text: "5" }
    ],
    correctLetters: ["A", "C"],
    rationale: "",
    isSata: true
  };
  const element = api.buildQuestionElement("quiz-store", question, 0, {});
  document.body.appendChild(element);

  // Select two checkboxes and dispatch the normal change handler.
  const inputs = element.querySelectorAll("input[type='checkbox']");
  inputs[0].checked = true;
  inputs[2].checked = true;
  await api.handleOptionChange({ target: inputs[2] });

  // Verify storage and hidden context mirror the same conversation-scoped state.
  const key = api.getStorageKey();
  assert.deepEqual(toPlain(storage[key]), {
    "quiz-store": {
      0: ["A", "C"]
    }
  });
  const context = document.getElementById("mcq-radio-extension-conversation-context");
  assert.equal(context.dataset.storageKey, key);
  assert.deepEqual(JSON.parse(context.textContent), toPlain(storage[key]));
});

test("handles paywall helpers, access caching, placeholders, and mutation ownership", async () => {
  // Load the content script with one access-state response to verify caching.
  const { document, window, api, sentMessages } = loadContentHarness({
    runtimeResponses: [{ ok: true, status: "trial", trialRemainingMs: 60000 }]
  });
  const firstAccess = await api.readAccessState(false);
  const secondAccess = await api.readAccessState(false);
  assert.equal(firstAccess.status, "trial");
  assert.equal(secondAccess.status, "trial");
  assert.equal(sentMessages.length, 1);
  assert.equal(api.isAccessLocked({ status: "unknown" }), true);
  assert.equal(api.getPaywallMessage({ status: "unknown" }).startsWith("Your 24-hour trial has ended"), true);

  // Verify streaming placeholders are reused and removed.
  const root = document.createElement("div");
  root.setAttribute("data-message-author-role", "assistant");
  document.body.appendChild(root);
  const placeholder = api.ensureStreamingPlaceholder(root);
  assert.equal(api.ensureStreamingPlaceholder(root), placeholder);
  api.removeStreamingPlaceholder(root);
  assert.equal(root.querySelectorAll(`.${EXTENSION_PREFIX}-streaming-placeholder`).length, 0);

  // Confirm mutation helpers locate assistant roots and ignore extension-owned changes.
  const child = document.createElement("p");
  root.appendChild(child);
  assert.equal(api.findAssistantRoot(child), root);
  const mutation = {
    target: root,
    addedNodes: [placeholder],
    removedNodes: []
  };
  assert.equal(api.isExtensionMutation(mutation), true);

  // Confirm explicit paywall status updates and runtime unavailable failures.
  const status = document.createElement("div");
  api.setPaywallStatus(status, "Checking");
  assert.equal(status.textContent, "Checking");
  const noRuntimeHarness = loadContentHarness();
  noRuntimeHarness.window.chrome.runtime.sendMessage = null;
  await assert.rejects(noRuntimeHarness.api.sendPaywallMessage("getAccessState"), /runtime is unavailable/);

  // Keep the window referenced so timer-backed helpers use the same DOM globals.
  assert.equal(window.document, document);
});
