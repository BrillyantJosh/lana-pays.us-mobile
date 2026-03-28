import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import sl from './locales/sl.json';
import hu from './locales/hu.json';
import it from './locales/it.json';
import es from './locales/es.json';
import pl from './locales/pl.json';
import pt from './locales/pt.json';
import de from './locales/de.json';
import hr from './locales/hr.json';
import sr from './locales/sr.json';
import ru from './locales/ru.json';
import zh from './locales/zh.json';

const resources = {
  en: { translation: en },
  sl: { translation: sl },
  hu: { translation: hu },
  it: { translation: it },
  es: { translation: es },
  pl: { translation: pl },
  pt: { translation: pt },
  de: { translation: de },
  hr: { translation: hr },
  sr: { translation: sr },
  ru: { translation: ru },
  zh: { translation: zh },
};

// Normalize BCP-47 codes to our supported subset (e.g. "en-US" → "en", "es-419" → "es")
function normalizeLocale(code: string): string {
  const base = code.split('-')[0].toLowerCase();
  return base in resources ? base : 'en';
}

const savedLang = localStorage.getItem('lang');

i18n.use(initReactI18next).init({
  resources,
  lng: savedLang ? normalizeLocale(savedLang) : 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function changeLanguage(lang: string) {
  const normalized = normalizeLocale(lang);
  i18n.changeLanguage(normalized);
  localStorage.setItem('lang', normalized);
}

export function getCurrentLanguage(): string {
  return i18n.language || 'en';
}

export default i18n;
