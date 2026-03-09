/**
 * @module continuation-engine
 * @description Continuation Engine — 컨텍스트 소진 시 자동 체크포인트 저장/복원.
 *
 * 에이전트 세션이 토큰 예산에 근접하면 자동으로 체크포인트를 저장하고,
 * 새 세션 시작 시 이전 체크포인트에서 이어갈 수 있도록 한다.
 *
 * 주요 기능:
 * - 토큰 사용량 기반 체크포인트 트리거 감지
 * - `.yuan/checkpoints/` 디렉토리에 JSON 파일로 체크포인트 저장
 * - Atomic write (`.tmp` → `rename`) 로 데이터 손실 방지
 * - 세션 체인 추적 (parent → child → ...)
 * - 이전 세션에서 이어갈 수 있는 continuation prompt 생성
 * - 오래된 체크포인트 자동 정리 (pruning)
 *
 * 모든 파일 I/O는 node:fs/promises 기반이며, 에러 시 throw하지 않고
 * null/false/0 등 안전한 기본값을 반환한다.
 */

import { readdir, readFile, writeFile, rename, unlink, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ContinuationCheckpoint } from "./types.js";

// ─── Config ───────────────────────────────────────────────────────

/** ContinuationEngine 설정 */
export interface ContinuationEngineConfig {
  /** 프로젝트 루트 경로 */
  projectPath: string;
  /** 체크포인트 트리거 토큰 사용 비율 (기본 0.8) */
  checkpointThreshold?: number;
  /** 세션 체인당 최대 체크포인트 수 (기본 10) */
  maxCheckpoints?: number;
}

// ─── 직렬화 보조 타입 ──────────────────────────────────────────────

/** JSON 저장 시 Date → string 변환된 형태 */
interface SerializedCheckpoint extends Omit<ContinuationCheckpoint, "createdAt"> {
  createdAt: string;
}

// ─── Constants ────────────────────────────────────────────────────

/** 기본 체크포인트 트리거 비율 */
const DEFAULT_THRESHOLD = 0.8;

/** 기본 최대 체크포인트 수 */
const DEFAULT_MAX_CHECKPOINTS = 10;

/** 체크포인트 파일 접두사 */
const CHECKPOINT_PREFIX = "checkpoint-";

/** 체크포인트 파일 확장자 */
const CHECKPOINT_EXT = ".json";

/** 임시 파일 확장자 (atomic write용) */
const TMP_EXT = ".tmp";

/** continuation prompt에 포함할 diff 최대 길이 (파일당) */
const MAX_DIFF_LENGTH = 500;

// ─── ContinuationEngine ──────────────────────────────────────────

/**
 * Continuation Engine.
 *
 * 컨텍스트/토큰 소진 시 자동 체크포인트를 저장하고,
 * 새 세션에서 이전 상태를 복원하여 이어가기를 지원한다.
 *
 * @example
 * ```typescript
 * const engine = new ContinuationEngine({
 *   projectPath: "/home/user/project",
 *   checkpointThreshold: 0.8,
 *   maxCheckpoints: 10,
 * });
 *
 * // 토큰 사용량 체크
 * if (engine.shouldCheckpoint(tokensUsed, totalBudget)) {
 *   const filePath = await engine.saveCheckpoint(checkpoint);
 *   console.log("Checkpoint saved:", filePath);
 * }
 *
 * // 이전 세션 복원
 * const latest = await engine.findLatestCheckpoint();
 * if (latest) {
 *   const prompt = engine.formatContinuationPrompt(latest);
 *   // prompt를 새 세션의 system prompt에 주입
 * }
 * ```
 */
export class ContinuationEngine {
  private readonly projectPath: string;
  private readonly checkpointDir: string;
  private readonly threshold: number;
  private readonly maxCheckpoints: number;

  /** 디렉토리 생성 여부 캐시 (중복 mkdir 방지) */
  private dirEnsured = false;

  constructor(config: ContinuationEngineConfig) {
    this.projectPath = config.projectPath;
    this.checkpointDir = join(config.projectPath, ".yuan", "checkpoints");
    this.threshold = config.checkpointThreshold ?? DEFAULT_THRESHOLD;
    this.maxCheckpoints = config.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
  }

