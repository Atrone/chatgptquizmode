# ChatGPT MCQ Radio Answers

A small Manifest V3 Chrome extension that detects multiple-choice-question style ChatGPT outputs, hides visible answer-key lines, and adds answer-selection controls.

## What It Does

- Runs on `https://chatgpt.com/*` and `https://chat.openai.com/*`.
- Detects answer options formatted like `A.`, `A)`, `A:`, or `A -`.
- Hides answer-key lines such as `Answer: B`, `Correct answer: C`, and `The correct answer is A`.
- Adds radio buttons for standard single-answer questions.
- Detects SATA prompts such as `SATA`, `select all that apply`, and `choose all that apply`, then uses checkboxes.
- Hides the original ChatGPT multiple-choice output after the generated answer controls finish rendering.
- Adds a **Score** button that grades selected answers against parsed answer keys, including multi-answer SATA keys.
- Stores selected answers with `chrome.storage.local`, scoped to the current conversation URL.
- Mirrors the stored selections into a hidden page element named `mcq-radio-extension-conversation-context` so the current conversation page has a DOM-level context copy.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Open or refresh a ChatGPT conversation.

## Example ChatGPT Output

```text
What is the capital of France?

A. Berlin
B. Madrid
C. Paris
D. Rome

Answer: C
```

The extension hides `Answer: C`, renders radio buttons for `A` through `D`, and the **Score** button reports whether the selected answer is correct.

## SATA Example

```text
SATA: Which findings should the nurse report? Select all that apply.

A. Chest pain
B. Normal temperature
C. Shortness of breath
D. New confusion

Correct answers: A, C, D
```

The extension renders checkboxes and requires the exact selected set for the question to score as correct.

## Notes

The extension stores selections per conversation path. It cannot directly add selected answers to ChatGPT's model-side memory or server-side conversation state, but it keeps them available to the active browser conversation through extension storage and a hidden DOM context element.
