export type UserRole = 'guide' | 'visitor' | null;

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface Language {
  code: string;
  name: string;
  flag: string;
  speechCode: string; // code used by Web Speech API
}

export interface TranscriptLine {
  id: string;
  timestamp: string;
  originalText: string;
  translatedText?: string;
  languageCode?: string;
  isFinal: boolean;
}

export interface RoomState {
  code: string;
  role: UserRole;
  status: ConnectionStatus;
  errorMessage?: string;
  activeListeners: number;
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'es', name: 'Español', flag: '🇪🇸', speechCode: 'es-ES' },
  { code: 'en', name: 'English', flag: '🇺🇸', speechCode: 'en-US' },
  { code: 'fr', name: 'Français', flag: '🇫🇷', speechCode: 'fr-FR' },
  { code: 'it', name: 'Italiano', flag: '🇮🇹', speechCode: 'it-IT' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪', speechCode: 'de-DE' },
  { code: 'ja', name: '日本語', flag: '🇯🇵', speechCode: 'ja-JP' },
  { code: 'pt', name: 'Português', flag: '🇵🇹', speechCode: 'pt-PT' },
  { code: 'zh', name: '中文', flag: '🇨🇳', speechCode: 'zh-CN' }
];
