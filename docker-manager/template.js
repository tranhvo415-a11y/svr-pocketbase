"use strict";

/**
 * docker-manager template notes
 * - Runtime entrypoint: docker-manager/index.js
 * - Modules:
 *   - docker-manager/lib/config.js
 *   - docker-manager/lib/logger.js
 *   - docker-manager/lib/command-runner.js
 *   - docker-manager/lib/docker-client.js
 *   - docker-manager/lib/tailscale-shadow-sync.js
 */

module.exports = {
  entrypoint: "./index.js",
  modules: [
    "./lib/config.js",
    "./lib/logger.js",
    "./lib/command-runner.js",
    "./lib/docker-client.js",
    "./lib/tailscale-shadow-sync.js",
  ],
};
