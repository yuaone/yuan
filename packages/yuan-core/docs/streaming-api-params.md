# YUAN LLM Streaming API Parameters

> **이 파일은 LLM API 파라미터 SSOT.** 다른 세션/Claude가 헷갈리지 않도록 여기서만 관리.

---

## Gemini (Google) — `gemini-2.5-flash`

### Endpoint
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key={API_KEY}
```

### Request Body
```json
{
  "contents": [...],
  "systemInstruction": { "parts": [{ "text": "..." }] },
  "tools": [{ "functionDeclarations": [...] }],
  "generationConfig": {
    "maxOutputTokens": 8192,
    "thinkingConfig": {
      "thinkingBudget": 8192,
      "includeThoughts": true
    }
  }
}
```

### 주의사항
- `additionalProperties`, `$schema`, `$defs`, `definitions`, `default`, `examples`, `$id`, `$ref` →
  `tools[].functionDeclarations[].parameters` 에 **절대 포함 금지** (400 에러).
  `stripGeminiUnsupported()` 함수로 제거 필수.
- `includeThoughts: true` 없으면 reasoning 토큰이 응답에 안 옴 → ReasoningPanel 비어있음.
- `thinkingBudget: 8192` = 생각에 최대 8192 토큰 사용. 0이면 thinking 비활성화.
- SSE 스트림: `data: {...}\n\n` 포맷. `[DONE]` 아닌 JSON 파싱.
- `part.thought === true` 인 part = thinking token (reasoning_delta로 emit).
- `part.text` (thought 아닌) = output text (text_delta로 emit).

### 현재 소스 위치
`packages/yuan-core/src/llm-client.ts` → `chatStreamGeminiNative()` (line ~779)

---

## Anthropic — `claude-sonnet-4-5` etc

### Endpoint
```
POST https://api.anthropic.com/v1/messages
```

### 주의사항
- `anthropic-version: 2023-06-01` 헤더 필수.
- Streaming: `stream: true`.
- thinking: `{ type: "thinking", budget_tokens: 8192 }` in `thinking` field.

---

## OpenAI — `gpt-4o` etc

### Endpoint
```
POST https://api.openai.com/v1/chat/completions
```

### 주의사항
- `stream: true`.
- SSE: `data: {"choices": [{"delta": {"content": "..."}}]}\n\n`.

---

## 알려진 버그 이력

| 날짜 | 버그 | 원인 | 수정 |
|---|---|---|---|
| 2026-03-14 | Gemini 400 에러 | `additionalProperties` in tool params | `stripGeminiUnsupported()` 추가 |
| 2026-03-15 | `includeThoughts` 누락 | thinkingConfig에 빠짐 | `includeThoughts: true` 추가 필요 |
| 2026-03-15 | 마우스 flood 14초 묵음 | `?1002h` drag events 과다 | `?1000h` 로 교체 |
| 2026-03-15 | 타이머 0초 고정 | setInterval 1000ms | 200ms 로 변경 |
