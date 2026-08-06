const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const CONTENT_SCRIPT_PATHS = [
  join(__dirname, "..", "src", "content", "parser.js"),
  join(__dirname, "..", "src", "content", "access.js"),
  join(__dirname, "..", "src", "content", "persistence.js"),
  join(__dirname, "..", "src", "content", "scoring.js"),
  join(__dirname, "..", "src", "content", "ui.js"),
  join(__dirname, "..", "content.js")
];

/**
 * Reads one ordered content-script source for the JSDOM harness.
 *
 * @param {string} scriptPath - Absolute source file path.
 * @returns {string} JavaScript source text.
 */
function readContentScriptSource(scriptPath) {
  // Match Chrome's classic-script loading by preserving each file verbatim.
  return readFileSync(scriptPath, "utf8");
}

const CONTENT_SCRIPT_SOURCES = CONTENT_SCRIPT_PATHS.map(readContentScriptSource);
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

  // Execute content sources in the same order declared by the MV3 manifest.
  for (const contentScriptSource of CONTENT_SCRIPT_SOURCES) {
    dom.getInternalVMContext().eval(contentScriptSource);
  }
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

test("keeps repeated single-answer option text from turning questions into SATA", () => {
  // Reproduce answer lines whose option text contains the standalone article "a".
  const { api } = loadContentHarness();
  const questions = api.parseMultipleChoiceQuestions(`
    Question 1:
    Which assessment finding is most characteristic of placenta previa?
    A. Painful vaginal bleeding with a firm, tender uterus
    B. Painless, bright-red vaginal bleeding with a soft uterus
    C. Dark vaginal bleeding accompanied by frequent contractions
    D. Absent vaginal bleeding with sudden maternal hypotension
    Answer: B. Painless, bright-red vaginal bleeding with a soft uterus.
    Rationale: Placenta previa typically causes painless, bright-red bleeding, and the uterus usually remains soft and nontender.
    Question 2:
    Which finding would most strongly support a diagnosis of placental abruption rather than placenta previa?
    A. Soft, relaxed, nontender uterus
    B. Painless, bright-red vaginal bleeding
    C. Abdominal pain with a firm, tender uterus
    D. Fetal malpresentation without uterine contractions
    Answer: C. Abdominal pain with a firm, tender uterus.
    Rationale: Placental abruption classically causes abdominal or back pain, uterine tenderness, increased uterine tone, and frequent contractions.
    Question 3:
    A client at 34 weeks' gestation arrives with painless vaginal bleeding. Placenta previa is suspected. Which nursing action is most important?
    A. Perform a digital vaginal examination to assess cervical dilation
    B. Apply an internal fetal scalp electrode
    C. Assess maternal vital signs and initiate continuous fetal monitoring
    D. Encourage the client to walk to determine whether bleeding increases
    Answer: C. Assess maternal vital signs and initiate continuous fetal monitoring.
    Rationale: A digital vaginal examination is contraindicated because it may disrupt the placenta and cause severe hemorrhage.
    Question 4:
    A postpartum client has heavy vaginal bleeding and a boggy uterus. Which action should the nurse perform first?
    A. Massage the uterine fundus
    B. Prepare the client for immediate hysterectomy
    C. Inspect the birth canal for lacerations
    D. Administer methylergonovine without checking blood pressure
    Answer: A. Massage the uterine fundus.
    Rationale: A boggy uterus indicates uterine atony, the leading cause of early postpartum hemorrhage.
    Question 5:
    A postpartum client continues to bleed heavily despite fundal massage and oxytocin. The uterus remains boggy. The client has a history of asthma. Which medication should the nurse question?
    A. Tranexamic acid
    B. Carboprost
    C. Misoprostol
    D. Additional oxytocin as prescribed
    Answer: B. Carboprost.
    Rationale: Carboprost is a prostaglandin that can cause bronchoconstriction and should be avoided in clients with asthma.
  `);

  // Every item has one explicit answer and must therefore render as a radio-button question.
  assert.equal(questions.length, 5);
  assert.deepEqual(toPlain(questions.map((question) => question.correctLetters)), [["B"], ["C"], ["C"], ["A"], ["B"]]);
  assert.deepEqual(toPlain(questions.map((question) => question.isSata)), [false, false, false, false, false]);
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
  // Keep the long reliability guidance collapsed and split into scannable sections.
  const reliabilityTip = quiz.querySelector(`.${EXTENSION_PREFIX}-reliability-tip`);
  assert.equal(reliabilityTip.tagName, "DETAILS");
  assert.equal(reliabilityTip.open, false);
  assert.match(reliabilityTip.querySelector("summary").textContent, /Improve quiz reliability/);
  assert.match(
    reliabilityTip.querySelector(`.${EXTENSION_PREFIX}-reliability-tip-instruction`).textContent,
    /immediately after each question/
  );
  assert.match(
    reliabilityTip.querySelector(`.${EXTENSION_PREFIX}-reliability-tip-example`).textContent,
    /Answer: Option X[\s\S]*Rationale:/
  );

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

/**
 * Verifies ChatGPT text-selection UI does not rebuild a completed quiz.
 */
test("ignores highlight wrappers and selection popups with unchanged source text", async () => {
  // Render a completed quiz before reproducing ChatGPT's selection-related DOM changes.
  const { document, api } = loadContentHarness({
    runtimeResponses: [{ ok: true, status: "paid" }]
  });
  const root = document.createElement("div");
  root.setAttribute("data-message-author-role", "assistant");
  root.innerHTML = `
    <p>Which value is correct?</p>
    <p>A. Alpha</p>
    <p>B. Beta</p>
    <p>Answer: B</p>
  `;
  document.body.appendChild(root);
  await api.processAssistantRoot(root);
  const originalQuiz = root.querySelector(`.${EXTENSION_PREFIX}-quiz`);

  // Simulate ChatGPT wrapping selected response text while preserving its visible content.
  const prompt = root.querySelector("p");
  const originalText = prompt.firstChild;
  const highlight = document.createElement("span");
  highlight.textContent = originalText.textContent;
  prompt.replaceChild(highlight, originalText);
  api.handleMutations([{
    target: prompt,
    addedNodes: [highlight],
    removedNodes: [originalText],
    type: "childList"
  }]);

  // Simulate the response-selection popup, whose button text is excluded from quiz parsing.
  const selectionButton = document.createElement("button");
  selectionButton.textContent = "Ask ChatGPT";
  prompt.appendChild(selectionButton);
  api.handleMutations([{
    target: prompt,
    addedNodes: [selectionButton],
    removedNodes: [],
    type: "childList"
  }]);

  // The existing quiz must remain visible without returning to the streaming placeholder.
  assert.equal(root.querySelector(`.${EXTENSION_PREFIX}-quiz`), originalQuiz);
  assert.equal(root.querySelectorAll(`.${EXTENSION_PREFIX}-streaming-placeholder`).length, 0);
  assert.equal(api.hasAssistantSourceTextChanged(root), false);
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

/**
 * Verifies the broad set of option-marker styles emitted by ChatGPT.
 */
test("parses common ChatGPT option marker formats", () => {
  // Load the real parser once and exercise each independently-scoped format.
  const { api } = loadContentHarness();
  const formatCases = [
    { name: "period", options: ["A. Alpha", "B. Beta"] },
    { name: "closing parenthesis", options: ["A) Alpha", "B) Beta"] },
    { name: "colon", options: ["A: Alpha", "B: Beta"] },
    { name: "hyphen", options: ["A - Alpha", "B - Beta"] },
    { name: "en dash", options: ["A – Alpha", "B – Beta"] },
    { name: "em dash", options: ["A — Alpha", "B — Beta"] },
    { name: "parenthesized", options: ["(A) Alpha", "(B) Beta"] },
    { name: "bracketed", options: ["[A] Alpha", "[B] Beta"] },
    { name: "dash bullet", options: ["- A. Alpha", "- B. Beta"] },
    { name: "asterisk bullet", options: ["* A) Alpha", "* B) Beta"] },
    { name: "unicode bullet", options: ["• A: Alpha", "• B: Beta"] },
    { name: "numbered bullet", options: ["1. A. Alpha", "2. B. Beta"] },
    { name: "option label", options: ["Option A: Alpha", "Option B: Beta"] },
    { name: "choice label", options: ["Choice A — Alpha", "Choice B — Beta"] },
    { name: "table cells", options: ["A\tAlpha", "B\tBeta"] }
  ];

  // Every marker style should produce the same normalized question shape.
  for (const formatCase of formatCases) {
    const questions = api.parseMultipleChoiceQuestions([
      `Which option demonstrates the ${formatCase.name} format?`,
      ...formatCase.options,
      "Answer: B"
    ].join("\n"));
    assert.equal(questions.length, 1, formatCase.name);
    assert.deepEqual(toPlain(questions[0].options), [
      { letter: "A", text: "Alpha" },
      { letter: "B", text: "Beta" }
    ], formatCase.name);
    assert.deepEqual(toPlain(questions[0].correctLetters), ["B"], formatCase.name);
  }
});

/**
 * Verifies answer labels, separators, wrappers, and wording used by ChatGPT.
 */
test("parses common ChatGPT answer-line formats at each question end", () => {
  // Exercise answer syntax separately so one malformed case cannot borrow another key.
  const { api } = loadContentHarness();
  const answerCases = [
    "Answer: B",
    "Answer - B",
    "Answer – B",
    "Answer — B",
    "Answer is B",
    "Answer(s): B",
    "Correct answer: B",
    "Correct Answer is B",
    "The correct answer is B",
    "Correct option: B",
    "Correct choice: B",
    "Best answer: B",
    "The best answer is B",
    "Solution: B",
    "Key: B",
    "✅ Answer: B",
    "✔ Correct answer: (B)",
    "☑ Answer: [B]",
    "Answer: Option B",
    "Answer: Choice B",
    "Answer: B. Beta",
    "Answer: B - Beta is a single answer.",
    "Answer: B – Beta is a single answer.",
    "Answer: B — Beta is a single answer.",
    "Answer: B - because Beta is correct.",
    "Answer: B — since Beta is correct.",
    "Correct answer: B; Rationale: Beta is correct."
  ];

  // Each accepted answer line must assign B to the question immediately before it.
  for (const answerLine of answerCases) {
    const questions = api.parseMultipleChoiceQuestions([
      "Which answer syntax is under test?",
      "A. Alpha",
      "B. Beta",
      answerLine
    ].join("\n"));
    assert.equal(questions.length, 1, answerLine);
    assert.deepEqual(toPlain(questions[0].correctLetters), ["B"], answerLine);
    assert.equal(questions[0].isSata, false, answerLine);
  }
});

/**
 * Verifies multi-answer separators and exact SATA normalization.
 */
test("parses common ChatGPT SATA answer formats", () => {
  // Use an explicit multi-select cue so plural answer labels stay question-local.
  const { api } = loadContentHarness();
  const sataCases = [
    "Answers: A, C, D",
    "Answer(s): A, C, and D",
    "Correct answers are A and C and D",
    "Correct options: A; C; D",
    "Correct choices — A / C / D",
    "The correct answers are (A), (C), and (D)",
    "Answer: A & C & D"
  ];

  // Separator and wrapper differences must not alter the selected answer set.
  for (const answerLine of sataCases) {
    const questions = api.parseMultipleChoiceQuestions([
      "Select all that apply.",
      "A. Alpha",
      "B. Beta",
      "C. Gamma",
      "D. Delta",
      answerLine
    ].join("\n"));
    assert.equal(questions.length, 1, answerLine);
    assert.equal(questions[0].isSata, true, answerLine);
    assert.deepEqual(toPlain(questions[0].correctLetters), ["A", "C", "D"], answerLine);
  }
});

/**
 * Verifies question labels and compact layouts without final-response answer keys.
 */
test("keeps answers attached to each question across layout variants", () => {
  // Combine realistic layouts to expose state leakage between adjacent questions.
  const { api } = loadContentHarness();
  const questions = api.parseMultipleChoiceQuestions(`
    Multiple-Choice Questions:
    Question 1 — Which value is first?
    A. Alpha
    B. Beta
    Answer: A
    Q2) Which value is second? A) Alpha B) Beta Correct answer is B
    3: Which value is third?
    (A) Alpha
    (B) Beta
    Solution — A
    Question 4:
    Which value is fourth?
    Option X: X-ray
    Option Y: Yankee
    Best answer: Y
  `);

  // Every key must remain scoped to the preceding question rather than a final key.
  assert.equal(questions.length, 4);
  assert.deepEqual(toPlain(questions.map((question) => question.correctLetters)), [["A"], ["B"], ["A"], ["Y"]]);
  assert.deepEqual(toPlain(questions.map((question) => question.options.map((option) => option.letter))), [
    ["A", "B"],
    ["A", "B"],
    ["A", "B"],
    ["X", "Y"]
  ]);
});

/**
 * Verifies answer metadata, rationale boundaries, and parser false-positive guards.
 */
test("handles inline keys, rationales, and non-MCQ lookalikes", () => {
  // Load pure parser helpers for boundary-focused cases.
  const { api } = loadContentHarness();
  const inline = api.parseMultipleChoiceQuestions(`
    Which letters apply? (Answer(s): A / C)
    A. Alpha
    B. Beta
    C. Gamma
  `);
  assert.deepEqual(toPlain(inline[0].correctLetters), ["A", "C"]);
  assert.equal(inline[0].isSata, true);
  assert.equal(inline[0].prompt, "Which letters apply?");

  // Multiline rationale text should belong only to the completed question.
  const rationale = api.parseMultipleChoiceQuestions(`
    Which value is correct?
    A. Alpha
    B. Beta
    Answer: B
    Rationale:
    Beta is correct for this example.
    It remains correct on a second line.
  `);
  assert.equal(rationale[0].rationale, "Beta is correct for this example. It remains correct on a second line.");

  // Lettered prose without two options and ordinary numeric values are not questions.
  assert.equal(api.parseMultipleChoiceQuestions("A. This is a single outline item.\nAnswer: A").length, 0);
  const numericText = api.parseMultipleChoiceQuestions(`
    Which ratio is expected?
    A. 1:1 ratio
    B. 2:1 ratio
    Answer: A
  `);
  assert.equal(numericText.length, 1);
  assert.deepEqual(toPlain(numericText[0].options.map((option) => option.text)), ["1:1 ratio", "2:1 ratio"]);
});

/**
 * Verifies the custom nursing GPT's answer-with-rationales output contract.
 */
test("parses Answer with Rationales sections without creating rationale questions", () => {
  // Reproduce the heading and lettered distractor explanations from the reported GPT.
  const { api } = loadContentHarness();
  const questions = api.parseMultipleChoiceQuestions(`
    Question 1: A 72-year-old client is 2 hours postoperative after abdominal surgery. The client has a blood pressure of 84/48 mm Hg, heart rate 124/min, and cool, clammy skin. The client is increasingly restless and the urine output has fallen to 10 mL/hr. Which action should the nurse take first?
    A. Reassess the urine output in 30 minutes
    B. Activate the rapid response team
    C. Administer the prescribed oral analgesic
    D. Assist the client into a high-Fowler position
    Answer with Rationales
    Correct Answer: B
    Rationale:
    A. Reassessment delays treatment of active deterioration.
    B. Rapid intervention is required for findings consistent with shock.
    C. Oral medication does not address the immediate instability.
    D. Upright positioning may further reduce venous return.

    Question 2: A 6-year-old client with asthma is speaking in one-word phrases. Respirations are 38/min, oxygen saturation is 86%, and breath sounds are becoming diminished. Which intervention is the priority?
    A. Encourage oral fluids
    B. Obtain a routine peak-flow measurement
    C. Apply oxygen and prepare a rapid-acting bronchodilator
    D. Teach pursed-lip breathing
    Answer with Rationales:
    Correct answer is C
    Rationales:
    A. Fluids may be appropriate later but do not correct severe hypoxemia.
    B. Testing must not delay stabilization.
    C. Oxygen and bronchodilation address the immediate breathing threat.
    D. Teaching is inappropriate during severe respiratory distress.
  `);

  // Only the two clinical items should render and each must retain its local key.
  assert.equal(questions.length, 2);
  assert.deepEqual(toPlain(questions.map((question) => question.correctLetters)), [["B"], ["C"]]);
  assert.deepEqual(toPlain(questions.map((question) => question.options.length)), [4, 4]);
  assert.match(questions[0].rationale, /A\. Reassessment delays treatment/);
  assert.match(questions[0].rationale, /D\. Upright positioning/);
  assert.match(questions[1].rationale, /C\. Oxygen and bronchodilation/);
});

/**
 * Verifies combined answer-and-rationale labels with common conjunctions.
 */
test("parses combined answer and rationale labels", () => {
  // Cover compact variants that place the correct letter on the heading line.
  const { api } = loadContentHarness();
  const combinedLabels = [
    "Answer and Rationale: B",
    "Answer with Rationale: B",
    "Answer & Rationale: B",
    "Answer/Rationale: B",
    "Correct Answer and Rationales: B"
  ];

  // Every combined label must provide a scoreable answer without adding another item.
  for (const label of combinedLabels) {
    const questions = api.parseMultipleChoiceQuestions(`
      Which intervention is the priority?
      A. Perform the later action
      B. Stabilize the client
      C. Document before intervening
      D. Delay and reassess
      ${label}
      A. This action can wait.
      B. This action addresses instability.
      C. Documentation follows stabilization.
      D. Delay is unsafe.
    `);
    assert.equal(questions.length, 1, label);
    assert.deepEqual(toPlain(questions[0].correctLetters), ["B"], label);
    assert.match(questions[0].rationale, /B\. This action addresses instability/, label);
  }
});

/**
 * Verifies parser utility behavior for compact lines and ambiguous answer markers.
 */
test("normalizes compact MCQ lines and preserves answer content markers", () => {
  // Load parser utilities from the real content-script factory.
  const { api } = loadContentHarness();

  assert.deepEqual(toPlain(api.normalizeMcqLines("Question 1: Pick one A. Alpha B. Beta Answer: B")), [
    "Question 1: Pick one",
    "A. Alpha",
    "B. Beta",
    "Answer: B"
  ]);
  assert.deepEqual(toPlain(api.splitCompactMcqLine("A. Alpha")), ["A. Alpha"]);
  assert.deepEqual(toPlain(api.splitCompactMcqLine("   ")), [""]);
  assert.equal(
    api.isAnswerContentMarkerInsideCurrentSegment("Answer: B. Beta", [0], 8, "B. "),
    true
  );
  assert.equal(
    api.isAnswerContentMarkerInsideCurrentSegment("Prompt B. Beta", [0], 7, "B. "),
    false
  );
  assert.equal(api.cleanOptionText("Alpha explanation: hidden"), "Alpha");
});

/**
 * Verifies question shell creation and explicit embedded question handling.
 */
test("creates question shells with inline answers and SATA cues", () => {
  // Exercise question construction independently of the full parser loop.
  const { api } = loadContentHarness();
  const embedded = api.parseEmbeddedQuestionStart("Question 7: Choose one");
  assert.deepEqual(toPlain(embedded), { index: 6, text: "Choose one" });
  assert.equal(api.parseEmbeddedQuestionStart("7-day duration"), null);

  const question = api.createQuestion(["Select all that apply. Correct answers: A and C"], 0);
  assert.equal(question.prompt, "Select all that apply.");
  assert.deepEqual(toPlain(question.correctLetters), ["A", "C"]);
  assert.equal(question.isSata, true);

  const embeddedQuestion = api.createQuestion(["ignored"], 1, { text: "Embedded prompt" });
  assert.equal(embeddedQuestion.prompt, "Embedded prompt");
  assert.equal(api.createPrompt(["one", "two", "three", "four"], 0), "two three four");
});

/**
 * Verifies answer and rationale assignment helpers mutate only valid targets.
 */
test("assigns answer keys and rationales without overwriting explicit data", () => {
  // Create plain mutable question records for low-level assignment tests.
  const { api } = loadContentHarness();
  const first = { correctLetters: [], isSata: false, rationale: "" };
  const second = { correctLetters: ["B"], isSata: false, rationale: "Existing" };
  const questions = [first, second];

  api.assignAnswerLetters(first, ["A", "C"]);
  assert.deepEqual(toPlain(first.correctLetters), ["A", "C"]);
  assert.equal(first.isSata, true);
  api.assignAnswerLetters(null, ["A"]);

  api.assignAnswerKeyToQuestions(questions, [["D"], ["A"]]);
  assert.deepEqual(toPlain(questions.map((question) => question.correctLetters)), [["A", "C"], ["B"]]);
  api.assignRationaleGroupsToQuestions(questions, ["First rationale", "Replacement"]);
  assert.equal(first.rationale, "First rationale");
  assert.equal(second.rationale, "Existing");

  api.assignRationale(first, "Ignored replacement");
  api.appendRationale(first, "More detail.");
  assert.equal(first.rationale, "First rationale More detail.");
  api.appendRationale(null, "Ignored");
});

/**
 * Verifies numbered answers can be stored immediately or deferred by index.
 */
test("assigns numbered answers to parsed and deferred questions", () => {
  // Exercise both existing-question and missing-question assignment branches.
  const { api } = loadContentHarness();
  const questions = [{ correctLetters: [], isSata: false, rationale: "" }];
  const groups = [];
  const assigned = api.assignNumberedAnswerEntry(questions, groups, {
    index: 0,
    letters: ["B"],
    rationale: "Because B."
  });
  assert.equal(assigned, questions[0]);
  assert.deepEqual(toPlain(groups), [["B"]]);
  assert.equal(questions[0].rationale, "Because B.");

  const deferred = api.assignNumberedAnswerEntry(questions, groups, {
    index: 2,
    letters: ["C"],
    rationale: ""
  });
  assert.equal(deferred, null);
  assert.deepEqual(toPlain(groups[2]), ["C"]);
});

/**
 * Verifies parser predicates and malformed input rejection branches.
 */
test("rejects malformed parser labels and recognizes supported headings", () => {
  // Cover negative and positive branches for small parser predicates.
  const { api } = loadContentHarness();
  assert.equal(api.parseQuestionStart("1:1 ratio"), null);
  assert.equal(api.parseStandaloneQuestionLabel("Question one"), null);
  assert.equal(api.parseNumberedAnswerEntry("Question 2 Answer: none"), null);
  assert.equal(api.parseNumberedAnswerKeyEntry("2. none"), null);
  assert.equal(api.parseRationaleEntry("ordinary prose"), null);
  assert.equal(api.parseNumberedRationale("ordinary prose"), null);
  assert.equal(api.parseAnswerEntry("Answer: no listed option"), null);
  assert.equal(api.isAnswerWithRationalesHeading("Answer with Rationales:"), true);
  assert.equal(api.isAnswerWithRationalesHeading("Answer with Rationale: B"), false);
  assert.equal(api.hasGroupedAnswerNumbers("1. A 2. B"), true);
  assert.equal(api.hasGroupedAnswerNumbers("A and B"), false);
  assert.equal(api.isAnswerLine("Ordinary explanation"), false);
});

/**
 * Verifies candidate questions require multiple options before insertion.
 */
test("appends only valid parser questions", () => {
  // Build candidates directly to isolate the parser validation threshold.
  const { api } = loadContentHarness();
  const questions = [];
  api.appendQuestionIfValid(questions, null);
  api.appendQuestionIfValid(questions, { prompt: "Too short", options: [{ letter: "A", text: "One" }] });
  api.appendQuestionIfValid(questions, {
    prompt: "Valid",
    options: [{ letter: "A", text: "One" }, { letter: "B", text: "Two" }]
  });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].prompt, "Valid");
});

/**
 * Verifies scoring normalization, exact matching, and answer summaries.
 */
test("scores correct, incorrect, unanswered, and unknown questions", () => {
  // Build a quiz with one question in every scoring state.
  const { document, api } = loadContentHarness();
  const quiz = document.createElement("section");
  const cases = [
    { correct: "A", selected: ["A"], rationale: "Correct rationale" },
    { correct: "B", selected: ["A"] },
    { correct: "C", selected: [] },
    { correct: "", selected: ["A"] }
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const question = document.createElement("div");
    question.className = `${EXTENSION_PREFIX}-question`;
    question.dataset.questionIndex = String(index);
    question.dataset.correctLetters = cases[index].correct;
    question.dataset.rationale = cases[index].rationale || "";
    for (const letter of ["A", "B", "C"]) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = letter;
      input.dataset.optionText = `Option ${letter}`;
      input.checked = cases[index].selected.includes(letter);
      question.appendChild(input);
    }
    quiz.appendChild(question);
  }

  const score = api.calculateQuizScore(quiz);
  assert.deepEqual(toPlain({
    correct: score.correct,
    total: score.total,
    missing: score.missing,
    unknown: score.unknown
  }), { correct: 1, total: 3, missing: 1, unknown: 1 });
  assert.deepEqual(toPlain(score.details.map((detail) => detail.status)), [
    "correct",
    "incorrect",
    "unanswered",
    "unknown"
  ]);
  assert.deepEqual(toPlain(score.details[0].selectedAnswers), [{ letter: "A", text: "Option A" }]);
  assert.deepEqual(toPlain(api.normalizeSavedSelection(["A", "C"])), ["A", "C"]);
  assert.deepEqual(toPlain(api.normalizeSavedSelection("B")), ["B"]);
  assert.deepEqual(toPlain(api.normalizeSavedSelection(undefined)), []);
  assert.deepEqual(toPlain(api.normalizeLetterList(" a, C, ")), ["A", "C"]);
  assert.equal(api.areLetterSetsEqual(["C", "A"], ["A", "C"]), true);
  assert.equal(api.areLetterSetsEqual(["A"], ["A", "C"]), false);
  assert.equal(api.areLetterSetsEqual(["A"], ["B"]), false);
  assert.equal(api.formatLetters(["A", "C"]), "A, C");
});

/**
 * Verifies single-question score calculation for each terminal state.
 */
test("calculates individual question score states", () => {
  // Reuse rendered question controls to validate question-local scoring.
  const { document, api } = loadContentHarness();
  const question = api.buildQuestionElement("single", {
    prompt: "Pick one",
    options: [{ letter: "A", text: "Alpha" }, { letter: "B", text: "Beta" }],
    correctLetters: ["B"],
    rationale: "B is correct.",
    isSata: false
  }, 2, {});
  document.body.appendChild(question);

  assert.equal(api.calculateQuestionScore(question).details[0].status, "unanswered");
  question.querySelector("input[value='A']").checked = true;
  assert.equal(api.calculateQuestionScore(question).details[0].status, "incorrect");
  question.querySelector("input[value='B']").checked = true;
  assert.equal(api.calculateQuestionScore(question).details[0].status, "correct");
  question.dataset.correctLetters = "";
  assert.equal(api.calculateQuestionScore(question).details[0].status, "unknown");
});

/**
 * Verifies core UI builders produce stable ids and accessible controls.
 */
test("builds quiz ids, headers, notices, options, and paywall controls", () => {
  // Create two assistant roots so fallback indexing can be asserted.
  const { document, api } = loadContentHarness();
  const firstRoot = document.createElement("div");
  const secondRoot = document.createElement("div");
  firstRoot.setAttribute("data-message-author-role", "assistant");
  secondRoot.setAttribute("data-message-author-role", "assistant");
  secondRoot.setAttribute("data-testid", "turn-2");
  document.body.append(firstRoot, secondRoot);

  assert.equal(api.getElementIndex(firstRoot), 0);
  assert.equal(api.getElementIndex(document.createElement("div")), 0);
  assert.equal(api.hashString("stable"), api.hashString("stable"));
  assert.match(api.createQuizId(secondRoot, [{ prompt: "Prompt" }]), /^quiz-[a-z0-9]+$/);

  const header = api.buildQuizHeader("quiz-id");
  assert.match(header.textContent, /Select your answer/);
  assert.equal(header.querySelector("input").dataset.quizId, "quiz-id");
  assert.match(api.buildTrialNotice({ trialRemainingMs: 60000 }).textContent, /1 minute left/);

  const option = api.buildOptionElement(
    "quiz-id",
    1,
    "group",
    { letter: "C", text: "Gamma" },
    ["C"],
    true
  );
  assert.equal(option.querySelector("input").type, "checkbox");
  assert.equal(option.querySelector("input").checked, true);
  assert.equal(option.querySelector("input").dataset.optionText, "Gamma");

  const primary = api.buildPaywallButton("Pay", "openPaymentPage", true);
  assert.equal(primary.type, "button");
  assert.equal(primary.dataset.paywallAction, "openPaymentPage");
  assert.equal(primary.classList.contains(`${EXTENSION_PREFIX}-paywall-button-primary`), true);
  assert.match(api.getPaywallMessage({ status: "locked" }), /Pay \$5 once/);
});

/**
 * Verifies score presentation helpers and empty score output.
 */
test("renders score feedback helper variants", () => {
  // Exercise presentational helpers with complete, empty, and unknown data.
  const { document, api } = loadContentHarness();
  assert.equal(api.formatAnswerSummaries([{ letter: "A", text: "Alpha" }, { letter: "B" }]), "A. Alpha; B");
  assert.equal(api.getScoreStatusLabel("correct"), "Correct");
  assert.equal(api.getScoreStatusLabel("incorrect"), "Incorrect");
  assert.equal(api.getScoreStatusLabel("unanswered"), "Unanswered");
  assert.equal(api.getScoreStatusLabel("unknown"), "Not scored");

  const feedback = api.buildAnswerFeedbackLine("Your answer", null, "None selected");
  assert.equal(feedback.textContent, "Your answer:None selected");

  const detail = api.buildScoreDetailElement({
    questionNumber: 1,
    status: "unknown",
    selectedAnswers: [],
    correctAnswers: [],
    rationale: "Context only."
  });
  assert.match(detail.textContent, /Question 1: Not scored/);
  assert.doesNotMatch(detail.textContent, /Correct answer/);
  assert.match(detail.textContent, /Context only/);

  const result = document.createElement("div");
  result.textContent = "stale";
  api.renderScoreResult(result, { correct: 0, total: 0, missing: 0, unknown: 1, details: [] });
  assert.match(result.textContent, /No answer key was found/);
});

/**
 * Verifies UI event handlers ignore invalid targets and score valid controls.
 */
test("handles score-mode and score-button UI events", () => {
  // Build a real quiz so closest selectors and result rendering are exercised.
  const { document, api } = loadContentHarness();
  const quiz = api.buildQuizElement("events", [{
    prompt: "Pick B",
    options: [{ letter: "A", text: "Alpha" }, { letter: "B", text: "Beta" }],
    correctLetters: ["B"],
    rationale: "",
    isSata: false
  }], {}, { status: "paid" });
  document.body.appendChild(quiz);

  api.handleScoreEachQuestionToggle({ target: document.createElement("div") });
  const toggle = quiz.querySelector(`.${EXTENSION_PREFIX}-score-mode-toggle input`);
  toggle.checked = true;
  api.handleScoreEachQuestionToggle({ target: toggle });
  assert.equal(quiz.classList.contains(`${EXTENSION_PREFIX}-score-each-question-enabled`), true);

  api.handleScoreClick({ target: document.createElement("div") });
  const wholeQuizButton = quiz.querySelector(`.${EXTENSION_PREFIX}-actions button`);
  api.handleScoreClick({ target: wholeQuizButton });
  assert.match(wholeQuizButton.parentElement.textContent, /Score: 0\/1/);

  const questionButton = quiz.querySelector(`.${EXTENSION_PREFIX}-question-score-button`);
  api.handleQuestionScoreClick({ target: questionButton });
  assert.match(quiz.querySelector(`.${EXTENSION_PREFIX}-question-score-result`).textContent, /Score: 0\/1/);
});

/**
 * Verifies answer visibility restoration and nested original-output handling.
 */
test("restores answer lines and skips extension-owned original output", () => {
  // Build source and extension nodes to isolate hide/restore filtering.
  const { document, api } = loadContentHarness();
  const root = document.createElement("div");
  root.innerHTML = "<p>Answer: B</p><div><span>Original</span></div>";
  const context = document.createElement("div");
  context.className = `${EXTENSION_PREFIX}-context`;
  root.appendChild(context);
  document.body.appendChild(root);

  api.hideAnswerLines(root);
  assert.equal(root.querySelector("p").classList.contains(`${EXTENSION_PREFIX}-hidden-answer`), true);
  api.restoreAnswerLines(root);
  assert.equal(root.querySelector("p").classList.contains(`${EXTENSION_PREFIX}-hidden-answer`), false);
  api.hideOriginalOutput(root, null);
  assert.equal(context.hasAttribute(`data-${EXTENSION_PREFIX}-original-output`), false);
});

/**
 * Verifies persistence reads, writes, context reuse, and radio changes.
 */
test("persists radio selections and reuses the conversation context node", async () => {
  // Seed storage and verify direct persistence helpers before a radio event.
  const { document, api, storage } = loadContentHarness({
    url: "https://chatgpt.com/c/persistence"
  });
  const key = api.getStorageKey();
  storage[key] = { existing: { 0: "A" } };
  assert.deepEqual(toPlain(await api.readSelections()), { existing: { 0: "A" } });

  await api.writeSelections({ replacement: { 0: "B" } });
  assert.deepEqual(toPlain(storage[key]), { replacement: { 0: "B" } });
  api.updateConversationContext(storage[key]);
  const context = document.getElementById("mcq-radio-extension-conversation-context");
  api.updateConversationContext({ updated: { 1: "C" } });
  assert.equal(document.querySelectorAll("#mcq-radio-extension-conversation-context").length, 1);
  assert.equal(JSON.parse(context.textContent).updated[1], "C");

  const element = api.buildQuestionElement("radio-store", {
    prompt: "Pick one",
    options: [{ letter: "A", text: "Alpha" }, { letter: "B", text: "Beta" }],
    correctLetters: ["B"],
    rationale: "",
    isSata: false
  }, 0, {});
  document.body.appendChild(element);
  const radio = element.querySelector("input[value='B']");
  await api.handleOptionChange({ target: document.createElement("div") });
  await api.handleOptionChange({ target: radio });
  assert.equal(storage[key]["radio-store"][0], "B");
});

/**
 * Verifies access messaging, cache invalidation, and safe error normalization.
 */
test("handles access cache bypasses and runtime callback failures", async () => {
  // Queue responses so cache and bypass behavior can be observed directly.
  const { api, window, sentMessages } = loadContentHarness({
    runtimeResponses: [
      { ok: true, status: "trial" },
      { ok: true, status: "paid" },
      { ok: true, status: "locked" }
    ]
  });
  assert.equal((await api.readAccessState(false)).status, "trial");
  assert.equal((await api.readAccessState(true)).status, "paid");
  api.clearAccessStateCache();
  assert.equal((await api.readAccessState(false)).status, "locked");
  assert.equal(sentMessages.length, 3);
  assert.equal(api.isAccessLocked({ status: "paid" }), false);
  assert.equal(api.isAccessLocked({ status: "trial" }), false);
  assert.equal(api.isAccessLocked(null), true);
  assert.equal(api.formatTrialRemaining(60 * 60000), "1 hour");
  assert.equal(api.formatTrialRemaining(2 * 60000), "2 minutes");
  assert.equal(api.getErrorMessage("plain failure"), "plain failure");
  assert.equal(api.getErrorMessage(null), "Payment status is unavailable.");

  const status = window.document.createElement("div");
  api.setPaywallStatus(null, "ignored");
  api.setPaywallStatus(status, "<b>safe</b>");
  assert.equal(status.innerHTML, "&lt;b&gt;safe&lt;/b&gt;");

  window.chrome.runtime.lastError = { message: "message failed" };
  await assert.rejects(api.sendPaywallMessage("getAccessState"), /message failed/);
});

/**
 * Verifies access-state read failures normalize to a cached locked-safe result.
 */
test("normalizes and caches access-state messaging failures", async () => {
  // Force runtime messaging to fail and confirm repeated reads use the failure cache.
  const { api, window, sentMessages } = loadContentHarness();
  window.chrome.runtime.lastError = { message: "provider unavailable" };
  const first = await api.readAccessState(false);
  const second = await api.readAccessState(false);
  assert.equal(first.status, "unknown");
  assert.equal(first.error, "provider unavailable");
  assert.equal(second.error, "provider unavailable");
  assert.equal(sentMessages.length, 1);
});

/**
 * Verifies paywall actions dispatch provider requests and refresh requests.
 */
test("handles paywall button actions and failures", async () => {
  // Build a paywall and invoke its event handler with success and failure responses.
  const successHarness = loadContentHarness({
    runtimeResponses: [{ ok: true }]
  });
  const paywall = successHarness.api.buildPaywallElement({ status: "locked" });
  successHarness.document.body.appendChild(paywall);
  const payButton = paywall.querySelector("[data-paywall-action='openPaymentPage']");
  await successHarness.api.handlePaywallAction({ currentTarget: payButton });
  assert.equal(payButton.disabled, false);
  assert.match(paywall.querySelector(`.${EXTENSION_PREFIX}-paywall-status`).textContent, /A new tab opened/);

  const failureHarness = loadContentHarness({
    runtimeResponses: [{ ok: false, error: "checkout failed" }]
  });
  const failedPaywall = failureHarness.api.buildPaywallElement({ status: "locked" });
  failureHarness.document.body.appendChild(failedPaywall);
  const failedButton = failedPaywall.querySelector("[data-paywall-action='openPaymentPage']");
  await failureHarness.api.handlePaywallAction({ currentTarget: failedButton });
  assert.equal(failedPaywall.querySelector(`.${EXTENSION_PREFIX}-paywall-status`).textContent, "checkout failed");
  await failureHarness.api.handlePaywallAction({ currentTarget: failureHarness.document.createElement("div") });
});

/**
 * Verifies orchestration helpers for storage changes and extension lifecycle.
 */
test("starts, stops, and applies enabled storage changes", () => {
  // Build assistant source so stop can restore and clean generated state.
  const { document, api } = loadContentHarness();
  const root = document.createElement("div");
  root.setAttribute("data-message-author-role", "assistant");
  root.innerHTML = "<p>Question?</p><p>A. One</p><p>B. Two</p>";
  document.body.appendChild(root);

  api.start();
  api.start();
  api.handleStorageChange({}, "local");
  api.handleStorageChange({ "mcq-radio-extension:enabled": { newValue: false } }, "sync");
  api.handleStorageChange({ "mcq-radio-extension:enabled": { newValue: false } }, "local");
  assert.equal(root.querySelectorAll(`.${EXTENSION_PREFIX}-quiz`).length, 0);
  api.handleStorageChange({ "mcq-radio-extension:enabled": { newValue: true } }, "local");
  api.stop();
});

/**
 * Verifies mutation ownership decisions for empty and mixed node changes.
 */
test("classifies extension, empty, and mixed mutations", () => {
  // Create representative mutation payloads without requiring a live observer.
  const { document, api, window } = loadContentHarness();
  const root = document.createElement("div");
  root.setAttribute("data-message-author-role", "assistant");
  const text = document.createTextNode("Text");
  root.appendChild(text);
  document.body.appendChild(root);

  assert.equal(api.findAssistantRoot(text), root);
  assert.equal(api.findAssistantRoot(document.createElement("div")), null);
  assert.equal(api.isExtensionMutation({ target: root, addedNodes: [], removedNodes: [] }), false);

  const extensionNode = document.createElement("section");
  extensionNode.className = `${EXTENSION_PREFIX}-quiz`;
  const ordinaryNode = document.createElement("p");
  assert.equal(api.isExtensionMutation({
    target: root,
    addedNodes: [extensionNode, ordinaryNode],
    removedNodes: []
  }), false);

  api.handleMutations([{
    target: ordinaryNode,
    addedNodes: [],
    removedNodes: [],
    type: "characterData"
  }]);
  assert.equal(window.document, document);
});
