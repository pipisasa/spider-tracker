#!/usr/bin/env bun
import { run } from "./cli";

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
