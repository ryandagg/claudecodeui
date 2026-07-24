import test from 'node:test';
import assert from 'node:assert/strict';

import { extractAskUserQuestionAnswers } from './toolConfigs';

// The persisted AskUserQuestion tool-use INPUT only carries `questions`; the
// answers the user picked (options AND free-text "Other" responses) live in the
// tool RESULT. These cover the three source paths the extractor falls through.

test('prefers structured answers from toolResult.toolUseResult', () => {
  const answers = extractAskUserQuestionAnswers(
    { questions: [{ question: 'Pick one?' }] },
    { toolUseResult: { answers: { 'Pick one?': 'A' } } },
  );
  assert.deepEqual(answers, { 'Pick one?': 'A' });
});

test('preserves a free-text "Other" answer from the structured result', () => {
  const custom = 'The answered state should match the selection I made.';
  const answers = extractAskUserQuestionAnswers(
    { questions: [{ question: 'How should it look?' }] },
    { toolUseResult: { answers: { 'How should it look?': custom } } },
  );
  assert.equal(answers['How should it look?'], custom);
});

test('falls back to input.answers when the result lacks a structured map', () => {
  const answers = extractAskUserQuestionAnswers(
    { questions: [{ question: 'Q?' }], answers: { 'Q?': 'from-input' } },
    { content: 'no answer markers here' },
  );
  assert.deepEqual(answers, { 'Q?': 'from-input' });
});

test('parses answers from the human-readable result string as a last resort', () => {
  const content =
    'Your questions have been answered: "How do you sign in?"="Try this URL https://x.example/dashboards/". ' +
    'You can now continue with these answers in mind.';
  const answers = extractAskUserQuestionAnswers({ questions: [{ question: 'How do you sign in?' }] }, { content });
  assert.deepEqual(answers, { 'How do you sign in?': 'Try this URL https://x.example/dashboards/' });
});

test('parses multiple question/answer pairs from the result string', () => {
  const content =
    'Your questions have been answered: "Q1?"="A1". "Q2?"="A2". You can now continue with these answers in mind.';
  const answers = extractAskUserQuestionAnswers({ questions: [] }, { content });
  assert.deepEqual(answers, { 'Q1?': 'A1', 'Q2?': 'A2' });
});

test('returns an empty map when nothing is answered (skipped)', () => {
  assert.deepEqual(extractAskUserQuestionAnswers({ questions: [{ question: 'Q?' }] }, undefined), {});
  assert.deepEqual(extractAskUserQuestionAnswers({ questions: [{ question: 'Q?' }] }, { content: '' }), {});
});
