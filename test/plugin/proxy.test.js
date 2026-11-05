import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverUndiciCopies, hostnameOf, isDiscordHost } from '../../lib/proxy.js';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('hostnameOf understands strings and URL-like objects', () => {
  assert.equal(hostnameOf('https://discord.com/api/v10/gateway'), 'discord.com');
  assert.equal(hostnameOf({ hostname: 'gateway.discord.gg' }), 'gateway.discord.gg');
  assert.equal(hostnameOf(undefined), '');
  assert.equal(hostnameOf('not a url'), '');
});

test('isDiscordHost matches Discord domains only', () => {
  assert.equal(isDiscordHost('discord.com'), true);
  assert.equal(isDiscordHost('gateway.discord.gg'), true);
  assert.equal(isDiscordHost('cdn.discordapp.com'), true);
  assert.equal(isDiscordHost('discord.gg'), true);
  assert.equal(isDiscordHost('deepseek.com'), false);
  assert.equal(isDiscordHost('notdiscord.com'), false);
  assert.equal(isDiscordHost(''), false);
});

test('discoverUndiciCopies finds the plugin-local undici install', async () => {
  const copies = await discoverUndiciCopies(PLUGIN_DIR);
  assert.ok(copies.length >= 1, 'expected at least one undici copy, got none');
  for (const copy of copies) {
    assert.ok(copy.endsWith('undici' + '\\' + 'index.js') || copy.endsWith('undici/index.js'), copy);
  }
});
