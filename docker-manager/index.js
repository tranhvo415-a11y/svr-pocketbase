#!/usr/bin/env node
"use strict";

const http = require("http");
const { URL } = require("url");

const { createConfig, normalizeValue, SAFE_COMMAND_KEYS, DANGEROUS_COMMAND_KEYS } = require("./lib/config");
const { Logger } = require("./lib/logger");
const { DockerClient, parsePositiveInt } = require("./lib/docker-client");
const { runTailscaleShadowSync } = require("./lib/tailscale-shadow-sync");

const config = createConfig();
const logger = new Logger({
  logDir: config.logDir,
  logPath: config.logPath,
  scopePrefix: "docker-manager",
});
const dockerClient = new DockerClient(config, logger);

const runtimeState = {
  startedAt: new Date().toISOString(),
  requestCount: 0,
  sync: {
    enabled: config.tailscaleSyncEnabled,
    inProgress: false,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: "",
    lastResult: null,
    totalRuns: 0,
    totalFailures: 0,
  },
};

const COMMAND_SPECS = [
  ...SAFE_COMMAND_KEYS.map((key) => ({ key, category: "safe" })),
  ...DANGEROUS_COMMAND_KEYS.map((key) => ({ key, category: "dangerous" })),
];

const COMMAND_MAP = new Map(COMMAND_SPECS.map((item) => [item.key, item]));

const isCommandAllowed = (commandKey) => {
  const spec = COMMAND_MAP.get(commandKey);
  if (!spec) {
    return false;
  }
  if (config.blockedCommands.has(commandKey)) {
    return false;
  }
  if (spec.category === "safe") {
    if (!config.enableSafeCommands) {
      return false;
    }
    return config.safeCommandsPolicy.allowAll || config.safeCommandsPolicy.set.has(commandKey);
  }
  if (spec.category === "dangerous") {
    if (!config.enableDangerousCommands) {
      return false;
    }
    return config.dangerousCommandsPolicy.allowAll || config.dangerousCommandsPolicy.set.has(commandKey);
  }
  return false;
};

const respondText = (res, statusCode, body, headers = {}) => {
  const text = typeof body === "string" ? body : String(body ?? "");
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text.endsWith("\n") ? text : `${text}\n`);
};

const respondJson = (res, statusCode, payload) => {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${body}\n`);
};

const formatCommandResult = (result) => {
  if (!result || typeof result !== "object") {
    return "no command result";
  }
  const lines = [];
  if (result.command) {
    lines.push(`$ ${result.command}`);
  }
  if (typeof result.code === "number") {
    lines.push(`exit=${result.code}`);
  }
  const stdout = String(result.stdout || "").trimEnd();
  const stderr = String(result.stderr || "").trimEnd();
  if (stdout) {
    lines.push("--- stdout ---");
    lines.push(stdout);
  }
  if (stderr) {
    lines.push("--- stderr ---");
    lines.push(stderr);
  }
  if (lines.length === 0) {
    return "empty result";
  }
  return lines.join("\n");
};

const parseRequestBody = async (req, limitBytes) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error(`request body too large (>${limitBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let json = null;
      if (normalizeValue(text)) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      resolve({ text, json });
    });
    req.on("error", (error) => {
      reject(error);
    });
  });

const parseShellWords = (text) => {
  const source = normalizeValue(text);
  if (!source) {
    return [];
  }
  const result = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) {
        quote = "";
        continue;
      }
      if (ch === "\\" && i + 1 < source.length) {
        i += 1;
        current += source[i];
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    if (ch === "\\" && i + 1 < source.length) {
      i += 1;
      current += source[i];
      continue;
    }
    current += ch;
  }
  if (current) {
    result.push(current);
  }
  return result;
};

