"use strict";

const fs = require("fs");
const path = require("path");

const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

const normalizeValue = (value) => String(value ?? "").trim();

const isIpv4 = (value) => {
  const text = normalizeValue(value);
  if (!IPV4_PATTERN.test(text)) {
    return false;
  }
  const octets = text.split(".").map((item) => Number.parseInt(item, 10));
  return octets.every((octet) => Number.isFinite(octet) && octet >= 0 && octet <= 255);
};

const readShadowFiles = (shadowDir) => {
  const state = new Map();
  fs.mkdirSync(shadowDir, { recursive: true });
  const entries = fs.readdirSync(shadowDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".conf")) {
      continue;
    }
    const ip = entry.name.replace(/\.conf$/i, "");
    if (!isIpv4(ip)) {
      continue;
    }
    const fullPath = path.join(shadowDir, entry.name);
    const content = fs.readFileSync(fullPath, "utf8");
    state.set(ip, content);
  }
  return state;
};

const renderShadowContent = (ip, port) => `server ${ip}:${port} max_fails=2 fail_timeout=10s;\n`;

const writeShadowState = (shadowDir, desiredState) => {
  fs.mkdirSync(shadowDir, { recursive: true });
  const currentEntries = fs.readdirSync(shadowDir, { withFileTypes: true });
  const existingFiles = new Set();

  for (const entry of currentEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".conf")) {
      continue;
    }
    const ip = entry.name.replace(/\.conf$/i, "");
    if (!isIpv4(ip)) {
      continue;
    }
    existingFiles.add(ip);
  }

  for (const [ip, content] of desiredState.entries()) {
    const filePath = path.join(shadowDir, `${ip}.conf`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filePath);
    existingFiles.delete(ip);
  }

  for (const ip of existingFiles) {
    fs.rmSync(path.join(shadowDir, `${ip}.conf`), { force: true });
  }
};

const applyStateWithRollback = async (options) => {
  const { shadowDir, previousState, desiredState, dockerClient, logger, nginxContainerName } = options;
  writeShadowState(shadowDir, desiredState);
  try {
    await dockerClient.nginxTest();
    await dockerClient.execInContainer(nginxContainerName, ["nginx", "-s", "reload"]);
  } catch (error) {
    logger.error("tailscale-sync", error, "nginx test/reload failed, rollback started");
    writeShadowState(shadowDir, previousState);
    try {
      await dockerClient.nginxTest();
      await dockerClient.execInContainer(nginxContainerName, ["nginx", "-s", "reload"]);
    } catch (rollbackError) {
      logger.error("tailscale-sync", rollbackError, "rollback reload failed");
    }
    throw error;
  }
};

const isPeerActive = (peer) => {
  const rawFlags = [peer && peer.Online, peer && peer.online, peer && peer.Active, peer && peer.active];
  const explicitFlags = rawFlags.filter((value) => value === true || value === false);
  if (explicitFlags.length > 0) {
    return explicitFlags.some((value) => value === true);
  }
  const curAddr = normalizeValue(peer && (peer.CurAddr || peer.curAddr));
  return Boolean(curAddr);
};

const collectNodeIps = (node) => {
  const ipValues = [];
  const candidates = [
    node && node.TailscaleIPs,
    node && node.tailscaleIPs,
    node && node.tailscaleIps,
    node && node.Addresses,
    node && node.addresses,
    node && node.ips,
  ];
  for (const list of candidates) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      const ip = normalizeValue(item);
      if (isIpv4(ip) && !ipValues.includes(ip)) {
        ipValues.push(ip);
      }
    }
  }
  return ipValues;
};

const extractActivePeerIps = (statusPayload) => {
  const peers = statusPayload && statusPayload.Peer && typeof statusPayload.Peer === "object" ? Object.values(statusPayload.Peer) : [];
  const selfNode = statusPayload && statusPayload.Self ? statusPayload.Self : {};
  const selfIps = new Set(collectNodeIps(selfNode));
  const selfId = normalizeValue(selfNode.ID || selfNode.id);
  const selectedIps = [];

  for (const peer of peers) {
    if (!peer || typeof peer !== "object") {
      continue;
    }
    const peerId = normalizeValue(peer.ID || peer.id);
    if (peer.Self === true) {
      continue;
    }
    if (selfId && peerId && selfId === peerId) {
      continue;
    }
    if (!isPeerActive(peer)) {
      continue;
    }
    const ips = collectNodeIps(peer);
    for (const ip of ips) {
      if (selfIps.has(ip)) {
        continue;
      }
      if (!selectedIps.includes(ip)) {
        selectedIps.push(ip);
      }
    }
  }

  selectedIps.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
  return selectedIps;
};

const runTailscaleShadowSync = async ({ dockerClient, config, logger }) => {
  const statusResult = await dockerClient.tailscaleStatus({ asJson: true });
  let payload;
  try {
    payload = JSON.parse(String(statusResult.stdout || "{}"));
  } catch (error) {
    throw new Error(`invalid tailscale status json: ${error.message}`);
  }

  const nextIps = extractActivePeerIps(payload);
  const previousState = readShadowFiles(config.shadowDir);
  const nextState = new Map();
  for (const ip of nextIps) {
    nextState.set(ip, renderShadowContent(ip, config.shadowPort));
  }

  const previousIps = Array.from(previousState.keys()).sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
  );

  const added = nextIps.filter((ip) => !previousState.has(ip));
  const removed = previousIps.filter((ip) => !nextState.has(ip));
  const changed = added.length > 0 || removed.length > 0;

  logger.info("tailscale-sync", "tailscale scan result", {
    previousIps,
    nextIps,
    added,
    removed,
    changed,
  });

  if (!changed) {
    return {
      changed: false,
      previousIps,
      nextIps,
      added,
      removed,
    };
  }

  await applyStateWithRollback({
    shadowDir: config.shadowDir,
    previousState,
    desiredState: nextState,
    dockerClient,
    logger,
    nginxContainerName: config.nginxContainer,
  });

  logger.info("tailscale-sync", "shadow files synced and nginx reloaded", {
    added,
    removed,
  });

  return {
    changed: true,
    previousIps,
    nextIps,
    added,
    removed,
  };
};

module.exports = {
  runTailscaleShadowSync,
};
