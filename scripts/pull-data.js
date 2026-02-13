#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOST_CWD = normalizeEnv(process.env.HOST_CWD);
const PULL_DATA_SYNC_DIRS = normalizeEnv(process.env.PULL_DATA_SYNC_DIRS) || ".pocketbase";
const TAILSCALE_CLIENT_ID = normalizeEnv(process.env.TAILSCALE_CLIENT_ID) || normalizeEnv(process.env.TAILSCALE_CLIENT_ID);
const TAILSCALE_CLIENT_SECRET = normalizeEnv(process.env.TAILSCALE_CLIENT_SECRET) || normalizeEnv(process.env.TAILSCALE_CLIENT_SECRET);
const TAILSCALE_TAILNET = normalizeEnv(process.env.TAILSCALE_TAILNET) || "-";
const TAILSCALE_API_BASE_URL = (normalizeEnv(process.env.TAILSCALE_API_BASE_URL) || "https://api.tailscale.com").replace(/\/+$/, "");
const CWD_PORT = normalizePositiveInt(process.env.PULL_DATA_CWD_PORT, 8080);
const HTTP_TIMEOUT_MS = normalizePositiveInt(process.env.PULL_DATA_HTTP_TIMEOUT_MS, 5000);
const SSH_PORT = normalizePositiveInt(process.env.PULL_DATA_SSH_PORT || process.env.SSH_PORT, 2222);
const SSH_USER = normalizeEnv(process.env.PULL_DATA_SSH_USER);
const SSH_PRIVATE_KEY_BASE64 = normalizeEnv(process.env.SSH_PULL_DATA_PRIVATE_KEY_BASE64 || process.env.PULL_DATA_SSH_PRIVATE_KEY_BASE64);
const SSH_KNOWN_HOSTS_FILE = normalizeEnv(process.env.PULL_DATA_SSH_KNOWN_HOSTS_FILE);

function log(message) {
  process.stdout.write(`[pull-data] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[pull-data] warning: ${message}\n`);
}

async function main() {
  if (!HOST_CWD) {
    warn("HOST_CWD is empty, skip");
    return;
  }

  if (!TAILSCALE_CLIENT_ID || !TAILSCALE_CLIENT_SECRET) {
    warn("missing TAILSCALE_CLIENT_ID/TAILSCALE_CLIENT_SECRET, skip");
    return;
  }

  if (typeof fetch !== "function") {
    warn("fetch is unavailable in this Node runtime");
    return;
  }

  if (!hasCommand("ssh") || !hasCommand("rsync")) {
    warn("missing ssh or rsync binary");
    return;
  }

  const accessToken = await fetchAccessToken();
  const devices = await fetchDevices(accessToken);
  if (devices.length === 0) {
    log("no device returned by Tailscale API");
    return;
  }

  const peers = await collectReachablePeers(devices);
  if (peers.length === 0) {
    log("no reachable peer from /cwd");
    return;
  }

  const selected = selectNewestPeer(peers);
  if (!selected) {
    log("no peer selected");
    return;
  }

  let sshContext;
  try {
    sshContext = createSshContext();
  } catch (error) {
    warn(error && error.message ? error.message : String(error));
    return;
  }

  try {
    log(`selected ip=${selected.ip} startTime=${selected.startTime || "unknown"}`);
    log(`remote cwd: ${selected.cwd}`);
    log(`local cwd: ${HOST_CWD}`);
    log(`transport: ssh (port=${SSH_PORT}, key=file, strictHostKeyChecking=accept-new)`);

    syncFromPeer(selected, sshContext);
    log("done");
  } finally {
    cleanupSshContext(sshContext);
  }
}

async function fetchAccessToken() {
  const tokenUrl = `${TAILSCALE_API_BASE_URL}/api/v2/oauth/token`;
  const body = "grant_type=client_credentials";
  const basic = Buffer.from(`${TAILSCALE_CLIENT_ID}:${TAILSCALE_CLIENT_SECRET}`, "utf8").toString("base64");

  const response = await fetchWithTimeout(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`oauth token request failed (${response.status}): ${truncate(text)}`);
  }

  const payload = await response.json();
  const token = normalizeEnv(payload.access_token);
  if (!token) {
    throw new Error("oauth response missing access_token");
  }
  return token;
}

async function fetchDevices(accessToken) {
  const endpoints = [
    `${TAILSCALE_API_BASE_URL}/api/v2/tailnet/${encodeURIComponent(TAILSCALE_TAILNET)}/devices?fields=all`,
    `${TAILSCALE_API_BASE_URL}/api/v2/tailnet/${encodeURIComponent(TAILSCALE_TAILNET)}/devices`,
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`status ${response.status}: ${truncate(text)}`);
      }

      const payload = await response.json();
      return extractDeviceList(payload);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`cannot fetch devices from Tailscale API: ${lastError ? lastError.message : "unknown error"}`);
}

