/**
 * 确保本机 opencode serve 在运行（npm run dev / start 的 pre 钩子）。
 *
 *   node scripts/ensure-opencode.mjs            # 端口空闲就按 .env 拉起；能复用就复用
 *   node scripts/ensure-opencode.mjs --reset    # 先杀掉占着端口的进程，再按 .env 重起
 *
 * 密码、代理、地址全部以 .env 文件为准（终端残留的 export 会被忽略并告警），
 * 保证 serve 和后面启动的 app 读到同一个值；两边不一致就是 401，连上也不通。
 *
 * 检查不通过只打印警告，不阻塞主服务启动——Copilot 通道不受影响。退出码永远 0。
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4096';

/** 最小 .env 解析：只要 KEY=VALUE 行，不要引号和 export 魔法。 */
function readDotEnvFile() {
  const result = {};
  let raw = '';
  try {
    raw = fs.readFileSync(path.resolve('.env'), 'utf8');
  } catch {
    return result;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

const dotEnv = readDotEnvFile();
const warnings = [];

function envFromFile(name, fallback = '') {
  const fromFile = (dotEnv[name] ?? '').trim();
  const fromProcess = (process.env[name] ?? '').trim();
  if (fromProcess && fromFile && fromProcess !== fromFile) {
    warnings.push(`终端里残留的 ${name} 和 .env 不一致，用 .env 的值（残留值已忽略）。`);
  }
  return fromFile || fromProcess || fallback;
}

function check(ok, message) {
  console.log((ok ? '  ✓ ' : '  ! ') + message);
  return ok;
}

function portOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout || '').trim());
    });
  });
}

