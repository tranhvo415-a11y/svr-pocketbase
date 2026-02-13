"use strict";

const fs = require("fs");

class Logger {
  constructor(options) {
    const settings = options || {};
    this.logDir = settings.logDir;
    this.logPath = settings.logPath;
    this.scopePrefix = settings.scopePrefix || "docker-manager";
    this.fileReady = false;
    this.initialize();
  }

  initialize() {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.appendFileSync(this.logPath, "");
      this.fileReady = true;
    } catch (error) {
      this.fileReady = false;
      this.writeConsole("error", this.scopePrefix, `cannot prepare log file '${this.logPath}': ${this.formatError(error)}`);
    }
  }

  info(scope, message, meta) {
    this.write("info", scope, message, meta);
  }

  warn(scope, message, meta) {
    this.write("warn", scope, message, meta);
  }

  error(scope, error, message = "", meta = null) {
    const errorMessage = this.formatError(error);
    const composed = message ? `${message}: ${errorMessage}` : errorMessage;
    this.write("error", scope, composed, meta);
  }

  request(scope, requestMeta) {
    this.write("request", scope, "incoming request", requestMeta);
  }

  write(level, scope, message, meta) {
    const finalScope = scope || this.scopePrefix;
    const line = this.serialize(level, finalScope, message, meta);
    this.writeConsole(level, finalScope, message, meta);
    this.writeFile(line);
  }

  serialize(level, scope, message, meta) {
    const payload = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg: message,
    };
    if (meta && typeof meta === "object") {
      payload.meta = meta;
    }
    return `${JSON.stringify(payload)}\n`;
  }

  writeConsole(level, scope, message, meta) {
    const ts = new Date().toISOString();
    const suffix = meta && typeof meta === "object" ? ` ${safeJson(meta)}` : "";
    const line = `[${ts}] [${level.toUpperCase()}] [${scope}] ${message}${suffix}`;
    if (level === "error") {
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  }

  writeFile(line) {
    if (!this.fileReady) {
      return;
    }
    try {
      fs.appendFileSync(this.logPath, line, "utf8");
    } catch (error) {
      this.fileReady = false;
      const fallback = `[${new Date().toISOString()}] [ERROR] [${this.scopePrefix}] cannot write log file: ${this.formatError(error)}\n`;
      process.stderr.write(fallback);
    }
  }

  formatError(error) {
    if (!error) {
      return "unknown error";
    }
    if (error instanceof Error) {
      return error.message || String(error);
    }
    return String(error);
  }
}

const safeJson = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
};

module.exports = {
  Logger,
};