function extractDeviceList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && Array.isArray(payload.devices)) {
    return payload.devices;
  }
  if (payload && Array.isArray(payload.Devices)) {
    return payload.Devices;
  }
  return [];
}

async function collectReachablePeers(devices) {
  const peers = [];

  for (const device of devices) {
    if (!isDeviceActive(device)) {
      continue;
    }

    const ip = extractIpv4(device);
    if (!ip) {
      continue;
    }

    const cwdInfo = await fetchPeerCwd(ip);
    if (!cwdInfo || !cwdInfo.cwd) {
      continue;
    }

    const name = normalizeEnv(device.hostname) || normalizeEnv(device.name) || normalizeEnv(device.HostName) || "unknown";
    log(`peer ${name} ip=${ip} startTime=${cwdInfo.startTime || "unknown"}`);

    peers.push({
      ip,
      cwd: cwdInfo.cwd,
      startTime: cwdInfo.startTime,
    });
  }

  return peers;
}

function isDeviceActive(device) {
  const values = [
    device && device.online,
    device && device.active,
    device && device.connected,
    device && device.isOnline,
    device && device.isActive,
    device && device.Online,
    device && device.Active,
  ].filter((value) => value !== undefined && value !== null);

  if (values.length === 0) {
    return true;
  }

  return values.some((value) => Boolean(value));
}

function extractIpv4(device) {
  const arrays = [
    device && device.addresses,
    device && device.tailscaleIPs,
    device && device.tailscaleIps,
    device && device.ipAddresses,
    device && device.ips,
    device && device.Addresses,
    device && device.TailscaleIPs,
  ];

  for (const candidate of arrays) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    for (const value of candidate) {
      const ip = normalizeEnv(value);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        return ip;
      }
    }
  }

  return "";
}

async function fetchPeerCwd(ip) {
  const url = `http://${ip}:${CWD_PORT}/cwd`;
  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return {
      cwd: normalizeEnv(payload.cwd),
      startTime: normalizeEnv(payload.startTime),
    };
  } catch (error) {
    return null;
  }
}

function selectNewestPeer(peers) {
  let selected = null;

  for (const peer of peers) {
    if (!selected) {
      selected = peer;
      continue;
    }

    const current = parseTimestamp(peer.startTime);
    const chosen = parseTimestamp(selected.startTime);
    if (current > chosen) {
      selected = peer;
    }
  }

  return selected;
}

function parseTimestamp(value) {
  const normalized = normalizeEnv(value);
  if (!normalized) {
    return -1;
  }
  const ts = Date.parse(normalized);
  if (Number.isFinite(ts)) {
    return ts;
  }
  return -1;
}

function syncFromPeer(peer, sshContext) {
  const dirs = splitSyncDirs(PULL_DATA_SYNC_DIRS);
  const remoteTarget = resolveSshTarget(peer);
  let index = 0;

  for (const dir of dirs) {
    if (!isSafeRelativePath(dir)) {
      warn(`skip unsafe path: ${dir}`);
      continue;
    }

    index += 1;

    const remotePath = buildRemotePath(peer.cwd, dir);
    const localPath = path.resolve(HOST_CWD, dir);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    log("");
    log(`[sync ${index}] ${dir}`);
    log(`  remote: ${remoteTarget}:${remotePath}/`);
    log(`  local:  ${localPath}/`);

    const remoteCheck = remoteDirectoryExists(remoteTarget, remotePath, sshContext);
    if (!remoteCheck.exists) {
      if (remoteCheck.errorMessage) {
        warn(`remote check failed (${remoteTarget}): ${remoteCheck.errorMessage}`);
      } else {
        warn(`remote path missing: ${remotePath}`);
      }
      continue;
    }

    runRsync(remoteTarget, remotePath, localPath, dir, sshContext);
  }
}