  // ─── Public Methods ─────────────────────────────────────────────

  /**
   * 토큰 사용량 기반으로 체크포인트를 저장해야 하는지 판단한다.
   *
   * `tokensUsed / totalBudget >= threshold` 이면 true.
   *
   * @param tokensUsed - 현재까지 사용한 토큰 수
   * @param totalBudget - 전체 토큰 예산
   * @returns 체크포인트 저장 필요 여부
   */
  shouldCheckpoint(tokensUsed: number, totalBudget: number): boolean {
    if (totalBudget <= 0) return false;
    return tokensUsed / totalBudget >= this.threshold;
  }

  /**
   * 체크포인트를 파일로 저장한다.
   *
   * - sessionId가 없으면 crypto.randomUUID()로 자동 생성
   * - `.yuan/checkpoints/checkpoint-{sessionId}.json` 경로에 저장
   * - Atomic write: `.tmp` 파일에 먼저 쓰고 `rename()`
   *
   * @param checkpoint - 저장할 체크포인트 데이터
   * @returns 저장된 파일 경로 (실패 시 빈 문자열)
   */
  async saveCheckpoint(checkpoint: ContinuationCheckpoint): Promise<string> {
    try {
      await this.ensureDir();

      // sessionId가 비어있으면 자동 생성
      const sessionId = checkpoint.sessionId || randomUUID();
      const safeCheckpoint: ContinuationCheckpoint = {
        ...checkpoint,
        sessionId,
      };

      const fileName = `${CHECKPOINT_PREFIX}${sessionId}${CHECKPOINT_EXT}`;
      const filePath = join(this.checkpointDir, fileName);
      const tmpPath = `${filePath}${TMP_EXT}`;

      // Date 객체를 ISO 문자열로 직렬화
      const serialized: SerializedCheckpoint = {
        ...safeCheckpoint,
        createdAt: safeCheckpoint.createdAt.toISOString(),
      };

      const json = JSON.stringify(serialized, null, 2);

      // Atomic write: tmp에 쓰고 rename
      await writeFile(tmpPath, json, "utf-8");
      await rename(tmpPath, filePath);

      return filePath;
    } catch {
      // 파일 I/O 실패 — 빈 문자열 반환 (non-throwing)
      return "";
    }
  }

  /**
   * 이 프로젝트의 가장 최근 체크포인트를 찾는다.
   *
   * 체크포인트 디렉토리를 스캔하여 `createdAt` 기준으로 정렬,
   * 가장 최신 체크포인트를 반환한다.
   *
   * @returns 최신 체크포인트 (없으면 null)
   */
  async findLatestCheckpoint(): Promise<ContinuationCheckpoint | null> {
    try {
      const checkpoints = await this.loadAllCheckpoints();
      if (checkpoints.length === 0) return null;

      // createdAt 기준 내림차순 정렬 → 가장 최신 반환
      checkpoints.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      return checkpoints[0];
    } catch {
      return null;
    }
  }

  /**
   * 특정 세션 ID의 체크포인트를 찾는다.
   *
   * @param sessionId - 찾을 세션 ID
   * @returns 체크포인트 (없으면 null)
   */
  async findCheckpoint(sessionId: string): Promise<ContinuationCheckpoint | null> {
    try {
      const fileName = `${CHECKPOINT_PREFIX}${sessionId}${CHECKPOINT_EXT}`;
      const filePath = join(this.checkpointDir, fileName);
      return await this.readCheckpointFile(filePath);
    } catch {
      return null;
    }
  }

