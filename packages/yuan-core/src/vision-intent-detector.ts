/**
 * @module vision-intent-detector
 * @description Detects when LLM or user text signals intent to look at an image,
 * then extracts the target file path. Supports 9+ languages.
 */

export interface VisionIntent {
  /** Detected natural language of the signal, e.g. "ko" | "en" | "ja" | "zh" | "es" | "fr" | "de" | "ru" | "ar" */
  detectedLanguage: string;
  /** Extracted image file path */
  filePath: string;
  /** The phrase that matched the intent signal */
  intentPhrase: string;
  /** Detection confidence 0.0–1.0 */
  confidence: number;
}

// ─── Intent patterns per language ───────────────────────────────────────────

interface LangPattern {
  lang: string;
  phrases: string[];
}

const LANG_PATTERNS: LangPattern[] = [
  {
    lang: "ko",
    phrases: [
      "이미지 확인",
      "스크린샷 확인",
      "사진 봐",
      "그림 확인",
      "이미지 봐",
      "화면 봐",
      "파일 읽어",
      "이미지 읽어",
      "스크린샷 읽어",
      "이미지를 확인",
      "사진을 봐",
      "그림을 확인",
      "이미지를 봐",
      "화면을 봐",
    ],
  },
  {
    lang: "en",
    phrases: [
      "let me see",
      "let me look at",
      "check the image",
      "look at",
      "view the screenshot",
      "analyze the image",
      "read the image",
      "show me",
      "what's in",
      "examine",
      "inspect the image",
      "open the image",
      "view the image",
      "check the screenshot",
      "analyze the screenshot",
    ],
  },
  {
    lang: "ja",
    phrases: [
      "画像を確認",
      "スクリーンショットを見",
      "イメージを確認",
      "画像を見て",
      "画像を読む",
      "画像を調べる",
    ],
  },
  {
    lang: "zh",
    phrases: [
      "查看图片",
      "看一下图",
      "检查截图",
      "分析图像",
      "查看截图",
      "看看图片",
      "读取图片",
    ],
  },
  {
    lang: "es",
    phrases: [
      "ver la imagen",
      "analizar imagen",
      "revisar captura",
      "mirar la imagen",
      "examinar la imagen",
      "ver captura de pantalla",
    ],
  },
  {
    lang: "fr",
    phrases: [
      "voir l'image",
      "regarder l'image",
      "analyser l'image",
      "vérifier l'image",
      "examiner l'image",
      "regarder la capture",
    ],
  },
  {
    lang: "de",
    phrases: [
      "bild ansehen",
      "screenshot prüfen",
      "bild analysieren",
      "bild überprüfen",
      "screenshot ansehen",
      "bild lesen",
    ],
  },
  {
    lang: "ru",
    phrases: [
      "посмотрите на изображение",
      "проверь скриншот",
      "посмотри на изображение",
      "проверить скриншот",
      "посмотри на картинку",
      "проверь изображение",
    ],
  },
  {
    lang: "ar",
    phrases: [
      "انظر إلى الصورة",
      "تحقق من الصورة",
      "راجع الصورة",
      "حلل الصورة",
      "فحص لقطة الشاشة",
    ],
  },
];

// ─── File path extraction regex ─────────────────────────────────────────────

/** Matches quoted image paths: "foo.png", 'bar.jpg', `baz.webp` */
const QUOTED_IMAGE_PATH_RE =
  /['"`]([^'"`\s]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp))['"`]/gi;

/** Matches bare image paths (relative or absolute, no spaces) */
const BARE_IMAGE_PATH_RE =
  /(?:^|[\s(,])(\/?(?:[\w.\-]+\/)*[\w.\-]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp))(?:$|[\s),])/gi;

// ─── Language detection helpers ──────────────────────────────────────────────

function detectScript(text: string): string | null {
  if (/[\uAC00-\uD7A3]/.test(text)) return "ko";
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return "ja";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[\u0400-\u04FF]/.test(text)) return "ru";
  return null;
}

// ─── Core class ─────────────────────────────────────────────────────────────

/**
 * Detects vision intent in LLM / user text and extracts image file paths.
 *
 * @example
 * ```ts
 * const detector = new VisionIntentDetector();
 * const intent = detector.detect('let me look at "screenshot.png" to diagnose the error');
 * // → { detectedLanguage: "en", filePath: "screenshot.png", intentPhrase: "let me look at", confidence: 0.95 }
 * ```
 */
export class VisionIntentDetector {
  /**
   * Attempt to detect a vision intent in `text`.
   *
   * Returns `null` when no intent signal is found, or when an intent is found
   * but no image file path can be extracted from the surrounding context.
   */
  detect(text: string): VisionIntent | null {
    if (!text || text.trim().length === 0) return null;

    const lower = text.toLowerCase();

    // Try each language's patterns
    for (const { lang, phrases } of LANG_PATTERNS) {
      for (const phrase of phrases) {
        const phraseToCheck = lang === "de" ? phrase.toLowerCase() : phrase;
        if (lower.includes(phraseToCheck)) {
          // Phrase matched — now find an image path in the text
          const filePath = extractImagePath(text);
          if (filePath) {
            // Higher confidence when the phrase is more specific
            const confidence = computeConfidence(phrase, filePath);
            return {
              detectedLanguage: lang,
              filePath,
              intentPhrase: phrase,
              confidence,
            };
          }
        }
      }
    }

    // Fallback: detect by Unicode script only (phrase not in list but script is clear)
    const scriptLang = detectScript(text);
    if (scriptLang) {
      const filePath = extractImagePath(text);
      if (filePath) {
        return {
          detectedLanguage: scriptLang,
          filePath,
          intentPhrase: "",
          confidence: 0.4, // low confidence — no phrase match
        };
      }
    }

    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the first image file path from text.
 * Prefers quoted paths (more explicit) over bare paths.
 */
function extractImagePath(text: string): string | null {
  // Reset lastIndex (global regex reuse safety)
  QUOTED_IMAGE_PATH_RE.lastIndex = 0;
  BARE_IMAGE_PATH_RE.lastIndex = 0;

  const quotedMatch = QUOTED_IMAGE_PATH_RE.exec(text);
  if (quotedMatch?.[1]) return quotedMatch[1];

  const bareMatch = BARE_IMAGE_PATH_RE.exec(text);
  if (bareMatch?.[1]) return bareMatch[1].trim();

  return null;
}

/**
 * Compute confidence score based on phrase specificity and path quality.
 *
 * - Long, specific phrases (e.g. "analyze the image") → 0.90–0.95
 * - Short generic phrases (e.g. "show me") → 0.70–0.80
 * - Quoted path found → +0.05 bonus (capped at 1.0)
 */
function computeConfidence(phrase: string, filePath: string): number {
  let base = 0.75;

  // Longer phrase → more specific intent
  if (phrase.length >= 15) base = 0.95;
  else if (phrase.length >= 10) base = 0.90;
  else if (phrase.length >= 6) base = 0.80;

  // Quoted path → more explicit reference
  if (/['"`]/.test(filePath)) {
    // path itself was extracted from quotes
    base = Math.min(1.0, base + 0.05);
  }

  return Math.round(base * 100) / 100;
}