const collectArgs = (urlObj, body) => {
  const args = [];
  for (const arg of urlObj.searchParams.getAll("arg")) {
    const value = normalizeValue(arg);
    if (value) {
      args.push(value);
    }
  }
  const argsCsv = normalizeValue(urlObj.searchParams.get("args"));
  if (argsCsv) {
    if (argsCsv.includes(",")) {
      for (const token of argsCsv.split(",")) {
        const value = normalizeValue(token);
        if (value) {
          args.push(value);
        }
      }
    } else {
      args.push(...parseShellWords(argsCsv));
    }
  }
  if (body && body.json && Array.isArray(body.json.args)) {
    for (const item of body.json.args) {
      const value = normalizeValue(item);
      if (value) {
        args.push(value);
      }
    }
  }
  if (args.length === 0 && body && body.text) {
    args.push(...parseShellWords(body.text));
  }
  return args;
};

const collectCommandText = (urlObj, body) => {
  const fromQuery = normalizeValue(urlObj.searchParams.get("cmd") || urlObj.searchParams.get("command"));
  if (fromQuery) {
    return fromQuery;
  }
  if (body && body.json && typeof body.json.cmd === "string") {
    return normalizeValue(body.json.cmd);
  }
  if (body && body.json && typeof body.json.command === "string") {
    return normalizeValue(body.json.command);
  }
  if (body && typeof body.text === "string") {
    return normalizeValue(body.text);
  }
  return "";
};

const ensureMethod = (req, res, methods) => {
  const allow = Array.isArray(methods) ? methods : [methods];
  if (!allow.includes(req.method)) {
    respondText(res, 405, `method not allowed: ${req.method}\nallowed: ${allow.join(", ")}`);
    return false;
  }
  return true;
};

const requirePermission = (res, commandKey) => {
  if (isCommandAllowed(commandKey)) {
    return true;
  }
  respondText(res, 403, `command is blocked by policy: ${commandKey}`);
  return false;
};

const sendCommandResult = (res, result) => {
  if (result && typeof result.code === "number" && result.code !== 0) {
    respondText(res, 500, formatCommandResult(result));
    return;
  }
  respondText(res, 200, formatCommandResult(result));
};

const handleCommandError = (res, scope, error) => {
  if (error && error.result) {
    logger.error(scope, error, "command failed", {
      command: error.result.command || "",
      code: error.result.code,
    });
    sendCommandResult(res, error.result);
    return;
  }
  logger.error(scope, error, "unexpected handler error");
  respondText(res, 500, `error: ${error && error.message ? error.message : String(error)}`);
};

const buildHelpText = () => {
  const safeRows = SAFE_COMMAND_KEYS.map((key) => `${isCommandAllowed(key) ? "[x]" : "[ ]"} ${key}`);
  const dangerousRows = DANGEROUS_COMMAND_KEYS.map((key) => `${isCommandAllowed(key) ? "[x]" : "[ ]"} ${key}`);
  const lines = [
    "docker-manager command groups",
    "",
    "safe commands:",
    ...safeRows,
    "",
    "dangerous commands:",
    ...dangerousRows,
    "",
    "policy env:",
    `DOCKER_MANAGER_ENABLE_SAFE_COMMANDS=${config.enableSafeCommands ? "1" : "0"}`,
    `DOCKER_MANAGER_ENABLE_DANGEROUS_COMMANDS=${config.enableDangerousCommands ? "1" : "0"}`,
    `DOCKER_MANAGER_ALLOWED_SAFE_COMMANDS=${config.safeCommandsPolicy.allowAll ? "*" : Array.from(config.safeCommandsPolicy.set).join(",")}`,
    `DOCKER_MANAGER_ALLOWED_DANGEROUS_COMMANDS=${config.dangerousCommandsPolicy.allowAll ? "*" : Array.from(config.dangerousCommandsPolicy.set).join(",")}`,
    `DOCKER_MANAGER_BLOCKED_COMMANDS=${Array.from(config.blockedCommands).join(",")}`,
    "",
    "sample endpoints:",
    "GET  /dockerapi/healthz",
    "GET  /dockerapi/help",
    "GET  /dockerapi/tailscale/status",
    "GET  /dockerapi/tailscale/status?format=json",
    "POST /dockerapi/tailscale/ping?target=100.x.x.x",
    "GET  /dockerapi/nginx/test",
    "POST /dockerapi/nginx/reload",
    "GET  /dockerapi/nginx/version",
    "GET  /dockerapi/nginx/logs/access?tail=200",
    "GET  /dockerapi/system/ps",
    "POST /dockerapi/system/prune?scope=all",
    "GET  /dockerapi/{container}/status",
    "GET  /dockerapi/{container}/logs?tail=200",
    "POST /dockerapi/{container}/restart",
    "POST /dockerapi/{container}/exec?cmd=ls%20-la",
  ];
  return lines.join("\n");
};

