/**
 * @module image-observer
 * @description Deterministic image classification for coding agent.
 * Classifies images by hint patterns (filename, context, size).
 * NO LLM, NO async, pure heuristic.
 * YUA reference: ai/image/image-observer.ts
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type ImageHint =
  | "LIKELY_CODE"      // IDE screenshot, terminal output
  | "LIKELY_ERROR"     // Error dialog, stack trace screenshot
  | "LIKELY_UI"        // UI mockup, web page screenshot
  | "LIKELY_DIAGRAM"   // Architecture diagram, flowchart
  | "UNCLEAR";

export interface ImageObservation {
  hint: ImageHint;
  confidence: number;     // 0~1
  suggestOCR: boolean;    // should we try to extract text?
  contextNote?: string;   // hint for LLM
}

// ─── Core ────────────────────────────────────────────────────────────────────

/** Observe image from filename + user message context */
export function observeImage(params: {
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  userMessage: string;
}): ImageObservation {
  const { fileName, userMessage } = params;
  const msg = userMessage.toLowerCase();
  const name = (fileName ?? "").toLowerCase();

  // Error signals in message
  if (/에러|오류|error|bug|crash|fail|깨져|안됨|broken|stack\s*trace/i.test(msg)) {
    return {
      hint: "LIKELY_ERROR",
      confidence: 0.8,
      suggestOCR: true,
      contextNote: "User reports an error — extract error text from image",
    };
  }

  // Code/terminal signals
  if (
    /코드|code|terminal|console|ide|vscode|output|로그|log/i.test(msg) ||
    /\.ts|\.js|\.py|\.go|\.rs/.test(name)
  ) {
    return {
      hint: "LIKELY_CODE",
      confidence: 0.7,
      suggestOCR: true,
      contextNote: "Image likely contains code or terminal output",
    };
  }

  // UI signals
  if (/ui|디자인|design|layout|화면|screen|page|컴포넌트|component|mockup|wireframe/i.test(msg)) {
    return {
      hint: "LIKELY_UI",
      confidence: 0.7,
      suggestOCR: false,
      contextNote: "Image appears to be a UI design or screenshot",
    };
  }

  // Diagram signals
  if (/diagram|다이어그램|flowchart|아키텍처|architecture|구조|structure|erd|uml/i.test(msg)) {
    return {
      hint: "LIKELY_DIAGRAM",
      confidence: 0.7,
      suggestOCR: false,
      contextNote: "Image appears to be an architecture/flow diagram",
    };
  }

  // Filename hints
  if (/screenshot|capture|스크린샷/.test(name)) {
    return { hint: "LIKELY_UI", confidence: 0.5, suggestOCR: true };
  }
  if (/error|fail|crash/.test(name)) {
    return { hint: "LIKELY_ERROR", confidence: 0.6, suggestOCR: true };
  }

  return { hint: "UNCLEAR", confidence: 0.3, suggestOCR: false };
}
