"use strict";

const fs = require("node:fs");

/** Read undefined dynamic symbols from the ELF64 little-endian Linux x64 assets. */
function readUndefinedElfSymbols(bytes) {
  const invalid = () => { throw new Error("Invalid Linux x64 ELF dynamic symbol table"); };
  const range = (offset, size) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > bytes.length) invalid();
  };
  range(0, 64);
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) invalid();
  const tableOffset = Number(bytes.readBigUInt64LE(40));
  const entrySize = bytes.readUInt16LE(58);
  const count = bytes.readUInt16LE(60);
  if (entrySize < 64 || count === 0) invalid();
  range(tableOffset, entrySize * count);
  const sections = Array.from({ length: count }, (_, index) => {
    const at = tableOffset + entrySize * index;
    return {
      type: bytes.readUInt32LE(at + 4),
      offset: Number(bytes.readBigUInt64LE(at + 24)),
      size: Number(bytes.readBigUInt64LE(at + 32)),
      link: bytes.readUInt32LE(at + 40),
      entrySize: Number(bytes.readBigUInt64LE(at + 56)),
    };
  });
  const symbols = sections.filter((section) => section.type === 11);
  if (!symbols.length) invalid();
  const undefinedSymbols = new Set();
  for (const section of symbols) {
    range(section.offset, section.size);
    if (section.entrySize !== 24 || section.size % section.entrySize !== 0) invalid();
    const strings = sections[section.link];
    if (!strings || strings.type !== 3) invalid();
    range(strings.offset, strings.size);
    for (let at = section.offset; at < section.offset + section.size; at += section.entrySize) {
      const nameOffset = bytes.readUInt32LE(at);
      if (nameOffset >= strings.size) invalid();
      if (bytes.readUInt16LE(at + 6) !== 0 || nameOffset === 0) continue;
      const start = strings.offset + nameOffset;
      const end = bytes.indexOf(0, start);
      if (end < start || end >= strings.offset + strings.size) invalid();
      undefinedSymbols.add(bytes.toString("utf8", start, end));
    }
  }
  return [...undefinedSymbols].sort();
}

/** A bundled SQLite addon must not resolve SQLite entrypoints from Node or system libraries. */
function assertLinuxSqlCipherSymbolsResolved(nativePath) {
  const missing = readUndefinedElfSymbols(fs.readFileSync(nativePath)).filter((name) => name.startsWith("sqlite3_"));
  if (missing.length) {
    const error = new Error(`Linux SQLCipher native contains unresolved SQLite symbols: ${missing.join(", ")}; ${nativePath}`);
    error.code = "RELEASE_SQLCIPHER_UNRESOLVED_SYMBOLS";
    throw error;
  }
}

module.exports = { readUndefinedElfSymbols, assertLinuxSqlCipherSymbolsResolved };

if (require.main === module) {
  const target = String(process.argv[2] ?? "").trim();
  if (!target) {
    console.error("Usage: node tools/release/linux-native-symbols.cjs <better_sqlite3.node>");
    process.exitCode = 2;
  } else {
    try {
      assertLinuxSqlCipherSymbolsResolved(target);
      console.log("SQLCIPHER_SYMBOLS=PASS");
    } catch (error) {
      console.error(JSON.stringify({ code: error.code ?? "RELEASE_SQLCIPHER_UNRESOLVED_SYMBOLS", message: error.message }));
      process.exitCode = 1;
    }
  }
}
