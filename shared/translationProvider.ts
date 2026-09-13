export interface LiveVoiceOption {
  id: string;
  name: string;
  gender: 'female' | 'male' | 'neutral';
  description: string;
}

export const LIVE_VOICE_OPTIONS: LiveVoiceOption[] = [
  { id: 'marin', name: 'Marin', gender: 'female', description: 'Femenina · Neutra y clara (Recomendada)' },
  { id: 'stone', name: 'Stone', gender: 'male', description: 'Masculina · Firme e institucional (Recomendada)' },
  { id: 'cedar', name: 'Cedar', gender: 'male', description: 'Masculina · Cálida y natural' },
  { id: 'quartz', name: 'Quartz', gender: 'neutral', description: 'Neutra · Máxima estabilidad tímbrica' },
  { id: 'meridian', name: 'Meridian', gender: 'neutral', description: 'Neutra · Tono documental sereno' },
  { id: 'willow', name: 'Willow', gender: 'female', description: 'Femenina · Suave y pausada' },
  { id: 'cinder', name: 'Cinder', gender: 'female', description: 'Femenina · Directa y profesional' },
  { id: 'tempo', name: 'Tempo', gender: 'neutral', description: 'Neutra · Ritmo ágil y dinámico' },
];

export const TRANSLATION_PROVIDER = {
  id: 'openai',
  name: 'OpenAI',
  model: 'GPT Live 1',
  apiModel: 'gpt-live-1',
  defaultVoice: 'marin',
} as const;

export function getVoiceById(id: string): LiveVoiceOption {
  return LIVE_VOICE_OPTIONS.find((v) => v.id === id) || LIVE_VOICE_OPTIONS[0];
}

