"use strict";

const path = require("path");

const SAFE_COMMAND_KEYS = [
  "healthz",
  "help",
  "tailscale.status",
  "tailscale.ping",
  "tailscale.ip",
  "nginx.test",
  "nginx.version",
  "nginx.logs.access",
  "nginx.logs.error",
  "nginx.logs.shadow",
  "system.ps",
  "system.images",
  "system.networks",
  "system.volumes",
  "system.info",
  "system.version",
  "container.status",
  "container.logs",
  "container.inspect",
  "container.top",
  "container.stats",
  "container.start",
  "container.stop",
  "container.restart",
  "container.pause",
  "container.unpause",
];

const DANGEROUS_COMMAND_KEYS = [
  "nginx.reload",
  "system.prune",
  "system.raw",
  "container.kill",
  "container.rm",
  "container.exec",
  "container.rename",
  "container.update",
  "container.raw",
];

const ALL_COMMAND_KEYS = [...SAFE_COMMAND_KEYS, ...DANGEROUS_COMMAND_KEYS];
const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const normalizeValue = (value) => String(value ?? "").trim();

const readEnv = (key, fallback = "") => {
  const value = normalizeValue(process.env[key]);
  if (!value) {
    return normalizeValue(fallback);
  }
  return value;
};

const readBoolEnv = (key, fallback) => {
  const fallbackValue = fallback ? "1" : "0";
  const value = readEnv(key, fallbackValue).toLowerCase();
  if (["1", "true", "yes", "on", "y"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off", "n"].includes(value)) {
    return false;
  }
  return fallback;
};

const readIntEnv = (key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const value = Number.parseInt(readEnv(key, String(fallback)), 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  if (value < min || value > max) {
    return fallback;
  }
  return value;
};

const parseCsvSet = (value) => {
  const raw = normalizeValue(value);
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(/[,\n\r]/g)
      .map((item) => item.trim())
      .filter(Boolean),
  );
};

const parseCommandPolicy = (value, defaults) => {
  const normalized = normalizeValue(value);
  if (!normalized || normalized === "*") {
    return {
      allowAll: true,
      set: new Set(defaults),
    };
  }
  return {
    allowAll: false,
    set: parseCsvSet(normalized),
  };
};

const createConfig = () => {
  const config = {
    host: readEnv("DOCKER_MANAGER_HOST", "0.0.0.0"),
    port: readIntEnv("DOCKER_MANAGER_PORT", 18080, { min: 1, max: 65535 }),
    dockerBin: readEnv("DOCKER_MANAGER_DOCKER_BIN", "docker"),
    requestBodyLimitBytes: readIntEnv("DOCKER_MANAGER_MAX_BODY_BYTES", 65536, { min: 1024, max: 1048576 }),
    commandTimeoutMs: readIntEnv("DOCKER_MANAGER_COMMAND_TIMEOUT_MS", 120000, { min: 500, max: 900000 }),
    maxLogLines: readIntEnv("DOCKER_MANAGER_MAX_LOG_LINES", 2000, { min: 10, max: 20000 }),
    defaultLogTail: readIntEnv("DOCKER_MANAGER_DEFAULT_LOG_TAIL", 200, { min: 1, max: 20000 }),
    logDir: readEnv("DOCKER_MANAGER_LOG_DIR", "/opt/docker-manager/runtime"),
    logFile: readEnv("DOCKER_MANAGER_LOG_FILE", "docker-manager.log"),
    tailscaleSyncEnabled: readBoolEnv("DOCKER_MANAGER_TAILSCALE_SYNC_ENABLED", true),
    tailscaleSyncIntervalSec: readIntEnv("DOCKER_MANAGER_TAILSCALE_SYNC_INTERVAL_SEC", 30, { min: 5, max: 86400 }),
    tailscaleContainer: readEnv("DOCKER_MANAGER_TAILSCALE_CONTAINER", "tailscale"),
    nginxContainer: readEnv("DOCKER_MANAGER_NGINX_CONTAINER", "nginx"),
    shadowDir: readEnv("DOCKER_MANAGER_SHADOW_DIR", "/opt/nginx/shadow-servers"),
    shadowPort: readIntEnv("DOCKER_MANAGER_SHADOW_PORT", 3000, { min: 1, max: 65535 }),
    enableSafeCommands: readBoolEnv("DOCKER_MANAGER_ENABLE_SAFE_COMMANDS", true),
    enableDangerousCommands: readBoolEnv("DOCKER_MANAGER_ENABLE_DANGEROUS_COMMANDS", true),
    safeCommandsPolicy: parseCommandPolicy(readEnv("DOCKER_MANAGER_ALLOWED_SAFE_COMMANDS", "*"), SAFE_COMMAND_KEYS),
    dangerousCommandsPolicy: parseCommandPolicy(readEnv("DOCKER_MANAGER_ALLOWED_DANGEROUS_COMMANDS", "*"), DANGEROUS_COMMAND_KEYS),
    blockedCommands: parseCsvSet(readEnv("DOCKER_MANAGER_BLOCKED_COMMANDS", "")),
    execShell: readEnv("DOCKER_MANAGER_EXEC_SHELL", "sh"),
  };

  config.logPath = path.join(config.logDir, config.logFile);
  return config;
};

const isContainerNameValid = (containerName) => CONTAINER_NAME_PATTERN.test(normalizeValue(containerName));

module.exports = {
  ALL_COMMAND_KEYS,
  SAFE_COMMAND_KEYS,
  DANGEROUS_COMMAND_KEYS,
  createConfig,
  normalizeValue,
  parseCsvSet,
  isContainerNameValid,
};
