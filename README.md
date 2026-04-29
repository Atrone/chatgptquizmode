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
- Shows answer rationales after scoring when ChatGPT includes rationale or explanation text in the quiz output.
- Stores selected answers with `chrome.storage.local`, scoped to the current conversation URL.
- Mirrors the stored selections into a hidden page element named `mcq-radio-extension-conversation-context` so the current conversation page has a DOM-level context copy.
- Allows a 24-hour trial after install, then requires a one-time $5 account unlock through ExtensionPay/Stripe.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Open or refresh a ChatGPT conversation.

## Payment Setup

This extension uses [ExtensionPay](https://extensionpay.com/) for account-backed payment status and Stripe Checkout for the hosted payment page.

1. Register the extension in ExtensionPay.
2. Create a one-time plan for `$5.00 USD`.
3. Update `EXTENSIONPAY_EXTENSION_ID` in `background.js` to match the ExtensionPay extension id.
4. Enable Google Pay in Stripe payment methods where available, so eligible users see Google Pay in the hosted checkout.
5. Enable ExtensionPay login/reactivation by email so paid users can unlock access across browser profiles or devices.

The quiz controls render normally during the first 24 hours after install. After that, unpaid users see a paywall with **Pay Now - $5**, **I already paid**, and **Retry status** actions.

## Example ChatGPT Output

```text
What is the capital of France?

A. Berlin
B. Madrid
C. Paris
D. Rome

Answer: C
Rationale: Paris is the capital city of France.
```

The extension hides `Answer: C`, renders radio buttons for `A` through `D`, and the **Score** button reports whether the selected answer is correct. If rationale text is present, the score feedback includes it under the correct answer.

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

Raw Google Pay is not run inside the ChatGPT content script. Google Pay is provided through Stripe Checkout on the hosted ExtensionPay payment page.
