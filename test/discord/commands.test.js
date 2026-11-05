import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DSH_COMMAND_NAME,
  DSH_SUBCOMMANDS,
  buildDshCommandData,
  interactionCommandText,
  isDshSubcommand,
  registerDshCommands,
} from '../../lib/discord/commands.js';

function createTestLogger() {
  const entries = [];
  const logger = {
    debug(message, meta) {
      entries.push({ level: 'debug', message, meta });
    },
    info(message, meta) {
      entries.push({ level: 'info', message, meta });
    },
    warn(message, meta) {
      entries.push({ level: 'warn', message, meta });
    },
    error(message, error, meta) {
      entries.push({ level: 'error', message, error, meta });
    },
  };
  return { logger, entries };
}

test('buildDshCommandData exposes /dsh with new, status and help', () => {
  const data = buildDshCommandData();
  assert.equal(data.name, DSH_COMMAND_NAME);
  assert.equal(data.name, 'dsh');
  assert.ok(data.description.length > 0);
  const subcommands = data.options.map((option) => option.name);
  assert.deepEqual(subcommands, [...DSH_SUBCOMMANDS]);
  assert.ok(data.options.every((option) => option.type === 1));
});

test('isDshSubcommand accepts only known subcommands', () => {
  for (const name of DSH_SUBCOMMANDS) {
    assert.equal(isDshSubcommand(name), true);
  }
  for (const name of ['', 'reset', 'STATUS', null, undefined]) {
    assert.equal(isDshSubcommand(name), false);
  }
});

test('interactionCommandText maps /dsh subcommands to text commands', () => {
  assert.equal(interactionCommandText('!', 'dsh', 'new'), '!new');
  assert.equal(interactionCommandText('!', 'dsh', 'status'), '!status');
  assert.equal(interactionCommandText('?', 'dsh', 'help'), '?help');
  assert.equal(interactionCommandText('!', 'other', 'help'), null);
  assert.equal(interactionCommandText('!', 'dsh', 'reset'), null);
  assert.equal(interactionCommandText('!', 'dsh', null), null);
  assert.equal(interactionCommandText('!', 'dsh', undefined), null);
});

test('registerDshCommands registers the payload', async () => {
  const calls = [];
  const registrar = {
    async set(commands) {
      calls.push(commands);
      return new Map();
    },
  };
  const { logger, entries } = createTestLogger();
  const ok = await registerDshCommands(registrar, logger, '111');
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].name, 'dsh');
  assert.ok(entries.some((entry) => entry.level === 'info' && entry.message.includes('注册')));
});

test('registerDshCommands tolerates a missing registrar', async () => {
  const { logger, entries } = createTestLogger();
  const ok = await registerDshCommands(undefined, logger, null);
  assert.equal(ok, false);
  assert.ok(entries.some((entry) => entry.level === 'warn'));
});

test('registerDshCommands tolerates registration failures', async () => {
  const registrar = {
    async set() {
      throw new Error('Missing Access');
    },
  };
  const { logger, entries } = createTestLogger();
  const ok = await registerDshCommands(registrar, logger, '111');
  assert.equal(ok, false);
  assert.ok(entries.some((entry) => entry.level === 'warn' && entry.message.includes('失败')));
});
