export class WorkspaceLock {

  private locks = new Map<string, Promise<void>>()

  async acquire(file:string):Promise<() => void>{

    let release!:()=>void

    const prev = this.locks.get(file)

    const next = new Promise<void>(r => release = r)

    this.locks.set(file,next)

    if(prev) await prev

    return () => {
      release()
      this.locks.delete(file)
    }

  }

}