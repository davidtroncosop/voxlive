export type TranslationProvider = 'gemini' | 'openai';

export const TRANSLATION_PROVIDER_OPTIONS: Array<{
  id: TranslationProvider;
  name: string;
  model: string;
}> = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    model: 'Gemini 3.5 Live Translate',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    model: 'GPT Realtime Translate',
  },
];

export function isTranslationProvider(value: unknown): value is TranslationProvider {
  return value === 'gemini' || value === 'openai';
}