const runScheduledSync = async (source) => {
  if (!config.tailscaleSyncEnabled) {
    return;
  }
  if (runtimeState.sync.inProgress) {
    logger.warn("tailscale-sync", "skip sync cycle because previous cycle is still running", { source });
    return;
  }

  runtimeState.sync.inProgress = true;
  runtimeState.sync.lastRunAt = new Date().toISOString();
  runtimeState.sync.totalRuns += 1;
  try {
    const result = await runTailscaleShadowSync({
      dockerClient,
      config,
      logger,
    });
    runtimeState.sync.lastResult = result;
    runtimeState.sync.lastSuccessAt = new Date().toISOString();
    runtimeState.sync.lastError = "";
  } catch (error) {
    runtimeState.sync.totalFailures += 1;
    runtimeState.sync.lastError = error && error.message ? error.message : String(error);
    logger.error("tailscale-sync", error, "periodic sync failed", { source });
  } finally {
    runtimeState.sync.inProgress = false;
  }
};

const handleSystemRoute = async (req, res, urlObj, commandName) => {
  const safeMap = {
    ps: { key: "system.ps", fn: () => dockerClient.systemCommand("ps") },
    containers: { key: "system.ps", fn: () => dockerClient.systemCommand("ps") },
    images: { key: "system.images", fn: () => dockerClient.systemCommand("images") },
    networks: { key: "system.networks", fn: () => dockerClient.systemCommand("networks") },
    volumes: { key: "system.volumes", fn: () => dockerClient.systemCommand("volumes") },
    info: { key: "system.info", fn: () => dockerClient.systemCommand("info") },
    version: { key: "system.version", fn: () => dockerClient.systemCommand("version") },
  };
  const dangerousMap = {
    prune: {
      key: "system.prune",
      fn: () => dockerClient.systemPrune(urlObj.searchParams.get("scope")),
    },
    raw: {
      key: "system.raw",
      fn: async () => {
        const body = await parseRequestBody(req, config.requestBodyLimitBytes);
        const args = collectArgs(urlObj, body);
        return dockerClient.systemRaw(args);
      },
    },
  };

  if (safeMap[commandName]) {
    if (!ensureMethod(req, res, ["GET"])) {
      return;
    }
    const command = safeMap[commandName];
    if (!requirePermission(res, command.key)) {
      return;
    }
    const result = await command.fn();
    sendCommandResult(res, result);
    return;
  }

  if (dangerousMap[commandName]) {
    if (!ensureMethod(req, res, ["POST"])) {
      return;
    }
    const command = dangerousMap[commandName];
    if (!requirePermission(res, command.key)) {
      return;
    }
    const result = await command.fn();
    sendCommandResult(res, result);
    return;
  }

  respondText(res, 404, `unsupported system command: ${commandName}`);
};

