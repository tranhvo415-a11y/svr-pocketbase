"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

module.exports = (() => {
  const normalizeValue = (value) => {
    let normalized = String(value ?? "").replace(/\r/g, "").trim();
    if (normalized.startsWith("#")) {
      return "";
    }
    const inlineCommentIndex = normalized.indexOf(" #");
    if (inlineCommentIndex >= 0) {
      normalized = normalized.slice(0, inlineCommentIndex).trim();
    }
    return normalized;
  };

  const readEnv = (key, fallback = "") => {
    const normalized = normalizeValue(process.env[key]);
    if (normalized === "") {
      return normalizeValue(fallback);
    }
    return normalized;
  };

  const readIntEnv = (key, fallback) => {
    const raw = readEnv(key, String(fallback));
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return value;
  };

  const logInfo = (scope, message) => {
    console.log(`[${scope}] ${message}`);
  };

  const logError = (scope, error, message = "") => {
    const prefix = message ? `${message}: ` : "";
    const detail = error && error.message ? error.message : String(error);
    console.error(`[${scope}] ${prefix}${detail}`);
  };

  const runCommand = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: options.stdio || "pipe",
      shell: false,
    });
    if (result.error) {
      throw result.error;
    }
    if (options.allowFailure !== true && result.status !== 0) {
      const stderr = String(result.stderr || "").trim();
      throw new Error(`${command} ${args.join(" ")} failed: ${stderr || `exit ${result.status}`}`);
    }
    return result;
  };

  const isLinux = () => process.platform === "linux";

  const canResolveHost = (host) => {
    if (!host) {
      return true;
    }
    const command = process.platform === "linux" ? "getent" : "nslookup";
    const args = process.platform === "linux" ? ["ahosts", host] : [host];
    const result = runCommand(command, args, { allowFailure: true });
    return result.status === 0;
  };

  const buildResolvConf = ({ primaryDns, fallbackDns, searchDomain }) => {
    const lines = [];
    if (searchDomain) {
      lines.push(`search ${searchDomain}`);
    }
    lines.push(`nameserver ${primaryDns}`);
    if (fallbackDns && fallbackDns !== primaryDns) {
      lines.push(`nameserver ${fallbackDns}`);
    }
    lines.push("options timeout:2 attempts:2");
    lines.push("");
    return lines.join("\n");
  };

  const writeResolvConf = (content) => {
    const targetPath = "/etc/resolv.conf";
    try {
      fs.writeFileSync(targetPath, content, "utf8");
      return "direct";
    } catch (error) {
      if (!isLinux()) {
        throw error;
      }
    }

    const tempPath = path.join(os.tmpdir(), `runner-template-resolv-${process.pid}.conf`);
    fs.writeFileSync(tempPath, content, "utf8");
    try {
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        fs.copyFileSync(tempPath, targetPath);
        return "copy-as-root";
      }
      runCommand("sudo", ["cp", tempPath, targetPath], { stdio: "inherit" });
      return "sudo-copy";
    } finally {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  };

  const updateEnvFileValue = (filePath, key, value) => {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    let stats = null;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return false;
    }
    if (!stats.isFile()) {
      return false;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    const prefix = `${key}=`;
    let replaced = false;

    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith(prefix)) {
        lines[i] = `${key}=${value}`;
        replaced = true;
      }
    }

    if (!replaced) {
      lines.push(`${key}=${value}`);
    }

    let output = lines.join("\n");
    if (!output.endsWith("\n")) {
      output += "\n";
    }
    fs.writeFileSync(filePath, output, "utf8");
    return true;
  };

  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const request = (url, timeoutMs) =>
    new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body,
          });
        });
      });
      req.on("timeout", () => {
        req.destroy(new Error(`timeout after ${timeoutMs}ms`));
      });
      req.on("error", (error) => {
        reject(error);
      });
    });

  const readFileIfExists = (filePath) => {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8");
  };

  return {
    normalizeValue,
    readEnv,
    readIntEnv,
    logInfo,
    logError,
    runCommand,
    isLinux,
    canResolveHost,
    buildResolvConf,
    writeResolvConf,
    updateEnvFileValue,
    sleep,
    request,
    readFileIfExists,
  };
})();
