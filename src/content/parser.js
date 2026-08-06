globalThis.McqQuiz = globalThis.McqQuiz || {};
globalThis.McqQuiz.services = globalThis.McqQuiz.services || {};

/**
 * Creates the MCQ parser service used by the content entrypoint.
 *
 * @param {Record<string, unknown>} config - Shared parser patterns.
 * @returns {Record<string, Function>} Parser helper service.
 */
globalThis.McqQuiz.createParser = function createParser(config) {
  // Keep parser-only patterns private to this service.
  const {
    OPTION_PATTERN,
    SATA_PATTERN,
    INLINE_STOP_PATTERN,
    ANSWER_RATIONALE_LABEL_PATTERN,
    ANSWER_PATTERNS
  } = config;
  /**
   * Parses one or more multiple-choice questions from plain rendered text.
   *
   * @param {string} text - ChatGPT assistant output text.
   * @returns {Array<{prompt: string, options: Array<{letter: string, text: string}>, correctLetters: string[], rationale: string, isSata: boolean}>} Parsed questions.
   */
  function parseMultipleChoiceQuestions(text) {
    // Normalize line endings and recover markers collapsed onto one rendered line.
    const lines = normalizeMcqLines(text);
    const questions = [];
    let pendingPromptLines = [];
    let currentQuestion = null;
    let lastQuestion = null;
    let answerKeyGroups = [];
    let rationaleGroups = [];
    let activeRationaleQuestion = null;
    let isCollectingAnswerKey = false;
    let isCollectingNumberedRationales = false;
    let isCollectingOptionRationales = false;

    // Walk line by line to preserve question prompts that appear before option A.
    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Ignore blank lines during parsing.
      if (!line) {
        continue;
      }

      // Ignore organizational headings so they do not become part of prompts.
      if (isQuestionSectionHeading(line)) {
        continue;
      }

      const standaloneQuestionLabel = parseStandaloneQuestionLabel(line);

      // Start a fresh prompt when ChatGPT emits "Question 1:" on its own line.
      if (standaloneQuestionLabel) {
        if (currentQuestion && currentQuestion.options.length > 0) {
          appendQuestionIfValid(questions, currentQuestion);
          lastQuestion = currentQuestion;
          currentQuestion = null;
        }
        pendingPromptLines = [];
        activeRationaleQuestion = null;
        isCollectingAnswerKey = false;
        isCollectingNumberedRationales = false;
        isCollectingOptionRationales = false;
        continue;
      }

      const numberedAnswerEntry = parseNumberedAnswerEntry(line);

      // Capture answer-key sections that repeat "Question N Answer: X".
      if (numberedAnswerEntry) {
        appendQuestionIfValid(questions, currentQuestion);
        lastQuestion = currentQuestion;
        currentQuestion = null;
        pendingPromptLines = [];
        activeRationaleQuestion = assignNumberedAnswerEntry(questions, answerKeyGroups, numberedAnswerEntry);
        isCollectingAnswerKey = false;
        isCollectingNumberedRationales = false;
        isCollectingOptionRationales = false;
        continue;
      }

      // End the question at custom-GPT headings such as "Answer with Rationales".
      if (isAnswerWithRationalesHeading(line)) {
        appendQuestionIfValid(questions, currentQuestion);
        lastQuestion = currentQuestion;
        currentQuestion = null;
        pendingPromptLines = [];
        activeRationaleQuestion = lastQuestion;
        isCollectingAnswerKey = true;
        isCollectingNumberedRationales = false;
        isCollectingOptionRationales = true;
        continue;
      }

      // Enter answer-key mode for headings followed by numbered entries.
      if (isAnswerKeyHeading(line)) {
        appendQuestionIfValid(questions, currentQuestion);
        lastQuestion = currentQuestion;
        currentQuestion = null;
        pendingPromptLines = [];
        activeRationaleQuestion = null;
        isCollectingAnswerKey = true;
        isCollectingNumberedRationales = false;
        isCollectingOptionRationales = false;
        continue;
      }

      const answerEntry = parseAnswerEntry(line);

      // Save hidden answer keys for local scoring without rendering them.
      if (answerEntry) {
        const targetQuestion = currentQuestion || lastQuestion;
        const includesRationaleLabel = ANSWER_RATIONALE_LABEL_PATTERN.test(line);
        activeRationaleQuestion = isCollectingOptionRationales || includesRationaleLabel ? targetQuestion : null;
        isCollectingAnswerKey = /^\s*(?:answers|answer key)\s*[:\-–—]/i.test(line);
        isCollectingNumberedRationales = false;
        isCollectingOptionRationales = isCollectingOptionRationales || includesRationaleLabel;

        // Treat plural unnumbered answer keys as a sequence unless the current question is SATA.
        if (answerEntry.isPotentialSequence && !targetQuestion?.isSata && questions.length > 0) {
          answerKeyGroups = answerEntry.groups[0].map((letter) => [letter]);
        } else if (answerEntry.groups.length > 1) {
          answerKeyGroups = answerEntry.groups;
        } else {
          assignAnswerLetters(targetQuestion, answerEntry.groups[0]);
        }
        if (answerEntry.rationale) {
          assignRationale(targetQuestion, answerEntry.rationale);
        }
        continue;
      }

      // Capture final keys formatted as "Answers:" followed by "1. B" lines.
      if (isCollectingAnswerKey) {
        const numberedAnswerKeyEntry = parseNumberedAnswerKeyEntry(line);
        if (numberedAnswerKeyEntry) {
          activeRationaleQuestion = assignNumberedAnswerEntry(questions, answerKeyGroups, numberedAnswerKeyEntry);
          isCollectingNumberedRationales = false;
          continue;
        }
      }

      const rationaleEntry = parseRationaleEntry(line);

      // Stop option parsing when rationale or follow-up sections begin.
      if (rationaleEntry) {
        if (currentQuestion) {
          appendQuestionIfValid(questions, currentQuestion);
          lastQuestion = currentQuestion;
        }
        currentQuestion = null;
        pendingPromptLines = [];
        activeRationaleQuestion = lastQuestion;
        isCollectingAnswerKey = false;
        isCollectingNumberedRationales = rationaleEntry.isPlural;
        isCollectingOptionRationales = true;
        if (rationaleEntry.text) {
          assignRationale(lastQuestion, rationaleEntry.text);
        }
        continue;
      }

      // Stop option parsing at non-rationale follow-up sections.
      if (isExplanationBoundary(line)) {
        appendQuestionIfValid(questions, currentQuestion);
        lastQuestion = currentQuestion;
        currentQuestion = null;
        pendingPromptLines = [];
        activeRationaleQuestion = null;
        isCollectingAnswerKey = false;
        isCollectingNumberedRationales = false;
        isCollectingOptionRationales = false;
        continue;
      }

      // Capture numbered rationale sections like "Rationales: 1. ... 2. ...".
      if (isCollectingNumberedRationales) {
        const numberedRationale = parseNumberedRationale(line);
        if (numberedRationale) {
          rationaleGroups[numberedRationale.index] = numberedRationale.text;
          activeRationaleQuestion = null;
          continue;
        }
      }

      const option = parseOptionLine(line);
      const questionStart = parseQuestionStart(line);

      // Lettered lines under a rationale section explain options; they are not another MCQ.
      if (activeRationaleQuestion && isCollectingOptionRationales && option) {
        appendRationale(activeRationaleQuestion, `${option.letter}. ${option.text}`);
        continue;
      }

      // Append plain continuation lines after a "Rationale:" label.
      if (activeRationaleQuestion && !option && !questionStart) {
        appendRationale(activeRationaleQuestion, line);
        continue;
      }

      // A new question or option ends the current freeform rationale capture.
      activeRationaleQuestion = null;
      isCollectingAnswerKey = false;
      isCollectingNumberedRationales = false;
      isCollectingOptionRationales = false;

      // Option lines start or continue a question group.
      if (option) {
        const questionMatch = parseEmbeddedQuestionStart(option.text);
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

      // Numbered question text starts a new prompt after a finished option group.
      if (currentQuestion && currentQuestion.options.length > 0) {
        appendQuestionIfValid(questions, currentQuestion);
        lastQuestion = currentQuestion;
        currentQuestion = null;
        pendingPromptLines = questionStart ? [questionStart.text] : [line];
        continue;
      }

      // Otherwise, the line is part of the upcoming question prompt.
      pendingPromptLines.push(questionStart ? questionStart.text : line);
    }

    // Flush the final parsed question, if it has enough options.
    appendQuestionIfValid(questions, currentQuestion);
    assignAnswerKeyToQuestions(questions, answerKeyGroups);
    assignRationaleGroupsToQuestions(questions, rationaleGroups);

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
    // Match lettered options with punctuation, brackets, bullets, or explicit labels.
    const match = line.match(OPTION_PATTERN);

    // Return null for non-option lines so callers can handle prompts normally.
    if (!match) {
      return null;
    }

    // Normalize the option letter and keep the human-readable answer text.
    return {
      letter: (match[1] || match[2] || match[3]).toUpperCase(),
      text: cleanOptionText(match[4])
    };
  }

  /**
   * Normalizes rendered assistant text into parser-friendly logical lines.
   *
   * @param {string} text - Raw visible text from the assistant response.
   * @returns {string[]} Trimmed lines with compact MCQ markers split apart.
   */
  function normalizeMcqLines(text) {
    // Normalize platform line endings before recovering collapsed rendered markers.
    const rawLines = text.replace(/\r\n?/g, "\n").split("\n");

    // Expand each source line independently so existing line breaks remain meaningful.
    return rawLines.flatMap((line) => splitCompactMcqLine(line));
  }

  /**
   * Splits one rendered line when question, option, answer, or rationale markers collapsed together.
   *
   * @param {string} line - One raw line from the assistant response.
   * @returns {string[]} Logical parser lines recovered from the rendered line.
   */
  function splitCompactMcqLine(line) {
    // Work with trimmed text because the parser ignores surrounding whitespace anyway.
    const trimmedLine = line.trim();
    const boundaries = [];
    const markerPattern = /(?:question|q)\s*\d+\s*[\.\):\-–—]\s+|\d+[\.\)]\s+|(?:option|choice)\s+[A-Z]\s*[:\-–—]\s*|(?:\([A-Z]\)|\[[A-Z]\]|[A-Z][\.\):\-–—])\s+|(?:correct\s+)?answer(?:\(s\)|s)?\s*(?:and|with|&|\/)\s*rationales?\s*[:\-–—]\s*|(?:answer(?:\(s\)|s)?|correct answer(?:s)?|correct option(?:s)?|correct choice(?:s)?|best answer|solution|key|answer key|rationales?|explanations?)\s*(?::|\-|–|—|\bis\b|\bare\b)\s*/gi;

    // Blank input stays as an ignored blank line for the caller's existing behavior.
    if (!trimmedLine) {
      return [trimmedLine];
    }

    // Preserve complete option lines before compact-marker recovery splits list prefixes.
    if (parseOptionLine(trimmedLine)) {
      return [trimmedLine];
    }

    // Find markers that begin a logical MCQ segment without splitting answer text like "Answer: B. ...".
    for (const match of trimmedLine.matchAll(markerPattern)) {
      const index = match.index || 0;
      const marker = match[0];

      // Markers in the middle of words are ordinary text, not MCQ boundaries.
      if (index > 0 && !/\s/.test(trimmedLine[index - 1])) {
        continue;
      }

      // Keep answer letters and grouped key numbers attached to answer-key lines.
      if (isAnswerContentMarkerInsideCurrentSegment(trimmedLine, boundaries, index, marker)) {
        continue;
      }

      // Record unique boundary positions so slicing can preserve the marker text.
      if (!boundaries.includes(index)) {
        boundaries.push(index);
      }
    }

    // Preserve prompt text that appears before compact option markers.
    if (boundaries.length > 1 && boundaries[0] > 0) {
      boundaries.unshift(0);
    }

    // A line with zero or one boundary is already safe for the existing parser.
    if (boundaries.length <= 1) {
      return [trimmedLine];
    }

    // Slice each compact segment and drop empty fragments created by leading spaces.
    return boundaries
      .map((start, index) => trimmedLine.slice(start, boundaries[index + 1]).trim())
      .filter(Boolean);
  }

  /**
   * Detects option letters or grouped numbers that belong to an answer label in the same compact line.
   *
   * @param {string} line - Full compact rendered line.
   * @param {number[]} boundaries - Boundary indexes already accepted for the line.
   * @param {number} markerIndex - Candidate answer-content marker index.
   * @param {string} marker - Candidate MCQ marker text.
   * @returns {boolean} True when the marker belongs to answer content, not a new segment.
   */
  function isAnswerContentMarkerInsideCurrentSegment(line, boundaries, markerIndex, marker) {
    // Inspect only the text since the most recent accepted boundary.
    const segmentStart = boundaries.length > 0 ? boundaries[boundaries.length - 1] : 0;
    const segmentText = line.slice(segmentStart, markerIndex).trim();

    // Only option letters and grouped numeric keys are ambiguous inside answer text.
    if (!/^(?:(?:\([A-Z]\)|\[[A-Z]\]|[A-Z][\.\):\-–—])|\d+[\.\)])\s+/i.test(marker)) {
      return false;
    }

    // Match labels such as "Answer:" or "Answer key:" before answer content.
    return /^(?:answer(?:\(s\)|s)?|correct answer(?:s)?|correct option(?:s)?|correct choice(?:s)?|best answer|solution|key|answer key)\s*(?::|\-|–|—|\bis\b|\bare\b)/i.test(segmentText);
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
   * Parses a question starter line without misreading answer text like "1:1 ratio".
   *
   * @param {string} line - Trimmed line or option text to inspect.
   * @returns {{index: number, text: string} | null} Parsed question number and stem.
   */
  function parseQuestionStart(line) {
    // Prefer explicit labels because they can safely omit spacing after a colon.
    const labelledMatch = line.match(/^(?:question|q)\s*(\d+)\s*[\.\):\-–—]?\s*(.+)$/i);
    if (labelledMatch) {
      return {
        index: Math.max(0, Number(labelledMatch[1]) - 1),
        text: labelledMatch[2].trim()
      };
    }

    // Match numbered question lines while requiring safe punctuation/spacing.
    const numberedMatch = line.match(/^(\d+)(?:(?:[\.\)]\s*)|(?:\s*[:\-–—]\s+))(.+)$/i);
    if (!numberedMatch) {
      return null;
    }

    // Return normalized data so callers do not depend on regex capture indexes.
    return {
      index: Math.max(0, Number(numberedMatch[1]) - 1),
      text: numberedMatch[2].trim()
    };
  }

  /**
   * Parses only explicit question labels embedded after an option marker.
   *
   * @param {string} text - Option text to inspect for a nested question label.
   * @returns {{index: number, text: string} | null} Parsed embedded question start.
   */
  function parseEmbeddedQuestionStart(text) {
    // Numeric ranges and durations inside options are answer text, not question starts.
    if (!/^(?:question|q)\s*\d+/i.test(text)) {
      return null;
    }

    // Reuse the regular question parser for explicit "Question N:" option text.
    return parseQuestionStart(text);
  }

  /**
   * Creates a parsed question shell and strips inline answer keys from the prompt.
   *
   * @param {string[]} promptLines - Lines seen before the option group.
   * @param {number} questionIndex - Zero-based parsed question index.
   * @param {{text: string} | null} questionMatch - Optional numbered question match.
   * @returns {{prompt: string, options: Array<{letter: string, text: string}>, correctLetters: string[], rationale: string, isSata: boolean}} Parsed question shell.
   */
  function createQuestion(promptLines, questionIndex, questionMatch = null) {
    // Build the raw prompt first so inline answer keys can be removed in one place.
    const rawPrompt = createPrompt(promptLines, questionIndex, questionMatch);
    const inlineAnswer = extractInlineAnswerKey(rawPrompt);
    const promptCueLines = [...promptLines, questionMatch?.text || ""];

    // Return the question metadata used by rendering and scoring.
    return {
      prompt: inlineAnswer.cleanText || `Question ${questionIndex + 1}`,
      options: [],
      correctLetters: inlineAnswer.letters,
      rationale: "",
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
    const suffixMatch = text.match(/\s*[\(\[]?\s*(?:answer(?:\(s\)|s)?|correct answer(?:s)?|correct option(?:s)?|correct choice(?:s)?|best answer|answer key|solution|key)\s*(?::|\-|–|—|\bis\b|\bare\b)\s*[\(\[]?([A-Z](?:\s*(?:,|;|and|&|\/)\s*[A-Z])*)\s*[\)\]]?\.?\s*$/i)
      || text.match(/\s*[\(\[]?\s*(?:the\s+)?(?:correct|best)?\s*answers?\s+(?:is|are)\s+[\(\[]?([A-Z](?:\s*(?:,|;|and|&|\/)\s*[A-Z])*)\s*[\)\]]?\.?\s*$/i);

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
   * @returns {{groups: string[][], isPotentialSequence: boolean, rationale: string}} Parsed answer groups, or null for non-answer lines.
   */
  function parseAnswerEntry(line) {
    // Parse answer-key prefixes that ChatGPT commonly emits after questions.
    const prefixedMatch = line.match(/^\s*(?:[✅✔☑]\s*)?(?:(?:correct\s+)?answer(?:\(s\)|s)?\s*(?:and|with|&|\/)\s*rationales?|answer(?:\(s\)|s)?|correct answer(?:s)?|correct option(?:s)?|correct choice(?:s)?|best answer|solution|key|answer key)\s*(?::|\-|–|—|\bis\b|\bare\b)\s*(.+)$/i)
      || line.match(/^\s*(?:[✅✔☑]\s*)?(?:the\s+)?(?:correct|best)?\s*answers?\s+(?:is|are)\s+(.+)$/i);

    // Return null when the line is not an answer-key line.
    if (!prefixedMatch) {
      return null;
    }

    // Split the answer body into one or more question-specific answer groups.
    const body = splitAnswerBodyRationale(prefixedMatch[1].trim());
    const groups = parseAnswerGroups(body.answerText);
    const hasPluralSequencePrefix = /^\s*(?:answers|answer key)\s*[:\-–—]/i.test(line);
    const isPotentialSequence = hasPluralSequencePrefix && groups.length === 1 && groups[0].length > 1 && !hasGroupedAnswerNumbers(body.answerText);

    // Ignore malformed answer lines that do not include option letters.
    if (groups.length === 0) {
      return null;
    }

    // Return grouped letters for single MCQ, SATA, or ordered answer keys.
    return { groups, isPotentialSequence, rationale: body.rationale };
  }

  /**
   * Detects an answer-key heading that introduces numbered answer lines.
   *
   * @param {string} line - Trimmed rendered line.
   * @returns {boolean} True when following lines should be parsed as answer keys.
   */
  function isAnswerKeyHeading(line) {
    // Match heading-only labels like "Answers:" or "Answer key".
    return /^(?:answers?|answer key|correct answers?|correct options?|correct choices?|solutions?)\s*[:\-–—]?\s*$/i.test(line);
  }

  /**
   * Detects a custom-GPT heading that introduces an answer and option rationales.
   *
   * @param {string} line - Trimmed rendered line.
   * @returns {boolean} True when the completed question is followed by answer details.
   */
  function isAnswerWithRationalesHeading(line) {
    // Require a heading-only label so combined labels containing an answer parse normally.
    return ANSWER_RATIONALE_LABEL_PATTERN.test(line)
      && /rationales?\s*[:\-–—]?\s*$/i.test(line);
  }

  /**
   * Parses one numbered answer-key item from a final answer section.
   *
   * @param {string} line - Trimmed rendered line.
   * @returns {{index: number, letters: string[], rationale: string} | null} Parsed answer-key item.
   */
  function parseNumberedAnswerKeyEntry(line) {
    // Reuse question-number parsing so "1. B" and "Question 1: B" share behavior.
    const questionStart = parseQuestionStart(line);
    if (!questionStart) {
      return null;
    }

    // Split any short explanation away from the answer letters.
    const body = splitAnswerBodyRationale(questionStart.text);
    const groups = parseAnswerGroups(body.answerText);
    if (groups.length === 0) {
      return null;
    }

    // Return the first group because the number scopes this entry to one question.
    return {
      index: questionStart.index,
      letters: groups[0],
      rationale: body.rationale
    };
  }

  /**
   * Detects headings that only organize batches of generated questions.
   *
   * @param {string} line - Trimmed rendered line.
   * @returns {boolean} True when the line is only a question section heading.
   */
  function isQuestionSectionHeading(line) {
    // Match exact headings like "Questions" and "Questions 1-10".
    return /^(?:multiple[\s-]choice\s+)?questions(?:\s+\d+\s*[-–—]\s*\d+)?\s*:?\s*$/i.test(line);
  }

  /**
   * Parses standalone labels such as "Question 1:" before the actual stem.
   *
   * @param {string} line - Trimmed rendered line.
   * @returns {{index: number} | null} Zero-based question index or null.
   */
  function parseStandaloneQuestionLabel(line) {
    // Match a label-only question marker without treating it as prompt text.
    const match = line.match(/^(?:(?:question|q)\s*)?(\d+)\s*[:\.\)\-–—]?\s*$/i);
    if (!match) {
      return null;
    }

    // Convert the visible number into the same zero-based index used elsewhere.
    return {
      index: Math.max(0, Number(match[1]) - 1)
    };
  }

  /**
   * Parses answer-key lines that identify the target question by number.
   *
   * @param {string} line - Trimmed rendered line.
   * @returns {{index: number, letters: string[], rationale: string} | null} Parsed numbered answer entry.
   */
  function parseNumberedAnswerEntry(line) {
    // Match forms like "Question 1 Answer: B - Side effect".
    const match = line.match(/^(?:question\s*)?(\d+)\s*(?:answer(?:\(s\)|s)?|correct answer(?:s)?|correct option(?:s)?|correct choice(?:s)?|solution|key)\s*[:\-–—]\s*(.+)$/i);
    if (!match) {
      return null;
    }

    // Reuse the regular answer/rationale splitter for the answer body.
    const body = splitAnswerBodyRationale(match[2].trim());
    const groups = parseAnswerGroups(body.answerText);
    if (groups.length === 0) {
      return null;
    }

    // Return the first group because the question number already scopes the entry.
    return {
      index: Math.max(0, Number(match[1]) - 1),
      letters: groups[0],
      rationale: body.rationale
    };
  }

  /**
   * Assigns a numbered answer entry to an existing question or deferred answer key.
   *
   * @param {Array<{correctLetters: string[], isSata: boolean, rationale: string}>} questions - Parsed question list.
   * @param {string[][]} answerKeyGroups - Deferred answer groups by question index.
   * @param {{index: number, letters: string[], rationale: string}} entry - Parsed numbered answer entry.
   * @returns {{rationale: string} | null} Question that should receive following rationale lines.
   */
  function assignNumberedAnswerEntry(questions, answerKeyGroups, entry) {
    // Look up the question when the answer section appears after parsed prompts.
    const question = questions[entry.index] || null;

    // Keep the answer available even if the question is assigned later.
    answerKeyGroups[entry.index] = entry.letters;

    // Apply directly to already parsed questions so scoring works immediately.
    if (question) {
      assignAnswerLetters(question, entry.letters);
      assignRationale(question, entry.rationale);
    }

    // Let subsequent plain lines become the rationale for this same question.
    return question;
  }

  /**
   * Separates a trailing rationale from an answer-key body when ChatGPT includes one.
   *
   * @param {string} body - Text after the answer-key prefix.
   * @returns {{answerText: string, rationale: string}} Answer letters and optional rationale text.
   */
  function splitAnswerBodyRationale(body) {
    // Match labelled rationale text after the answer letters.
    const labelledMatch = body.match(/^(.*?)\s+(?:rationale|explanation)\s*[:\-—]\s*(.+)$/i);
    if (labelledMatch) {
      return {
        answerText: labelledMatch[1].trim(),
        rationale: labelledMatch[2].trim()
      };
    }

    // Match compact forms like "B - because the symptom is expected".
    const becauseMatch = body.match(/^[\(\[]?([A-Z](?:\s*(?:,|;|and|&|\/)\s*[A-Z])*)[\)\]]?\s*(?:[\.\)]|\s*[-–—]\s*)\s*(because|since)\s+(.+)$/i);
    if (becauseMatch) {
      return {
        answerText: becauseMatch[1].trim(),
        rationale: `${becauseMatch[2]} ${becauseMatch[3]}`.trim()
      };
    }

    // Treat text after a leading answer and punctuation as repeated option text, not more answer letters.
    const repeatedOptionMatch = body.match(/^\s*(?:(?:option|choice)\s+)?[\(\[]?([A-Z])[\)\]]?\s*(?:[\.\)]|[-–—])\s+.+$/i);
    if (repeatedOptionMatch) {
      return {
        answerText: repeatedOptionMatch[1].toUpperCase(),
        rationale: ""
      };
    }

    // Return the original body when no rationale marker is present.
    return {
      answerText: body,
      rationale: ""
    };
  }

  /**
   * Detects numbered answer groups in an answer-key body.
   *
   * @param {string} body - Text after the answer-key prefix.
   * @returns {boolean} True when the key has question-number markers.
   */
  function hasGroupedAnswerNumbers(body) {
    // Match numbered keys like "1. A", "2: C", or "Question 3) B".
    return /(?:^|[;,\s]+)(?:question\s*)?\d+\s*[\.\):\-–—]\s*(?=[\(\[]?[A-Z]\b)/i.test(body);
  }

  /**
   * Parses answer-key text into per-question answer groups.
   *
   * @param {string} body - Text after the answer-key prefix.
   * @returns {string[][]} One answer-letter array per question.
   */
  function parseAnswerGroups(body) {
    // Detect grouped keys like "1. A, C; 2. B" before treating letters as one SATA key.
    const groupedMatches = [...body.matchAll(/(?:^|[;,\s]+)(?:question\s*)?\d+\s*[\.\):\-–—]\s*(?=[\(\[]?[A-Z]\b)/gi)];

    // Return each numbered group as its own question's correct letters.
    if (groupedMatches.length > 0) {
      return groupedMatches
        .map((match, index) => {
          // Slice between numbered markers so whitespace-separated keys stay grouped.
          const answerStart = (match.index || 0) + match[0].length;
          const answerEnd = groupedMatches[index + 1]?.index ?? body.length;
          return extractUniqueLetters(body.slice(answerStart, answerEnd));
        })
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
    const letters = [...text.matchAll(/\b[A-Z]\b/gi)].map((match) => match[0].toUpperCase());

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
      if (!answerGroups[index]) {
        continue;
      }

      if (questions[index].correctLetters.length === 0) {
        questions[index].correctLetters = answerGroups[index];
        questions[index].isSata = questions[index].isSata || answerGroups[index].length > 1;
      }
    }
  }

  /**
   * Assigns parsed rationale groups across parsed questions.
   *
   * @param {Array<{rationale: string}>} questions - Parsed question list.
   * @param {string[]} rationaleGroups - Ordered rationale text by question index.
   */
  function assignRationaleGroupsToQuestions(questions, rationaleGroups) {
    // Skip when no numbered rationale section was discovered.
    if (rationaleGroups.length === 0) {
      return;
    }

    // Apply numbered rationales without overwriting question-local rationale text.
    for (let index = 0; index < questions.length && index < rationaleGroups.length; index += 1) {
      if (!questions[index].rationale && rationaleGroups[index]) {
        questions[index].rationale = rationaleGroups[index];
      }
    }
  }

  /**
   * Parses a rationale or explanation label line.
   *
   * @param {string} line - Trimmed rendered line.
   * @returns {{text: string, isPlural: boolean} | null} Parsed rationale metadata.
   */
  function parseRationaleEntry(line) {
    // Match labels such as "Rationale:" or "Explanations:".
    const match = line.match(/^(rationales?|explanations?|teaching points?|review)\s*[:\-—]?\s*(.*)$/i);
    if (!match) {
      return null;
    }

    // Preserve the labelled text and whether numbered entries may follow.
    return {
      text: match[2].trim(),
      isPlural: /s$/i.test(match[1])
    };
  }

  /**
   * Parses a numbered rationale item from a rationale section.
   *
   * @param {string} line - Trimmed rendered line.
   * @returns {{index: number, text: string} | null} Zero-based rationale item.
   */
  function parseNumberedRationale(line) {
    // Match "1. text", "1) text", or "Question 1: text".
    const match = line.match(/^(?:question\s*)?(\d+)\s*[\.\):\-]\s*(.+)$/i);
    if (!match) {
      return null;
    }

    // Convert the visible question number to a zero-based array index.
    return {
      index: Math.max(0, Number(match[1]) - 1),
      text: match[2].trim()
    };
  }

  /**
   * Assigns rationale text to a parsed question when available.
   *
   * @param {{rationale: string} | null} question - Parsed question to update.
   * @param {string} rationale - Rationale text from the assistant output.
   */
  function assignRationale(question, rationale) {
    // Skip rationale text that does not map to a parsed question.
    if (!question || !rationale) {
      return;
    }

    // Store the first complete rationale for this question.
    if (!question.rationale) {
      question.rationale = rationale.trim();
    }
  }

  /**
   * Appends continuation text to a question rationale.
   *
   * @param {{rationale: string} | null} question - Parsed question to update.
   * @param {string} line - Additional rationale line.
   */
  function appendRationale(question, line) {
    // Skip continuation text without a target question.
    if (!question || !line) {
      return;
    }

    // Join rationale paragraphs with spaces for compact score feedback.
    question.rationale = question.rationale ? `${question.rationale} ${line}` : line;
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
    return /^(?:rationales?|explanations?|ordered response|correct order|next steps|teaching points?|review)\b/i.test(line);
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
   * @param {{text: string} | null} questionMatch - Optional numbered question match.
   * @returns {string} Display prompt.
   */
  function createPrompt(promptLines, questionIndex, questionMatch = null) {
    // Prefer a question marker embedded in a malformed option line.
    if (questionMatch) {
      return questionMatch.text.trim();
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

  // Expose parser helpers through the single extension namespace.
  return {
    parseMultipleChoiceQuestions,
    parseOptionLine,
    normalizeMcqLines,
    splitCompactMcqLine,
    isAnswerContentMarkerInsideCurrentSegment,
    cleanOptionText,
    parseQuestionStart,
    parseEmbeddedQuestionStart,
    createQuestion,
    extractInlineAnswerKey,
    parseAnswerEntry,
    isAnswerKeyHeading,
    isAnswerWithRationalesHeading,
    parseNumberedAnswerKeyEntry,
    isQuestionSectionHeading,
    parseStandaloneQuestionLabel,
    parseNumberedAnswerEntry,
    assignNumberedAnswerEntry,
    splitAnswerBodyRationale,
    hasGroupedAnswerNumbers,
    parseAnswerGroups,
    extractUniqueLetters,
    assignAnswerLetters,
    assignAnswerKeyToQuestions,
    assignRationaleGroupsToQuestions,
    parseRationaleEntry,
    parseNumberedRationale,
    assignRationale,
    appendRationale,
    hasSataCue,
    isExplanationBoundary,
    appendQuestionIfValid,
    createPrompt,
    isAnswerLine
  };
};