/** 查出占着端口的进程（lsof 不可用就返回空数组，不硬报错）。 */
async function processesOnPort(port) {
  const output = await runCommand('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function killProcesses(pids) {
  for (const pid of pids) {
    await runCommand('kill', [pid]);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

async function authedProviderOk(baseUrl, password, timeoutMs = 3000) {
  try {
    const response = await fetch(baseUrl + '/provider', {
      headers: { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.status;
  } catch {
    return -1;
  }
}

async function waitServe(baseUrl, password, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await authedProviderOk(baseUrl, password);
    if (status === 200) return 'ok';
    if (status === 401) return 'auth-failed';
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return 'timeout';
}

async function commandExists(command) {
  const pathEnv = process.env.PATH || '';
  const found = await runCommand('sh', ['-c', `command -v ${command}`]);
  return Boolean(found) || pathEnv.split(':').some((dir) => {
    try {
      return fs.existsSync(path.join(dir, command));
    } catch {
      return false;
    }
  });
}

async function main() {
  const reset = process.argv.includes('--reset');
  console.log('[opencode] 启动前检查' + (reset ? '（--reset：先清占位进程）' : '') + '：');

  if (envFromFile('OPENCODE_ENABLED', 'true') !== 'true') {
    console.log('[opencode] OPENCODE_ENABLED != true，跳过。');
    return;
  }

  // 1. 基础变量检查：地址合法、密码存在。
  let baseUrl = envFromFile('OPENCODE_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '');
  let host = '127.0.0.1';
  let port = 4096;
  try {
    const parsed = new URL(baseUrl);
    host = parsed.hostname;
    port = Number(parsed.port) || 4096;
    check(true, `地址合法：${baseUrl}`);
  } catch {
    check(false, `OPENCODE_BASE_URL 写错了（${baseUrl}），用默认 ${DEFAULT_BASE_URL}。`);
    baseUrl = DEFAULT_BASE_URL;
  }
  const password = envFromFile('OPENCODE_SERVER_PASSWORD');
  check(Boolean(password), password ? '密码已配置（serve 和 app 用同一个）' : '未配置 OPENCODE_SERVER_PASSWORD：不自动拉起，且已运行的 serve 若要求认证会连不上');

  // 2. 代理可达性检查：代理挂了 serve 照样能起，但模型调用会转圈超时，提前说。
  const proxyRaw = envFromFile('OPENCODE_HTTP_PROXY', process.env.http_proxy || 'http://127.0.0.1:10809');
  try {
    const proxyUrl = new URL(proxyRaw);
    const proxyHost = proxyUrl.hostname;
    const proxyPort = Number(proxyUrl.port) || 80;
    const reachable = await portOpen(proxyHost, proxyPort);
    check(reachable, `代理可达：${proxyHost}:${proxyPort}`);
    if (!reachable) {
      warnings.push('代理连不上：serve 能起，但 Muse Spark 这类要出站的模型会超时。先把代理打开再跑。');
    }
  } catch {
    check(false, `代理地址写错了（${proxyRaw}），模型出站可能不通`);
  }

  // 3. opencode CLI 是否存在。
  if (!await commandExists('opencode')) {
    check(false, '没找到 opencode CLI：跳过自动拉起，只走 Copilot 通道');
    return;
  }

  // 4. 端口占位检查：--reset 直接杀；否则只复用“密码也对”的 serve。
  const holders = await processesOnPort(port);
  if (reset && holders.length > 0) {
    await killProcesses(holders);
    const stillThere = await processesOnPort(port);
    check(stillThere.length === 0, stillThere.length === 0
      ? `已停掉占位进程：${holders.join(', ')}`
      : `占位进程杀不掉（PID ${stillThere.join(', ')}），手动处理后再跑`);
    if (stillThere.length > 0) return;
  }

  if (!password) return;

  if (await portOpen(host, port)) {
    // 端口通不代表能用：拿 .env 的密码验一下，401 说明端口被一个密码不明的 serve 占了。
    const status = await authedProviderOk(baseUrl, password);
    if (status === 200) {
      check(true, `复用已运行的 serve（${baseUrl}）。`);
      return;
    }
    check(false, `${baseUrl} 有响应但密码不对（HTTP ${status}）：疑似手动启动的 serve 占着端口。用 --reset 重起，或停掉它再跑。`);
    return;
  }
  check(true, `端口 ${port} 空闲，准备拉起。`);

  const env = {
    ...process.env,
    http_proxy: envFromFile('OPENCODE_HTTP_PROXY', process.env.http_proxy || 'http://127.0.0.1:10809'),
    https_proxy: envFromFile('OPENCODE_HTTPS_PROXY', process.env.https_proxy || 'http://127.0.0.1:10809'),
    all_proxy: envFromFile('OPENCODE_ALL_PROXY', process.env.all_proxy || 'socks5://127.0.0.1:10809'),
    OPENCODE_SERVER_PASSWORD: password,
  };

  const logFile = path.resolve('.workspace/opencode-serve.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const quotedLog = "'" + logFile.replace(/'/g, "'\\''") + "'";

  try {
    // 直接传 stream 给 spawn 在部分 Node 版本会报 stdio 非法；走 shell 重定向最稳。
    // 密码只放在环境变量里，不会出现在命令行和日志中。
    const child = spawn(
      'sh',
      ['-c', `exec opencode serve --hostname ${host} --port ${port} >> ${quotedLog} 2>&1`],
      { env, detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch (error) {
    check(false, '启动失败：' + (error instanceof Error ? error.message : error));
    return;
  }

  const state = await waitServe(baseUrl, password);
  if (state === 'ok') {
    check(true, `serve 已拉起（${baseUrl}），日志：${logFile}`);
  } else if (state === 'auth-failed') {
    check(false, 'serve 起来了但密码验证失败，检查 OPENCODE_SERVER_PASSWORD 是否两边一致。');
  } else {
    check(false, `serve 30 秒还没就绪，看日志：${logFile}`);
  }
}

main().then(
  () => {
    for (const warning of warnings) console.warn('[opencode] ' + warning);
    process.exit(0);
  },
  (error) => {
    console.warn('[opencode] ' + (error instanceof Error ? error.message : error));
    process.exit(0);
  },
);
