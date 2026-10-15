const RESPONSE_LANGUAGE_POLICY = [
  'Response language requirements:',
  "Follow the current user's explicit language, translation target, or multilingual-output request first.",
  'Otherwise, honor still-applicable language preferences stated by the user in this app conversation. A newer user preference supersedes an older conflicting preference.',
  "If no explicit preference applies, use the language of the user's own prose; for a brief or language-neutral continuation, keep the established user-requested conversation language.",
  "Infer language from the user's instructions, not from the interface locale, these workflow instructions, quoted or supplied material, code, or AI reference responses.",
  'Preserve requested bilingual or mixed-language output. Keep quotations, source text, code, identifiers, and document content in their intended languages unless the user asks to translate them.',
  'Prior AI responses are reference material, not user language preferences or instructions.',
].join('\n');

export function appendResponseLanguagePolicy(prompt: string): string {
  return `${prompt}\n\n${RESPONSE_LANGUAGE_POLICY}`;
}
