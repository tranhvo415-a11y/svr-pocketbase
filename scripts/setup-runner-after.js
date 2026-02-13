#!/usr/bin/env node
"use strict";

const fs = require("fs");
const helper = require("./setup-runner-helper");

const normalizeTailnetDnsDomain = (rawValue) => {
  let normalized = helper.normalizeValue(rawValue);
  while (normalized.startsWith(".")) {
    normalized = normalized.slice(1);
  }
  while (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized) {
    return "";
  }
  return normalized.endsWith(".ts.net") ? normalized : `${normalized}.ts.net`;
};

const normalizeDomainToken = (rawValue) => {
  let normalized = helper.normalizeValue(rawValue);
  while (normalized.startsWith("~")) {
    normalized = normalized.slice(1);
  }
  while (normalized.startsWith(".")) {
    normalized = normalized.slice(1);
  }
  if (!normalized) {
    return "";
  }
  return `~${normalized}`;
};

const runResolvectlWithOptionalSudo = (args) => {
  const command = `resolvectl ${args.join(" ")}`;

  const runResultToError = (result) => {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    return stderr || stdout || `exit ${result.status}`;
  };

  try {
    const direct = helper.runCommand("resolvectl", args, { allowFailure: true });
    if (direct.status === 0) {
      return {
        ok: true,
        mode: "direct",
        command,
      };
    }
  } catch (error) {
    void error;
  }

  try {
    const sudoResult = helper.runCommand("sudo", ["-n", "resolvectl", ...args], { allowFailure: true });
    if (sudoResult.status === 0) {
      return {
        ok: true,
        mode: "sudo",
        command: `sudo -n ${command}`,
      };
    }
    return {
      ok: false,
      mode: "sudo",
      command: `sudo -n ${command}`,
      error: runResultToError(sudoResult),
    };
  } catch (error) {
    return {
      ok: false,
      mode: "none",
      command: `sudo -n ${command}`,
      error: error && error.message ? error.message : String(error),
    };
  }
};

const readCurrentDomainTokens = (dnsInterface) => {
  const parseTokens = (rawOutput) => {
    const text = String(rawOutput || "").trim();
    if (!text) {
      return [];
    }
    const payload = text.includes(":") ? text.slice(text.indexOf(":") + 1) : text;
    const tokens = [];
    for (const candidate of payload.split(/\s+/)) {
      const token = candidate.trim();
      if (!token || !/^~?[A-Za-z0-9.-]+$/.test(token)) {
        continue;
      }
      const normalized = normalizeDomainToken(token);
      if (normalized && !tokens.includes(normalized)) {
        tokens.push(normalized);
      }
    }
    return tokens;
  };

  try {
    const direct = helper.runCommand("resolvectl", ["domain", dnsInterface], { allowFailure: true });
    if (direct.status === 0) {
      return parseTokens(direct.stdout);
    }
  } catch (error) {
    void error;
  }

  try {
    const sudoResult = helper.runCommand("sudo", ["-n", "resolvectl", "domain", dnsInterface], { allowFailure: true });
    if (sudoResult.status === 0) {
      return parseTokens(sudoResult.stdout);
    }
  } catch (error) {
    void error;
  }

  return [];
};

const interfaceExists = (dnsInterface) => fs.existsSync(`/sys/class/net/${dnsInterface}`);

