"use strict";

const { spawn } = require("child_process");

const buildCommandText = (command, args) => [command, ...(Array.isArray(args) ? args : [])].join(" ").trim();

const runCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, Array.isArray(args) ? args : [], {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: false,
      stdio: "pipe",
    });

    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0;
    const commandText = buildCommandText(command, args);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandle = null;

    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve({
        command: commandText,
        stdout,
        stderr,
        ...payload,
      });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      reject(error);
    });

    child.on("close", (code, signal) => {
      finish({
        code: Number.isFinite(code) ? code : 1,
        signal: signal || null,
        ok: code === 0,
      });
    });

    if (typeof options.input === "string" && options.input.length > 0) {
      child.stdin.write(options.input);
    }
    child.stdin.end();

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`command timeout after ${timeoutMs}ms: ${commandText}`));
      }, timeoutMs);
    }
  });

module.exports = {
  runCommand,
  buildCommandText,
};
