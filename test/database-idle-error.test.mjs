import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import pg from "pg";
import { openDatabase } from "../src/database.mjs";

test("an idle PostgreSQL disconnect is logged without terminating the controller or exposing credentials", async () => {
  const originalPool = pg.Pool, originalError = console.error, logs = [];
  class PoolFixture extends EventEmitter {
    async query() { return { rows: [], rowCount: 1 }; }
    async end() {}
  }
  pg.Pool = PoolFixture;
  console.error = message => logs.push(message);
  try {
    const records = await openDatabase({ mode: "remote", url: "postgresql://relay:private-password@127.0.0.1/relay",
      tls: false, encryptionKey: Buffer.alloc(32, 7).toString("base64") });
    records.pool.emit("error", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }));
    assert.deepEqual(logs, ["PostgreSQL idle connection closed (57P01); waiting for the pool to reconnect."]);
    assert.equal(logs.join(" ").includes("private-password"), false);
    await records.close();
  } finally {
    pg.Pool = originalPool;
    console.error = originalError;
  }
});