const executeMain = (async () => {
  try {
    const step00_configureResolver = (() => {
      try {
        const tailnetDnsDomain = normalizeTailnetDnsDomain(helper.readEnv("TAILSCALE_TAILNET_DNS", ""));
        if (!tailnetDnsDomain) {
          helper.logInfo("setup-runner-after", "step00_configureResolver skipped because TAILSCALE_TAILNET_DNS is empty");
          return {
            skipped: true,
            reason: "tailnet_dns_empty",
          };
        }

        if (!helper.isLinux()) {
          helper.logInfo("setup-runner-after", "step00_configureResolver skipped: non-linux runtime");
          return {
            attempted: false,
            applied: false,
            reason: "non_linux_runtime",
          };
        }

        const dnsInterface = helper.readEnv("DNS_INTERFACE", "tailscale0");
        if (!interfaceExists(dnsInterface)) {
          helper.logInfo("setup-runner-after", `step00_configureResolver deferred: interface '${dnsInterface}' not found yet`);
          return {
            attempted: false,
            applied: false,
            reason: "interface_not_found_yet",
            dnsInterface,
          };
        }

        const dnsNameserverPrimary = helper.readEnv(
          "DNS_NAMESERVER_PRIMARY",
          helper.readEnv("TAILSCALE_DNS_NAMESERVER_PRIMARY", "100.100.100.100"),
        ) || "100.100.100.100";

        const desiredDomains = [];
        const tsDomainToken = normalizeDomainToken("ts.net");
        if (tsDomainToken) {
          desiredDomains.push(tsDomainToken);
        }
        const tailnetDomainToken = normalizeDomainToken(tailnetDnsDomain);
        if (tailnetDomainToken && !desiredDomains.includes(tailnetDomainToken)) {
          desiredDomains.push(tailnetDomainToken);
        }

        const existingDomains = readCurrentDomainTokens(dnsInterface);
        const mergedDomains = [...existingDomains];
        for (const token of desiredDomains) {
          if (!mergedDomains.includes(token)) {
            mergedDomains.push(token);
          }
        }

        const dnsResult = runResolvectlWithOptionalSudo(["dns", dnsInterface, dnsNameserverPrimary]);
        const domainsToApply = mergedDomains.length > 0 ? mergedDomains : desiredDomains;
        const domainResult = runResolvectlWithOptionalSudo(["domain", dnsInterface, ...domainsToApply]);
        const applied = dnsResult.ok && domainResult.ok;

        if (applied) {
          helper.logInfo(
            "setup-runner-after",
            `step00_configureResolver ok: ${dnsResult.command} ; ${domainResult.command}`,
          );
        } else {
          helper.logInfo(
            "setup-runner-after",
            `step00_configureResolver pending: dnsError=${dnsResult.error || "none"}, domainError=${domainResult.error || "none"}`,
          );
        }

        return {
          attempted: true,
          applied,
          dnsInterface,
          tailnetDnsDomain,
          dnsNameserverPrimary,
          domains: domainsToApply,
          desiredDomains,
          existingDomains,
          dnsCommand: dnsResult.command,
          domainCommand: domainResult.command,
          dnsError: dnsResult.error || null,
          domainError: domainResult.error || null,
        };
      } catch (error) {
        helper.logError("setup-runner-after", error, "step00_configureResolver failed");
        throw error;
      }
    })();

    const step01_resolveDns = await (async () => {
      try {
        const nowHourKey = helper.readEnv("DOTENVRTDB_NOW_YYYYDDMMHH", "");
        const tailnetDns = normalizeTailnetDnsDomain(helper.readEnv("TAILSCALE_TAILNET_DNS", ""));
        if (!nowHourKey || !tailnetDns) {
          helper.logInfo("setup-runner-after", "step01_resolveDns skipped because DOTENVRTDB_NOW_YYYYDDMMHH or TAILSCALE_TAILNET_DNS is empty");
          return {
            skipped: true,
            reason: "missing_datetime_or_tailnet_dns",
          };
        }
        const probeHost = `${nowHourKey}.${tailnetDns}`;

        const timeoutSec = helper.readIntEnv("RUNNER_AFTER_DNS_TIMEOUT_SEC", 25);
        const intervalMs = helper.readIntEnv("RUNNER_AFTER_DNS_INTERVAL_MS", 2000);
        const required = helper.readEnv("RUNNER_AFTER_DNS_REQUIRED", "0") === "1";
        const deadline = Date.now() + timeoutSec * 1000;
        let attempt = 0;
        let lastError = "";

        while (Date.now() <= deadline) {
          attempt += 1;
          try {
            if (helper.canResolveHost(probeHost)) {
              helper.logInfo("setup-runner-after", `step01_resolveDns ok on attempt ${attempt}: ${probeHost}`);
              return {
                probeHost,
                attempt,
                required,
              };
            }
            helper.logInfo("setup-runner-after", `dns resolve attempt ${attempt} not ready: ${probeHost}`);
          } catch (error) {
            lastError = error && error.message ? error.message : String(error);
            helper.logInfo("setup-runner-after", `dns resolve attempt ${attempt} command warning: ${lastError}`);
          }
          await helper.sleep(intervalMs);
        }

        if (required) {
          throw new Error(`cannot resolve host '${probeHost}' after ${timeoutSec}s`);
        }

        helper.logInfo(
          "setup-runner-after",
          `step01_resolveDns pending after ${timeoutSec}s (non-blocking): host=${probeHost}${lastError ? `, lastError=${lastError}` : ""}`,
        );
        return {
          probeHost,
          pending: true,
          required,
          timeoutSec,
          lastError: lastError || null,
        };
      } catch (error) {
        helper.logError("setup-runner-after", error, "step01_resolveDns failed");
        throw error;
      }
    })();

    const step02_verifyNginxHealth = await (async () => {
      try {
        const rawNginxPort = helper.readIntEnv("NGINX_PORT", 8080);
        let nginxPort = rawNginxPort;
        if (rawNginxPort === 80) {
          const caddyUpstreamPort = helper.readIntEnv("CADDY_UPSTREAM_PORT", 8080);
          nginxPort = caddyUpstreamPort === 80 ? 8080 : caddyUpstreamPort;
          helper.logInfo(
            "setup-runner-after",
            `step02_verifyNginxHealth remap NGINX_PORT=80 to port ${nginxPort} to avoid host :80 conflict with Caddy`,
          );
        }
        const timeoutSec = helper.readIntEnv("RUNNER_AFTER_HEALTH_TIMEOUT_SEC", 45);
        const intervalMs = helper.readIntEnv("RUNNER_AFTER_HEALTH_INTERVAL_MS", 2000);
        const required = helper.readEnv("RUNNER_AFTER_HEALTH_REQUIRED", "0") === "1";
        const url = `http://127.0.0.1:${nginxPort}/healthz`;
        const deadline = Date.now() + timeoutSec * 1000;
        let attempt = 0;
        let lastError = "";
        let lastStatusCode = null;

        while (Date.now() <= deadline) {
          attempt += 1;
          try {
            const response = await helper.request(url, 3000);
            if (response.statusCode >= 200 && response.statusCode < 300) {
              helper.logInfo("setup-runner-after", `step02_verifyNginxHealth ok on attempt ${attempt}: ${url}`);
              return { url, attempt, statusCode: response.statusCode, required };
            }
            lastStatusCode = response.statusCode;
            helper.logInfo("setup-runner-after", `health check attempt ${attempt} returned ${response.statusCode}`);
          } catch (error) {
            lastError = error && error.message ? error.message : String(error);
            helper.logInfo("setup-runner-after", `health check attempt ${attempt} failed: ${lastError}`);
          }
          await helper.sleep(intervalMs);
        }

        if (required) {
          throw new Error(`health check failed for ${url} after ${timeoutSec}s`);
        }

        helper.logInfo(
          "setup-runner-after",
          `step02_verifyNginxHealth pending after ${timeoutSec}s (non-blocking): url=${url}${lastStatusCode ? `, lastStatus=${lastStatusCode}` : ""}${lastError ? `, lastError=${lastError}` : ""}`,
        );
        return {
          url,
          pending: true,
          required,
          timeoutSec,
          lastStatusCode,
          lastError: lastError || null,
        };
      } catch (error) {
        helper.logError("setup-runner-after", error, "step02_verifyNginxHealth failed");
        throw error;
      }
    })();

    const step03_showComposeStatus = (() => {
      try {
        const envFilePath = helper.readEnv("RUNNER_ENV_FILE", ".env");
        const result = helper.runCommand("docker", ["compose", "--env-file", envFilePath, "ps"], {
          allowFailure: true,
        });
        if (result.status === 0) {
          const output = String(result.stdout || "").trim();
          if (output) {
            console.log(output);
          }
        } else {
          const stderr = String(result.stderr || "").trim();
          helper.logInfo("setup-runner-after", `docker compose ps warning: ${stderr || `exit ${result.status}`}`);
        }
        return { status: result.status };
      } catch (error) {
        helper.logError("setup-runner-after", error, "step03_showComposeStatus failed");
        throw error;
      }
    })();

    const step04_SumaryStep = (() => {
      try {
        const hasLogDir = fs.existsSync(".nginx/logs");
        const hasShadowAuditLog = Boolean(helper.readFileIfExists(".nginx/logs/shadow.mirror.log"));
        helper.logInfo("setup-runner-after", `nginx host log dir found: ${hasLogDir ? "yes" : "no"}`);
        helper.logInfo("setup-runner-after", `shadow audit log found: ${hasShadowAuditLog ? "yes" : "no"}`);
        helper.logInfo(
          "setup-runner-after",
          `summary: ${JSON.stringify({ step00_configureResolver, step01_resolveDns, step02_verifyNginxHealth, step03_showComposeStatus })}`,
        );
        return {
          success: true,
          hasLogDir,
          hasShadowAuditLog,
          totalSteps: 5,
        };
      } catch (error) {
        helper.logError("setup-runner-after", error, "step04_SumaryStep failed");
        throw error;
      }
    })();

    return {
      step00_configureResolver,
      step01_resolveDns,
      step02_verifyNginxHealth,
      step03_showComposeStatus,
      step04_SumaryStep,
    };
  } catch (error) {
    helper.logError("setup-runner-after", error, "executeMain failed");
    process.exitCode = 1;
    return null;
  }
})();

void executeMain;
