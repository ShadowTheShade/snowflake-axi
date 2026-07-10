#!/usr/bin/env node
// The session-hook payload binary: axi-sdk-js session hooks spawn one
// argument-less executable, so `snowflake-axi context` gets this alias.
import { main } from "../index.js";

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

await main(["context"]);
