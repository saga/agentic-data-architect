#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const venvDir = path.join(root, '.venv');
const requirements = path.join(root, 'requirements-dev.txt');
const configuredPython = process.env['SQLGLOT_PYTHON'];
const python = process.env['PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3');
const venvPython = process.platform === 'win32'
  ? path.join(venvDir, 'Scripts', 'python.exe')
  : path.join(venvDir, 'bin', 'python');

function run(command, args) {
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}

if (configuredPython) {
  try {
    execFileSync(configuredPython, ['-c', 'import sqlglot; import graphify; import mcp'], {
      cwd: root,
      stdio: 'ignore',
      env: process.env,
    });
    console.log(`Python test interpreter: ${configuredPython} (sqlglot + graphify + mcp)`);
    process.exit(0);
  } catch {
    console.error(`SQLGLOT_PYTHON does not have sqlglot + graphify + mcp installed: ${configuredPython}`);
    process.exit(1);
  }
}

function hasRequiredPythonDeps() {
  try {
    execFileSync(venvPython, ['-c', 'import sqlglot; import graphify; import mcp'], {
      cwd: root,
      stdio: 'ignore',
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

if (!existsSync(venvPython)) {
  console.log('Creating local Python test environment: .venv');
  run(python, ['-m', 'venv', venvDir]);
}

if (!hasRequiredPythonDeps()) {
  if (!existsSync(requirements)) {
    console.error('Missing requirements-dev.txt');
    process.exit(1);
  }

  console.log('Installing Python test dependencies into .venv');
  run(venvPython, ['-m', 'pip', 'install', '-r', requirements]);
}

console.log(`Python test interpreter: ${venvPython} (sqlglot + graphify + mcp)`);