const handleContainerRoute = async (req, res, urlObj, containerName, actionName) => {
  const safeReadonlyActions = {
    status: {
      key: "container.status",
      fn: () => dockerClient.containerStatus(containerName),
      methods: ["GET"],
    },
    logs: {
      key: "container.logs",
      fn: () =>
        dockerClient.containerLogs(containerName, {
          tail: urlObj.searchParams.get("tail"),
          since: urlObj.searchParams.get("since"),
          timestamps: urlObj.searchParams.get("timestamps"),
        }),
      methods: ["GET"],
    },
    inspect: {
      key: "container.inspect",
      fn: () => dockerClient.containerInspect(containerName),
      methods: ["GET"],
    },
    top: {
      key: "container.top",
      fn: () => dockerClient.containerTop(containerName),
      methods: ["GET"],
    },
    stats: {
      key: "container.stats",
      fn: () => dockerClient.containerStats(containerName),
      methods: ["GET"],
    },
  };

  const safeMutateActions = {
    start: { key: "container.start", command: "start", methods: ["POST"] },
    stop: { key: "container.stop", command: "stop", methods: ["POST"] },
    restart: { key: "container.restart", command: "restart", methods: ["POST"] },
    pause: { key: "container.pause", command: "pause", methods: ["POST"] },
    unpause: { key: "container.unpause", command: "unpause", methods: ["POST"] },
  };

  const dangerousActions = {
    kill: { key: "container.kill", command: "kill", methods: ["POST"] },
    rm: { key: "container.rm", command: "rm", methods: ["POST"] },
  };

  if (safeReadonlyActions[actionName]) {
    const action = safeReadonlyActions[actionName];
    if (!ensureMethod(req, res, action.methods)) {
      return;
    }
    if (!requirePermission(res, action.key)) {
      return;
    }
    const result = await action.fn();
    sendCommandResult(res, result);
    return;
  }

  if (safeMutateActions[actionName]) {
    const action = safeMutateActions[actionName];
    if (!ensureMethod(req, res, action.methods)) {
      return;
    }
    if (!requirePermission(res, action.key)) {
      return;
    }
    const result = await dockerClient.containerMutate(containerName, action.command);
    sendCommandResult(res, result);
    return;
  }

  if (dangerousActions[actionName]) {
    const action = dangerousActions[actionName];
    if (!ensureMethod(req, res, action.methods)) {
      return;
    }
    if (!requirePermission(res, action.key)) {
      return;
    }
    const result = await dockerClient.containerMutate(containerName, action.command);
    sendCommandResult(res, result);
    return;
  }

  if (actionName === "exec") {
    if (!ensureMethod(req, res, ["POST"])) {
      return;
    }
    if (!requirePermission(res, "container.exec")) {
      return;
    }
    const body = await parseRequestBody(req, config.requestBodyLimitBytes);
    const commandText = collectCommandText(urlObj, body);
    const shell = normalizeValue(urlObj.searchParams.get("shell")) || config.execShell;
    const result = await dockerClient.containerExec(containerName, shell, commandText);
    sendCommandResult(res, result);
    return;
  }

  if (actionName === "rename") {
    if (!ensureMethod(req, res, ["POST"])) {
      return;
    }
    if (!requirePermission(res, "container.rename")) {
      return;
    }
    const body = await parseRequestBody(req, config.requestBodyLimitBytes);
    const toName = normalizeValue(urlObj.searchParams.get("to")) || normalizeValue(body.json && body.json.to);
    const result = await dockerClient.containerRename(containerName, toName);
    sendCommandResult(res, result);
    return;
  }

  if (actionName === "update") {
    if (!ensureMethod(req, res, ["POST"])) {
      return;
    }
    if (!requirePermission(res, "container.update")) {
      return;
    }
    const body = await parseRequestBody(req, config.requestBodyLimitBytes);
    const args = collectArgs(urlObj, body);
    const result = await dockerClient.containerUpdate(containerName, args);
    sendCommandResult(res, result);
    return;
  }

  if (actionName === "raw") {
    if (!ensureMethod(req, res, ["POST"])) {
      return;
    }
    if (!requirePermission(res, "container.raw")) {
      return;
    }
    const body = await parseRequestBody(req, config.requestBodyLimitBytes);
    const args = collectArgs(urlObj, body);
    const result = await dockerClient.containerRaw(containerName, args);
    sendCommandResult(res, result);
    return;
  }

  respondText(res, 404, `unsupported container action: ${actionName}`);
};

