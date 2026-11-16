import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { readUndefinedElfSymbols, assertLinuxSqlCipherSymbolsResolved } = createRequire(import.meta.url)('../tools/release/linux-native-symbols.cjs');

// Build a minimal ELF with dynamic symbols and its linked string table.
function buildElf(symbols) {
  const strings = Buffer.from('\0' + symbols.map(item => item.name + '\0').join(''));
  const tableOffset = 64;
  const stringsOffset = 64 + 3 * 64;
  const symbolsOffset = stringsOffset + strings.length;
  const bytes = Buffer.alloc(symbolsOffset + (symbols.length + 1) * 24);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(62, 18);
  bytes.writeBigUInt64LE(BigInt(tableOffset), 40);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(3, 60);
  bytes.writeUInt32LE(3, tableOffset + 64 + 4);
  bytes.writeBigUInt64LE(BigInt(stringsOffset), tableOffset + 64 + 24);
  bytes.writeBigUInt64LE(BigInt(strings.length), tableOffset + 64 + 32);
  const dynsym = tableOffset + 128;
  bytes.writeUInt32LE(11, dynsym + 4);
  bytes.writeBigUInt64LE(BigInt(symbolsOffset), dynsym + 24);
  bytes.writeBigUInt64LE(BigInt((symbols.length + 1) * 24), dynsym + 32);
  bytes.writeUInt32LE(1, dynsym + 40);
  bytes.writeBigUInt64LE(24n, dynsym + 56);
  strings.copy(bytes, stringsOffset);
  let nameOffset = 1;
  symbols.forEach((item, index) => {
    const at = symbolsOffset + (index + 1) * 24;
    bytes.writeUInt32LE(nameOffset, at);
    bytes.writeUInt16LE(item.defined ? 1 : 0, at + 6);
    nameOffset += Buffer.byteLength(item.name) + 1;
  });
  return bytes;
}

test('reports undefined SQLite metadata symbols but ignores symbols defined by the addon', () => {
  const bytes = buildElf([
    { name: 'sqlite3_column_table_name' }, { name: 'sqlite3_column_origin_name' },
    { name: 'sqlite3_open', defined: true }, { name: 'malloc' },
  ]);
  assert.deepEqual(readUndefinedElfSymbols(bytes), ['malloc', 'sqlite3_column_origin_name', 'sqlite3_column_table_name']);
});

test('rejects truncated, unsupported, and invalid linked ELF tables', () => {
  const good = buildElf([{ name: 'sqlite3_open', defined: true }]);
  for (const size of [0, 63, 130, good.length - 1]) assert.throws(() => readUndefinedElfSymbols(good.subarray(0, size)), /Invalid Linux/);
  const badLink = Buffer.from(good);
  badLink.writeUInt32LE(8, 64 + 128 + 40);
  assert.throws(() => readUndefinedElfSymbols(badLink), /Invalid Linux/);
  const badEndian = Buffer.from(good);
  badEndian[5] = 2;
  assert.throws(() => readUndefinedElfSymbols(badEndian), /Invalid Linux/);
});

test('release gate rejects unresolved SQLite symbols and accepts self-contained addons', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-symbols-'));
  const file = path.join(dir, 'better_sqlite3.node');
  try {
    fs.writeFileSync(file, buildElf([{ name: 'sqlite3_open', defined: true }, { name: 'malloc' }]));
    assert.doesNotThrow(() => assertLinuxSqlCipherSymbolsResolved(file));
    fs.writeFileSync(file, buildElf([{ name: 'sqlite3_column_origin_name' }]));
    assert.throws(() => assertLinuxSqlCipherSymbolsResolved(file), { code: 'RELEASE_SQLCIPHER_UNRESOLVED_SYMBOLS' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
