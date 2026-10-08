/**
 * Console log format shared by the local web server and its Runtime adapters.
 * Keep native console semantics while adding a timestamp, level and readable Error/object output.
 */
import { formatWithOptions } from 'node:util';

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
let installed = false;

export function installConsoleLogger(): void {
  if (installed) return;
  installed = true;
  const mutableConsole = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>;

  const levels: Record<ConsoleMethod, string> = {
    log: 'INFO',
    info: 'INFO',
    warn: 'WARN',
    error: 'ERROR',
    debug: 'DEBUG',
  };

  for (const method of Object.keys(levels) as ConsoleMethod[]) {
    const original = mutableConsole[method].bind(console);
    mutableConsole[method] = (...args: unknown[]) => {
      const timestamp = new Date().toISOString();
      const rendered = formatWithOptions({
        colors: Boolean(process.stdout.isTTY),
        depth: 6,
        maxArrayLength: 100,
        maxStringLength: 12_000,
        breakLength: 120,
        compact: 3,
      }, ...args);
      original('[' + timestamp + '] [' + levels[method] + ']', rendered);
    };
  }
}
