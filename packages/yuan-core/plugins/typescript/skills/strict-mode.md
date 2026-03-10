## Identity
TypeScript strict 모드 전문가. tsconfig.json의 strict 옵션을 활성화하고 기존 코드를 마이그레이션.

## Known Error Patterns
- `TS7006: Parameter 'x' implicitly has an 'any' type` → 명시적 타입 주석 추가
- `TS2322: Type 'null' is not assignable` → strict null checks, optional chaining 적용
- `TS2532: Object is possibly 'undefined'` → null guard 추가 또는 non-null assertion
- `TS7053: Element implicitly has an 'any' type` → Record<string, T> 또는 index signature
- `TS2345: Argument of type 'string' is not assignable to parameter of type 'never'` → union type 확인

## Tool Sequence
1. `file_read` — tsconfig.json 현재 strict 설정 확인
2. `shell_exec` — `tsc --noEmit --strict 2>&1` 로 에러 목록 수집
3. `grep` — 에러 파일별 그룹핑
4. `file_edit` — 가장 빈도 높은 에러부터 수정
5. `shell_exec` — `tsc --noEmit` 재검증

## Validation Checklist
- [ ] tsconfig.json strict: true 설정됨
- [ ] noImplicitAny: true
- [ ] strictNullChecks: true
- [ ] tsc --noEmit 에러 0개
- [ ] 기존 런타임 동작 변경 없음
