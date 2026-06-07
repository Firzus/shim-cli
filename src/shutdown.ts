type Task = () => void | Promise<void>;

const tasks: Task[] = [];
let installed = false;
let running = false;

/** Register a cleanup callback run once on SIGINT/SIGTERM. */
export function onShutdown(task: Task): void {
  tasks.push(task);
}

export function installShutdown(): void {
  if (installed) return;
  installed = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void shutdown();
    });
  }
}

async function shutdown(): Promise<void> {
  if (running) return;
  running = true;
  for (const task of tasks.reverse()) {
    try {
      await task();
    } catch {
      // best-effort cleanup
    }
  }
  process.exit(0);
}