  /**
   * 세션 체인을 추적한다 (parent → child → ...).
   *
   * 주어진 sessionId에서 시작하여 parentSessionId를 따라
   * 루트까지 올라간 뒤, 시간순으로 정렬하여 반환한다.
   *
   * @param sessionId - 시작 세션 ID
   * @returns 시간순 정렬된 세션 체인 (빈 배열 가능)
   */
  async getSessionChain(sessionId: string): Promise<ContinuationCheckpoint[]> {
    try {
      const allCheckpoints = await this.loadAllCheckpoints();
      if (allCheckpoints.length === 0) return [];

      // sessionId → checkpoint 매핑
      const byId = new Map<string, ContinuationCheckpoint>();
      for (const cp of allCheckpoints) {
        byId.set(cp.sessionId, cp);
      }

      // 주어진 sessionId에서 시작하여 parent 체인을 거슬러 올라감
      const chain: ContinuationCheckpoint[] = [];
      const visited = new Set<string>();
      let currentId: string | undefined = sessionId;

      // 먼저 parent 체인을 거슬러 올라가서 루트를 찾는다
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const cp = byId.get(currentId);
        if (!cp) break;
        chain.unshift(cp); // 앞쪽에 삽입 (루트가 먼저)
        currentId = cp.parentSessionId;
      }

      // 주어진 sessionId의 자식 체인도 추가
      // child → 모든 checkpoint 중 parentSessionId가 현재 체인 끝인 것
      let lastId = chain.length > 0 ? chain[chain.length - 1].sessionId : sessionId;
      const childVisited = new Set(visited);

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const child = allCheckpoints.find(
          (cp) => cp.parentSessionId === lastId && !childVisited.has(cp.sessionId),
        );
        if (!child) break;
        childVisited.add(child.sessionId);
        chain.push(child);
        lastId = child.sessionId;
      }

      // 시간순 정렬
      chain.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

