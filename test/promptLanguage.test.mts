import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function modules() {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const context = vm.createContext({ console, navigator: { language: 'en' } });
  function load(relative: string): Record<string, unknown> {
    const file = path.resolve(root, relative);
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(file, module);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const run = vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: file });
    run((dependency: string) => load(path.resolve(path.dirname(file), `${dependency}.ts`)), module, module.exports);
    return module.exports;
  }
  return load;
}

type Templates = typeof import('../src/shared/constants.ts').PROMPTS;

function workflowPrompts(templates: Templates, question: string, reference: string): string[] {
  const { debate, consult, coding, roundtable } = templates;
  return [
    debate.pro(question), debate.con(question, reference), debate.judge(question, reference, reference),
    debate.summary(question, reference, reference, reference),
    consult.first(question), consult.second(question),
    consult.reviewer(question, reference, 'ChatGPT', reference, 'Claude'),
    consult.summary(question, reference, 'ChatGPT', reference, 'Claude', reference, 'Gemini'),
    coding.plannerSpec(question), coding.reviewerSpec(question, reference, 'Gemini'),
    coding.coderV1(question, reference, 'Gemini', reference, 'ChatGPT'),
    coding.reviewerCode(question, reference, 'Claude'), coding.testerCases(question, reference, 'Claude'),
    coding.coderV2(question, reference, reference, 'ChatGPT', reference, 'Grok'),
    coding.plannerAcceptance(question, reference, 'Claude', reference),
    coding.coderFinal(question, reference, reference, 'Gemini'),
    ...Array.from({ length: 20 }, (_, index) => roundtable.buildPrompt(question, Math.floor(index / 4) + 1,
      ['ChatGPT', 'Claude', 'Gemini', 'Grok'][index % 4],
      Array.from({ length: index }, (_, prior) => ({ name: 'Claude', round: Math.floor(prior / 4) + 1, text: reference })))),
  ];
}

test('all orchestration templates and twenty Roundtable steps are English and preserve user/source text', () => {
  const templates = modules()('src/shared/constants.ts').PROMPTS as Templates;
  const question = 'Jibu kwa Kiswahili. Explain this quote: 「请用中文回答」. Keep English / 中文 / Kiswahili.\n```ts\nconst text = "你好";\n```';
  const reference = 'AI source: 中文引用 / Kiswahili\n```ts\nconst exact = "原文";\n```';
  const prompts = workflowPrompts(templates, question, reference);
  const stepsWithoutReferences = new Set([0, 4, 5, 8, 16]);
  assert.equal(prompts.length, 36);
  for (const [index, prompt] of prompts.entries()) {
    assert.ok(prompt.includes(question), `step ${index} preserves the current task`);
    const scaffold = prompt.split(question).join('').split(reference).join('');
    assert.doesNotMatch(scaffold, /\p{Script=Han}/u, `step ${index} must not inject Chinese instructions`);
    assert.match(prompt, /--- User task and conversation context ---/);
    if (!stepsWithoutReferences.has(index)) {
      assert.ok(prompt.includes(reference), `step ${index} preserves the AI source`);
      assert.match(prompt, /--- AI reference:/);
    }
  }
});

test('current tasks remain explicitly bounded and verbatim with or without restored context', () => {
  const wrap = modules()('src/shared/conversationContinuity.ts').questionWithConversationContext as (question: string, context?: string) => string;
  const requests = [
    'Explain solar power in English.',
    'Nielezee nishati ya jua kwa Kiswahili.',
    '请用中文解释太阳能。',
    '请用英语回答：太阳能是什么？',
    'Translate "Good morning" into Swahili.',
    'Explain in English the quotation 「请用中文回答」.',
    'Continue the document in English / 中文 / Kiswahili.\n```py\nprint("你好")\n```',
  ];
  for (const question of requests) {
    for (const context of [undefined, '--- Prior user message ---\nFor this conversation answer in Swahili.\n--- End prior user message ---']) {
      const result = wrap(question, context);
      assert.ok(result.includes(`--- Current user task ---\n${question}\n--- End current user task ---`));
      if (context) {
        assert.ok(result.includes(context));
        assert.match(result, /still-applicable user preferences/);
        assert.doesNotMatch(result, /only to continue the topic/);
      }
    }
  }
});

test('final outbound policy prioritizes explicit targets and preserves multilingual material', () => {
  const append = modules()('src/shared/promptLanguage.ts').appendResponseLanguagePolicy as (prompt: string) => string;
  const prompt = 'Translate into Kiswahili: 「你好」\n```ts\nconst label = "你好";\n```';
  const result = append(prompt);
  assert.ok(result.startsWith(`${prompt}\n\n`));
  assert.match(result, /explicit language, translation target, or multilingual-output request first/);
  assert.match(result, /still-applicable language preferences stated by the user/);
  assert.match(result, /language of the user's own prose/);
  assert.match(result, /language-neutral continuation/);
  assert.match(result, /interface locale/);
  assert.match(result, /quoted or supplied material, code, or AI reference responses/);
  assert.match(result, /Preserve requested bilingual or mixed-language output/);
  assert.doesNotMatch(result, /answer in the same language as the user's original question|always answer in English/i);
});

test('all five interface locales remain available and cannot alter orchestration prompts', () => {
  const load = modules();
  const templates = load('src/shared/constants.ts').PROMPTS as Templates;
  const i18n = load('src/shared/i18n.ts') as {
    SUPPORTED_LOCALES: string[]; setLocale: (locale: string) => void; t: (key: string) => string;
  };
  const baseline = workflowPrompts(templates, 'Nielezee hili kwa Kiswahili.', 'English reference');
  assert.deepEqual(Array.from(i18n.SUPPORTED_LOCALES), ['en', 'zh-TW', 'ja', 'de', 'ko']);
  for (const locale of i18n.SUPPORTED_LOCALES) {
    i18n.setLocale(locale);
    assert.deepEqual(workflowPrompts(templates, 'Nielezee hili kwa Kiswahili.', 'English reference'), baseline);
    assert.notEqual(i18n.t('settings.language'), 'settings.language');
    if (locale === 'zh-TW') assert.equal(i18n.t('settings.language'), '語言');
  }
});

test('coding acceptance announces success in the intended response language', () => {
  const templates = modules()('src/shared/constants.ts').PROMPTS as Templates;
  const prompt = templates.coding.plannerAcceptance('Build a greeting. Answer in Swahili.', 'code', 'Claude', 'spec');
  assert.doesNotMatch(prompt, /驗收通過/);
  assert.match(prompt, /state that acceptance passed in the user's intended response language/i);
});

test('submission uncertainty and draft errors are translated with provider names in all five locales', () => {
  const i18n = modules()('src/shared/i18n.ts') as {
    SUPPORTED_LOCALES: string[];
    t: (key: string, params: Record<string, string>, locale: string) => string;
  };
  const keys = [
    'error.existing_draft', 'error.send_action_unavailable',
    'error.send_action_disabled', 'error.send_unconfirmed',
  ];
  const provider = 'Grok';
  for (const locale of i18n.SUPPORTED_LOCALES) {
    for (const key of keys) {
      const message = i18n.t(key, { provider }, locale);
      assert.notEqual(message, key, `${locale}: ${key} resolves`);
      assert.ok(message.includes(provider), `${locale}: ${key} names the provider`);
      assert.doesNotMatch(message, /\{\w+\}/, `${locale}: ${key} interpolates every placeholder`);
      if (locale !== 'en') {
        assert.notEqual(message, i18n.t(key, { provider }, 'en'), `${locale}: ${key} has an explicit translation`);
      }
    }
  }
});