const requestHandler = async (req, res) => {
  runtimeState.requestCount += 1;
  const requestId = `${Date.now()}-${runtimeState.requestCount}`;
  const scope = `http:${requestId}`;

  let urlObj;
  try {
    const host = req.headers.host || `127.0.0.1:${config.port}`;
    urlObj = new URL(req.url, `http://${host}`);
  } catch (error) {
    respondText(res, 400, "invalid request url");
    return;
  }

  const pathname = urlObj.pathname;
  logger.request(scope, {
    method: req.method,
    path: pathname,
    query: urlObj.search,
    remoteAddress: req.socket.remoteAddress || "",
  });

  if (!pathname.startsWith("/dockerapi")) {
    respondText(res, 404, "not found");
    return;
  }

  try {
    if (pathname === "/dockerapi" || pathname === "/dockerapi/") {
      if (!ensureMethod(req, res, ["GET"])) {
        return;
      }
      if (!requirePermission(res, "help")) {
        return;
      }
      respondText(res, 200, buildHelpText());
      return;
    }

    if (pathname === "/dockerapi/help") {
      if (!ensureMethod(req, res, ["GET"])) {
        return;
      }
      if (!requirePermission(res, "help")) {
        return;
      }
      respondText(res, 200, buildHelpText());
      return;
    }

    if (pathname === "/dockerapi/healthz") {
      if (!ensureMethod(req, res, ["GET"])) {
        return;
      }
      if (!requirePermission(res, "healthz")) {
        return;
      }
      respondText(
        res,
        200,
        [
          "status=ok",
          `startedAt=${runtimeState.startedAt}`,
          `requestCount=${runtimeState.requestCount}`,
          `tailscaleSyncEnabled=${runtimeState.sync.enabled ? "1" : "0"}`,
          `tailscaleSyncInProgress=${runtimeState.sync.inProgress ? "1" : "0"}`,
          `tailscaleSyncLastRunAt=${runtimeState.sync.lastRunAt || ""}`,
          `tailscaleSyncLastSuccessAt=${runtimeState.sync.lastSuccessAt || ""}`,
          `tailscaleSyncTotalRuns=${runtimeState.sync.totalRuns}`,
          `tailscaleSyncTotalFailures=${runtimeState.sync.totalFailures}`,
          `tailscaleSyncLastError=${runtimeState.sync.lastError || ""}`,
        ].join("\n"),
      );
      return;
    }

    if (pathname === "/dockerapi/tailscale/status") {
      if (!ensureMethod(req, res, ["GET"])) {
        return;
      }
      if (!requirePermission(res, "tailscale.status")) {
        return;
      }
      const format = normalizeValue(urlObj.searchParams.get("format")).toLowerCase();
      const asJson = format === "json";
      const result = await dockerClient.tailscaleStatus({ asJson });
      if (asJson) {
        const jsonText = normalizeValue(result.stdout) || "{}";
        try {
          const parsed = JSON.parse(jsonText);
          respondJson(res, 200, parsed);
        } catch (error) {
          respondText(res, 500, formatCommandResult(result));
        }
        return;
      }
      sendCommandResult(res, result);
      return;
    }

    if (pathname === "/dockerapi/tailscale/ping") {
      if (!ensureMethod(req, res, ["POST"])) {
        return;
      }
      if (!requirePermission(res, "tailscale.ping")) {
        return;
      }
      const body = await parseRequestBody(req, config.requestBodyLimitBytes);
      const target =
        normalizeValue(urlObj.searchParams.get("target")) || normalizeValue(body.json && body.json.target) || normalizeValue(body.text);
      const count = normalizeValue(urlObj.searchParams.get("count")) || normalizeValue(body.json && body.json.count);
      const result = await dockerClient.tailscalePing(target, count);
      sendCommandResult(res, result);
      return;
    }

    if (pathname === "/dockerapi/tailscale/ip") {
      if (!ensureMethod(req, res, ["GET"])) {
        return;
      }
      if (!requirePermission(res, "tailscale.ip")) {
        return;
      }
      const result = await dockerClient.tailscaleIp();
      sendCommandResult(res, result);
      return;
    }

    if (pathname === "/dockerapi/nginx/test") {
      if (!ensureMethod(req, res, ["GET"])) {
        return;
      }
      if (!requirePermission(res, "nginx.test")) {
        return;
      }
      const result = await dockerClient.nginxTest();
      sendCommandResult(res, result);
      return;
    }

    if (pathname === "/dockerapi/nginx/reload") {
      if (!ensureMethod(req, res, ["POST"])) {
        return;
      }
      if (!requirePermission(res, "nginx.reload")) {
        return;
      }
      const result = await dockerClient.nginxReload();
      sendCommandResult(res, result);
      return;
    }

    if (pathname === "/dockerapi/nginx/version") {
      if (!ensureMethod(req, res, ["GET"])) {
        return;
      }
      if (!requirePermission(res, "nginx.version")) {
        return;
      }
      const result = await dockerClient.nginxVersion();
      sendCommandResult(res, result);
      return;
    }

    const nginxLogsMatch = pathname.match(/^\/dockerapi\/nginx\/logs\/([A-Za-z0-9_-]+)$/);
    if (nginxLogsMatch) {
      if (!ensureMethod(req, res, ["GET"])) {
        return;
      }
      const logType = normalizeValue(nginxLogsMatch[1]).toLowerCase();
      if (!["access", "error", "shadow"].includes(logType)) {
        respondText(res, 404, `unsupported nginx log type: ${logType}`);
        return;
      }
      const permissionKey = `nginx.logs.${logType}`;
      if (!requirePermission(res, permissionKey)) {
        return;
      }
      const tail = parsePositiveInt(urlObj.searchParams.get("tail"), config.defaultLogTail, {
        min: 1,
        max: config.maxLogLines,
      });
      const result = await dockerClient.nginxLogs(logType, tail);
      sendCommandResult(res, result);
      return;
    }

    const systemMatch = pathname.match(/^\/dockerapi\/system\/([A-Za-z0-9_-]+)$/);
    if (systemMatch) {
      const commandName = normalizeValue(systemMatch[1]).toLowerCase();
      await handleSystemRoute(req, res, urlObj, commandName);
      return;
    }

    const containerMatch = pathname.match(/^\/dockerapi\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (containerMatch) {
      const containerName = normalizeValue(containerMatch[1]);
      const actionName = normalizeValue(containerMatch[2]).toLowerCase();
      await handleContainerRoute(req, res, urlObj, containerName, actionName);
      return;
    }

    respondText(res, 404, "dockerapi route not found");
  } catch (error) {
    handleCommandError(res, scope, error);
  }
};

const server = http.createServer((req, res) => {
  void requestHandler(req, res);
});

server.on("clientError", (error, socket) => {
  logger.error("server", error, "client error");
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
});

process.on("uncaughtException", (error) => {
  logger.error("process", error, "uncaught exception");
});

process.on("unhandledRejection", (reason) => {
  logger.error("process", reason, "unhandled rejection");
});

server.listen(config.port, config.host, () => {
  logger.info("server", `docker-manager is running on ${config.host}:${config.port}`);
  logger.info("server", "tailscale periodic sync setup", {
    enabled: config.tailscaleSyncEnabled,
    intervalSec: config.tailscaleSyncIntervalSec,
    shadowDir: config.shadowDir,
    shadowPort: config.shadowPort,
  });
  if (config.tailscaleSyncEnabled) {
    setTimeout(() => {
      void runScheduledSync("startup");
    }, 2000);
    setInterval(() => {
      void runScheduledSync("interval");
    }, config.tailscaleSyncIntervalSec * 1000);
  }
});
