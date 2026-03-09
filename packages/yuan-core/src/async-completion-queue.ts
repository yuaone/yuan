/**
 * @module async-completion-queue
 * @description 비동기 완료 큐 — 병렬 에이전트 완료 이벤트 수집용.
 *
 * 생산자(push)와 소비자(shift)를 비동기로 연결하는 제네릭 큐.
 * 버퍼에 아이템이 있으면 즉시 반환, 없으면 push될 때까지 대기.
 */

/**
 * 병렬 에이전트 완료 이벤트를 수집하는 비동기 큐.
 *
 * @typeParam T - 큐에 저장할 아이템 타입
 *
 * @example
 * ```ts
 * const queue = new AsyncCompletionQueue<TaskResult>();
 *
 * // Producer
 * queue.push(result);
 *
 * // Consumer (awaits if buffer is empty)
 * const item = await queue.shift();
 * ```
 */
export class AsyncCompletionQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(item: T) => void> = [];

  /**
   * 아이템을 큐에 추가한다.
   * 대기 중인 소비자가 있으면 즉시 전달하고, 없으면 버퍼에 저장한다.
   *
   * @param item - 큐에 추가할 아이템
   */
  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.buffer.push(item);
    }
  }

  /**
   * 큐에서 아이템을 하나 꺼낸다.
   * 버퍼에 아이템이 있으면 즉시 반환하고, 없으면 push될 때까지 대기한다.
   *
   * @returns 큐에서 꺼낸 아이템
   */
  async shift(): Promise<T> {
    const item = this.buffer.shift();
    if (item !== undefined) {
      return item;
    }
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * 현재 버퍼에 있는 모든 아이템을 즉시 반환한다 (논블로킹, 동기).
   * 반환 후 버퍼는 비워진다.
   *
   * Note: 의도적으로 동기 메서드입니다. dag-orchestrator의 for...of 루프에서
   * 즉시 반환이 필요하므로 async가 아닌 sync로 유지합니다.
   *
   * @returns 버퍼에 있던 모든 아이템 배열
   */
  drain(): T[] {
    const items = this.buffer.splice(0);
    return items;
  }

  /**
   * 현재 버퍼에 대기 중인 아이템 수.
   */
  get length(): number {
    return this.buffer.length;
  }
}
