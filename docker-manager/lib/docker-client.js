"use strict";

const { normalizeValue, isContainerNameValid } = require("./config");
const { runCommand } = require("./command-runner");

const LOG_TYPES = {
  access: "/var/log/nginx/app.access.log",
  error: "/var/log/nginx/app.error.log",
  shadow: "/var/log/nginx/shadow.mirror.log",
};

const parsePositiveInt = (value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const normalized = normalizeValue(value);
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < min) {
    return min;
  }
  if (parsed > max) {
    return max;
  }
  return parsed;
};

class DockerClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.containerResolveCache = new Map();
    this.containerResolveTtlMs = 10000;
  }

  async runDocker(args, options = {}) {
    const result = await runCommand(this.config.dockerBin, args, {
      timeoutMs: options.timeoutMs || this.config.commandTimeoutMs,
      input: options.input || "",
      env: options.env || process.env,
    });
    if (!options.allowFailure && result.code !== 0) {
      const detail = normalizeValue(result.stderr) || normalizeValue(result.stdout) || `exit ${result.code}`;
      const error = new Error(`docker command failed: ${detail}`);
      error.result = result;
      throw error;
    }
    return result;
  }

  assertContainerName(containerName) {
    if (!isContainerNameValid(containerName)) {
      throw new Error(`invalid container name: ${containerName}`);
    }
  }

  readFirstLine(text) {
    const lines = String(text || "")
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return "";
    }
    return lines[0];
  }

  readResolveCache(containerName) {
    const key = normalizeValue(containerName);
    const cached = this.containerResolveCache.get(key);
    if (!cached) {
      return "";
    }
    if (cached.expiresAt <= Date.now()) {
      this.containerResolveCache.delete(key);
      return "";
    }
    return cached.value;
  }

  writeResolveCache(containerName, resolvedName) {
    const key = normalizeValue(containerName);
    const value = normalizeValue(resolvedName);
    if (!key || !value) {
      return;
    }
    this.containerResolveCache.set(key, {
      value,
      expiresAt: Date.now() + this.containerResolveTtlMs,
    });
  }

  async findContainerByComposeService(serviceName) {
    const service = normalizeValue(serviceName);
    if (!service) {
      return "";
    }
    const args = ["--filter", `label=com.docker.compose.service=${service}`, "--format", "{{.Names}}"];
    const running = await this.runDocker(["ps", ...args], { allowFailure: true, timeoutMs: 5000 });
    const runningName = this.readFirstLine(running.stdout);
    if (runningName) {
      return runningName;
    }

    const anyState = await this.runDocker(["ps", "-a", ...args], { allowFailure: true, timeoutMs: 5000 });
    return this.readFirstLine(anyState.stdout);
  }

  async resolveContainerTarget(containerName) {
    this.assertContainerName(containerName);
    const directName = normalizeValue(containerName);

    const cached = this.readResolveCache(directName);
    if (cached) {
      return cached;
    }

    const directInspect = await this.runDocker(["container", "inspect", directName], {
      allowFailure: true,
      timeoutMs: 5000,
    });
    if (directInspect.code === 0) {
      this.writeResolveCache(directName, directName);
      return directName;
    }

    const composeResolved = await this.findContainerByComposeService(directName);
    if (composeResolved) {
      this.writeResolveCache(directName, composeResolved);
      this.writeResolveCache(composeResolved, composeResolved);
      if (this.logger && typeof this.logger.info === "function") {
        this.logger.info("docker-client", `resolved compose service '${directName}' to container '${composeResolved}'`);
      }
      return composeResolved;
    }

    throw new Error(
      `container not found: ${directName}. Hint: set DOCKER_MANAGER_TAILSCALE_CONTAINER/DOCKER_MANAGER_NGINX_CONTAINER to actual container name if needed`,
    );
  }

  async execInContainer(containerName, commandArgs, options = {}) {
    const resolved = await this.resolveContainerTarget(containerName);
    return this.runDocker(["exec", resolved, ...commandArgs], options);
  }

  async tailscaleStatus({ asJson = false } = {}) {
    if (asJson) {
      return this.execInContainer(this.config.tailscaleContainer, ["tailscale", "status", "--json"]);
    }
    return this.execInContainer(this.config.tailscaleContainer, ["tailscale", "status"]);
  }

  async tailscalePing(target, count) {
    const normalizedTarget = normalizeValue(target);
    if (!normalizedTarget) {
      throw new Error("tailscale ping requires target");
    }
    const pingCount = parsePositiveInt(count, 3, { min: 1, max: 10 });
    return this.execInContainer(this.config.tailscaleContainer, ["tailscale", "ping", "-c", String(pingCount), normalizedTarget]);
  }

  async tailscaleIp() {
    return this.execInContainer(this.config.tailscaleContainer, ["tailscale", "ip", "-4"]);
  }

  async nginxTest() {
    return this.execInContainer(this.config.nginxContainer, ["nginx", "-t"]);
  }

  async nginxReload() {
    await this.nginxTest();
    return this.execInContainer(this.config.nginxContainer, ["nginx", "-s", "reload"]);
  }

  async nginxVersion() {
    return this.execInContainer(this.config.nginxContainer, ["nginx", "-v"]);
  }

  async nginxLogs(logType, tailLines) {
    const normalizedType = normalizeValue(logType).toLowerCase();
    const logFile = LOG_TYPES[normalizedType];
    if (!logFile) {
      throw new Error(`unsupported nginx log type: ${logType}`);
    }
    const tail = parsePositiveInt(tailLines, this.config.defaultLogTail, { min: 1, max: this.config.maxLogLines });
    return this.execInContainer(this.config.nginxContainer, ["tail", "-n", String(tail), logFile], {
      allowFailure: true,
    });
  }

  async systemCommand(name) {
    switch (name) {
      case "ps":
        return this.runDocker(["ps", "-a"]);
      case "images":
        return this.runDocker(["images"]);
      case "networks":
        return this.runDocker(["network", "ls"]);
      case "volumes":
        return this.runDocker(["volume", "ls"]);
      case "info":
        return this.runDocker(["info"]);
      case "version":
        return this.runDocker(["version"]);
      default:
        throw new Error(`unsupported system command: ${name}`);
    }
  }

  async systemPrune(scope) {
    const normalized = normalizeValue(scope).toLowerCase();
    if (!normalized || normalized === "all") {
      return this.runDocker(["system", "prune", "-f"]);
    }
    if (normalized === "containers") {
      return this.runDocker(["container", "prune", "-f"]);
    }
    if (normalized === "images") {
      return this.runDocker(["image", "prune", "-af"]);
    }
    if (normalized === "networks") {
      return this.runDocker(["network", "prune", "-f"]);
    }
    if (normalized === "volumes") {
      return this.runDocker(["volume", "prune", "-f"]);
    }
    if (normalized === "builder") {
      return this.runDocker(["builder", "prune", "-af"]);
    }
    throw new Error(`unsupported prune scope: ${scope}`);
  }

  async systemRaw(args) {
    if (!Array.isArray(args) || args.length === 0) {
      throw new Error("system raw command requires non-empty args");
    }
    return this.runDocker(args);
  }

  async containerStatus(containerName) {
    const resolved = await this.resolveContainerTarget(containerName);
    return this.runDocker(["ps", "-a", "--filter", `name=^/${resolved}$`]);
  }

  async containerLogs(containerName, options = {}) {
    const resolved = await this.resolveContainerTarget(containerName);
    const args = ["logs"];
    const tail = parsePositiveInt(options.tail, this.config.defaultLogTail, { min: 1, max: this.config.maxLogLines });
    args.push("--tail", String(tail));
    if (normalizeValue(options.since)) {
      args.push("--since", normalizeValue(options.since));
    }
    if (normalizeValue(options.timestamps) === "1") {
      args.push("--timestamps");
    }
    args.push(resolved);
    return this.runDocker(args, { allowFailure: true });
  }

  async containerInspect(containerName) {
    const resolved = await this.resolveContainerTarget(containerName);
    return this.runDocker(["inspect", resolved]);
  }

  async containerTop(containerName) {
    const resolved = await this.resolveContainerTarget(containerName);
    return this.runDocker(["top", resolved], { allowFailure: true });
  }

  async containerStats(containerName) {
    const resolved = await this.resolveContainerTarget(containerName);
    return this.runDocker(["stats", "--no-stream", resolved], { allowFailure: true });
  }

  async containerMutate(containerName, commandName) {
    const resolved = await this.resolveContainerTarget(containerName);
    switch (commandName) {
      case "start":
        return this.runDocker(["start", resolved], { allowFailure: true });
      case "stop":
        return this.runDocker(["stop", resolved], { allowFailure: true });
      case "restart":
        return this.runDocker(["restart", resolved], { allowFailure: true });
      case "pause":
        return this.runDocker(["pause", resolved], { allowFailure: true });
      case "unpause":
        return this.runDocker(["unpause", resolved], { allowFailure: true });
      case "kill":
        return this.runDocker(["kill", resolved], { allowFailure: true });
      case "rm":
        return this.runDocker(["rm", "-f", resolved], { allowFailure: true });
      default:
        throw new Error(`unsupported container command: ${commandName}`);
    }
  }

  async containerRename(containerName, toName) {
    const resolved = await this.resolveContainerTarget(containerName);
    this.assertContainerName(toName);
    return this.runDocker(["rename", resolved, toName], { allowFailure: true });
  }

  async containerUpdate(containerName, updateArgs) {
    const resolved = await this.resolveContainerTarget(containerName);
    if (!Array.isArray(updateArgs) || updateArgs.length === 0) {
      throw new Error("container update requires args");
    }
    return this.runDocker(["update", ...updateArgs, resolved], { allowFailure: true });
  }

  async containerExec(containerName, shellName, commandText) {
    const resolved = await this.resolveContainerTarget(containerName);
    const shell = normalizeValue(shellName) || this.config.execShell;
    const safeShell = ["sh", "bash", "zsh", "ash"].includes(shell) ? shell : "sh";
    const command = normalizeValue(commandText);
    if (!command) {
      throw new Error("container exec requires command");
    }
    return this.runDocker(["exec", resolved, safeShell, "-lc", command], { allowFailure: true });
  }

  async containerRaw(containerName, args) {
    const resolved = await this.resolveContainerTarget(containerName);
    if (!Array.isArray(args) || args.length === 0) {
      throw new Error("container raw command requires args");
    }
    return this.runDocker([...args, resolved], { allowFailure: true });
  }
}

module.exports = {
  DockerClient,
  parsePositiveInt,
};