function buildRemotePath(remoteCwd, dir) {
  const normalizedCwd = String(remoteCwd || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const normalizedDir = String(dir || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  return `${normalizedCwd}/${normalizedDir}`;
}

function remoteDirectoryExists(remoteTarget, remotePath, sshContext) {
  const escapedRemotePath = shellSingleQuote(remotePath);
  const result = spawnSync("ssh", [...sshBaseArgs(sshContext), remoteTarget, `test -d ${escapedRemotePath}`], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status === 0) {
    return { exists: true, errorMessage: "" };
  }

  const stderr = normalizeEnv(result.stderr);
  const stdout = normalizeEnv(result.stdout);
  const output = stderr || stdout;
  if (result.status === 1 && !output) {
    return { exists: false, errorMessage: "" };
  }

  return {
    exists: false,
    errorMessage: output || `exit status ${String(result.status)}`,
  };
}

function runRsync(remoteTarget, remotePath, localPath, dir, sshContext) {
  const rsyncRsh = shellJoin(["ssh", ...sshBaseArgs(sshContext)]);
  const result = spawnSync(
    "rsync",
    ["-avh", "--delete", "--exclude=.git/", "--exclude=**/.git/", "--info=NAME,STATS2,PROGRESS2", `${remoteTarget}:${remotePath}/`, `${localPath}/`],
    {
      stdio: "inherit",
      encoding: "utf8",
      env: {
        ...process.env,
        RSYNC_RSH: rsyncRsh,
      },
    },
  );

  if (result.status !== 0) {
    warn(`rsync failed: ${dir}`);
  }
}

function splitSyncDirs(value) {
  return String(value || "")
    .split(/[;,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isSafeRelativePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  if (path.isAbsolute(normalized)) {
    return false;
  }
  if (normalized.includes("..")) {
    return false;
  }
  return true;
}

function createSshContext() {
  if (!SSH_PRIVATE_KEY_BASE64) {
    throw new Error("missing SSH_PULL_DATA_PRIVATE_KEY_BASE64");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pull-data-ssh-"));
  const privateKeyFile = path.join(tempDir, "id_ed25519_pull_data");
  const knownHostsFile = SSH_KNOWN_HOSTS_FILE || path.join(tempDir, "known_hosts");
  const privateKey = decodePrivateKeyFromBase64(SSH_PRIVATE_KEY_BASE64);

  fs.writeFileSync(privateKeyFile, privateKey, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(privateKeyFile, 0o600);

  if (SSH_KNOWN_HOSTS_FILE) {
    fs.mkdirSync(path.dirname(knownHostsFile), { recursive: true });
    if (!fs.existsSync(knownHostsFile)) {
      fs.writeFileSync(knownHostsFile, "", {
        encoding: "utf8",
        mode: 0o600,
      });
    }
  } else {
    fs.writeFileSync(knownHostsFile, "", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  return {
    tempDir,
    privateKeyFile,
    knownHostsFile,
  };
}

function cleanupSshContext(context) {
  if (!context || !context.tempDir) {
    return;
  }

  try {
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  } catch (error) {
    warn(`cannot remove temp ssh dir: ${error && error.message ? error.message : String(error)}`);
  }
}

function decodePrivateKeyFromBase64(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  const decoded = Buffer.from(compact, "base64").toString("utf8").replace(/\r\n/g, "\n").trim();

  if (!decoded.includes("PRIVATE KEY")) {
    throw new Error("SSH_PULL_DATA_PRIVATE_KEY_BASE64 is invalid");
  }

  return `${decoded}\n`;
}

function sshBaseArgs(sshContext) {
  const keyFile = sshContext && sshContext.privateKeyFile ? sshContext.privateKeyFile : "";
  const knownHostsFile = sshContext && sshContext.knownHostsFile ? sshContext.knownHostsFile : "/dev/null";

  return [
    "-p",
    String(SSH_PORT),
    "-i",
    keyFile,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${knownHostsFile}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "LogLevel=ERROR",
  ];
}

function resolveSshTarget(peer) {
  const user = SSH_USER || inferUserFromCwd(peer && peer.cwd);
  if (user) {
    return `${user}@${peer.ip}`;
  }
  return peer.ip;
}

function inferUserFromCwd(cwd) {
  const normalized = normalizeEnv(cwd);
  if (!normalized) {
    return "";
  }

  const linuxHome = normalized.match(/^\/home\/([^/]+)(\/|$)/);
  if (linuxHome) {
    return linuxHome[1];
  }

  const macHome = normalized.match(/^\/Users\/([^/]+)(\/|$)/);
  if (macHome) {
    return macHome[1];
  }

  if (/^\/root(\/|$)/.test(normalized)) {
    return "root";
  }

  return "";
}

function hasCommand(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeEnv(value) {
  return String(value || "").trim();
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function truncate(text, max = 240) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 3)}...`;
}

function shellSingleQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

function shellJoin(values) {
  return values.map(shellToken).join(" ");
}

function shellToken(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) {
    return text;
  }
  return shellSingleQuote(text);
}

main().catch((error) => {
  warn(error && error.message ? error.message : String(error));
  process.exit(0);
});