      return chain;
    } catch {
      return [];
    }
  }

  /**
   * 체크포인트를 기반으로 continuation prompt를 생성한다.
   *
   * 새 세션의 시스템 프롬프트에 주입하여 이전 작업을 이어갈 수 있다.
   *
   * @param checkpoint - 이전 세션의 체크포인트
   * @returns 포맷팅된 continuation prompt 문자열
   */
  formatContinuationPrompt(checkpoint: ContinuationCheckpoint): string {
    const { sessionId, parentSessionId, goal, progress, changedFiles, workingMemory, errors } =
      checkpoint;

    // 세션 ID 라인
    const sessionLine = parentSessionId
      ? `**Session ID:** ${sessionId} (continued from ${parentSessionId})`
      : `**Session ID:** ${sessionId}`;

    // 완료된 태스크
    const completedList =
      progress.completedTasks.length > 0
        ? progress.completedTasks.map((t) => `  - ${t}`).join("\n")
        : "  (none)";

    // 남은 태스크
    const remainingList =
      progress.remainingTasks.length > 0
        ? progress.remainingTasks.map((t) => `  - ${t}`).join("\n")
        : "  (none)";

    // 변경된 파일 (diff는 길이 제한)
    const changedFilesList =
      changedFiles.length > 0
        ? changedFiles
            .map((f) => {
              const truncatedDiff =
                f.diff.length > MAX_DIFF_LENGTH
                  ? `${f.diff.slice(0, MAX_DIFF_LENGTH)}... (truncated)`
                  : f.diff;
              return `- \`${f.path}\`\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;
            })
            .join("\n")
        : "(no files changed)";

    // 에러 목록
    const errorList =
      errors.length > 0 ? errors.map((e) => `- ${e}`).join("\n") : "(no errors)";

    return `## Continuation from Previous Session

${sessionLine}
**Original Goal:** ${goal}

### Progress
- Completed:
${completedList}
- Current (was in progress): ${progress.currentTask || "(none)"}
- Remaining:
${remainingList}

### Changed Files
${changedFilesList}

### Working Memory
${workingMemory || "(empty)"}

### Errors Encountered
${errorList}

### Instructions
Continue from where the previous session left off. The current task "${progress.currentTask}" may need to be restarted or completed.
Resume with the remaining tasks in order.`;
  }

  /**
   * 오래된 체크포인트를 정리한다.
   *
   * `maxCheckpoints`를 초과하는 가장 오래된 체크포인트를 삭제한다.
   * createdAt 기준 내림차순 정렬 → 최신 N개 유지 → 나머지 삭제.
   *
   * @returns 삭제된 체크포인트 수 (실패 시 0)
   */
  async pruneOldCheckpoints(): Promise<number> {
    try {
      const checkpoints = await this.loadAllCheckpointsWithPaths();
      if (checkpoints.length <= this.maxCheckpoints) return 0;

      // createdAt 기준 내림차순 정렬 (최신이 먼저)
      checkpoints.sort(
        (a, b) => new Date(b.checkpoint.createdAt).getTime() - new Date(a.checkpoint.createdAt).getTime(),
      );

      // maxCheckpoints 이후의 항목 삭제
      const toDelete = checkpoints.slice(this.maxCheckpoints);
      let deleted = 0;

      for (const item of toDelete) {
        try {
          await unlink(item.filePath);
          deleted++;
        } catch {
          // 개별 파일 삭제 실패는 무시
        }
      }

      return deleted;
    } catch {
      return 0;
    }
  }

  /**
   * 특정 세션의 체크포인트를 삭제한다.
   *
   * @param sessionId - 삭제할 세션 ID
   * @returns 삭제 성공 여부
   */
  async deleteCheckpoint(sessionId: string): Promise<boolean> {
    try {
      const fileName = `${CHECKPOINT_PREFIX}${sessionId}${CHECKPOINT_EXT}`;
      const filePath = join(this.checkpointDir, fileName);
      await unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * 체크포인트 디렉토리가 존재하는지 확인하고, 없으면 생성한다.
   * 한 번 생성 확인되면 이후 호출에서는 스킵 (dirEnsured 캐시).
   */
  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;

    try {
      await stat(this.checkpointDir);
      this.dirEnsured = true;
    } catch {
      // 디렉토리가 없으면 생성
      await mkdir(this.checkpointDir, { recursive: true });
      this.dirEnsured = true;
    }
  }

  /**
   * 체크포인트 파일 하나를 읽어 ContinuationCheckpoint로 파싱한다.
   *
   * JSON의 `createdAt` 문자열을 Date 객체로 복원한다.
   *
   * @param filePath - 체크포인트 파일 절대 경로
   * @returns 파싱된 체크포인트 (실패 시 null)
   */
  private async readCheckpointFile(filePath: string): Promise<ContinuationCheckpoint | null> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as SerializedCheckpoint;

      // createdAt을 Date 객체로 복원
      return {
        ...parsed,
        createdAt: new Date(parsed.createdAt),
      };
    } catch {
      return null;
    }
  }

  /**
   * 체크포인트 디렉토리의 모든 체크포인트를 로드한다.
   *
   * 유효하지 않은 파일(파싱 실패 등)은 건너뛴다.
   *
   * @returns 모든 유효한 체크포인트 배열
   */
  private async loadAllCheckpoints(): Promise<ContinuationCheckpoint[]> {
    try {
      await this.ensureDir();
      const entries = await readdir(this.checkpointDir);

      const checkpointFiles = entries.filter(
        (name) => name.startsWith(CHECKPOINT_PREFIX) && name.endsWith(CHECKPOINT_EXT),
      );

      const results: ContinuationCheckpoint[] = [];

      for (const fileName of checkpointFiles) {
        const filePath = join(this.checkpointDir, fileName);
        const cp = await this.readCheckpointFile(filePath);
        if (cp) results.push(cp);
      }

      return results;
    } catch {
      return [];
    }
  }

  /**
   * 모든 체크포인트를 파일 경로와 함께 로드한다.
   *
   * pruneOldCheckpoints에서 삭제할 파일 경로가 필요하므로 별도 메서드.
   *
   * @returns { checkpoint, filePath } 배열
   */
  private async loadAllCheckpointsWithPaths(): Promise<
    Array<{ checkpoint: ContinuationCheckpoint; filePath: string }>
  > {
    try {
      await this.ensureDir();
      const entries = await readdir(this.checkpointDir);

      const checkpointFiles = entries.filter(
        (name) => name.startsWith(CHECKPOINT_PREFIX) && name.endsWith(CHECKPOINT_EXT),
      );

      const results: Array<{ checkpoint: ContinuationCheckpoint; filePath: string }> = [];

      for (const fileName of checkpointFiles) {
        const filePath = join(this.checkpointDir, fileName);
        const cp = await this.readCheckpointFile(filePath);
        if (cp) results.push({ checkpoint: cp, filePath });
      }

      return results;
    } catch {
      return [];
    }
  }
}
