#!/usr/bin/env node
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as tc from "@actions/tool-cache";
import * as semver from "semver";
import { createUnauthenticatedAuth } from "@octokit/auth-unauthenticated";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "execa";
import * as cache from "@actions/cache";

const token = core.getInput("emsdk-token");
const octokit = token
  ? github.getOctokit(token)
  : github.getOctokit(undefined!, {
      authStrategy: createUnauthenticatedAuth,
      auth: { reason: "no 'emsdk-token' input" },
    });

const versionRaw = core.getInput("emsdk-version");
const tags = await octokit.paginate(octokit.rest.repos.listTags, {
  owner: "emscripten-core",
  repo: "emsdk",
});
const versions = tags.map((tag) => tag.name);
const version = semver.maxSatisfying(
  versions,
  versionRaw === "latest" ? "*" : versionRaw
)!;
core.debug(`Resolved version: v${version}`);
if (!version) throw new DOMException(`${versionRaw} resolved to ${version}`);

const workflowCache = core.getBooleanInput("cache");

let found = tc.find("emsdk", version);
let cacheHit = !!found;
if (!found) {
  const emsdkDir = join(process.env.HOME!, `emsdk-${version}`);
  await mkdir(emsdkDir, { recursive: true });

  install_emsdk: {
    if (workflowCache) {
      const primaryKey = `emsdk-${version}`;
      core.saveState("cache-key", primaryKey);
      const hitKey = await cache.restoreCache([emsdkDir], primaryKey);
      if (hitKey) {
        found = emsdkDir;
        cacheHit = true;
        break install_emsdk;
      }
    }

    const dl = await tc.downloadTool(
      `https://github.com/emscripten-core/emsdk/archive/${version}.tar.gz`
    );
    await tc.extractTar(dl, emsdkDir);

    const scriptExt = process.platform === "win32" ? ".bat" : "";
    await $({
      stdio: "inherit",
      cwd: emsdkDir,
    })`./emsdk${scriptExt} install ${version}`;
    await $({
      stdio: "inherit",
      cwd: emsdkDir,
    })`./emsdk${scriptExt} activate ${version}`;

    const { all } = await $({
      all: true,
      cwd: emsdkDir,
    })`./emsdk${scriptExt} construct_env`;

    core.info(`Got env vars:\n${all}`);

    for (const line of all!.split(/\r?\n/g)) {
      let match: RegExpMatchArray | null;
      if ((match = line.match(/PATH \+= (.+)/))) {
        core.addPath(match[1]);
      } else if ((match = line.match(/(\S) = (.+)/))) {
        core.exportVariable(match[1], match[2]);
      }
    }

    if (workflowCache) {
      const primaryKey = core.getState("cache-key");
      await cache.saveCache([emsdkDir], primaryKey);
    }
  }

  found = await tc.cacheDir(emsdkDir, "emsdk", version);
}
core.setOutput("cache-hit", cacheHit);
core.addPath(found);
core.setOutput("emsdk-version", version);
core.info(`✅ emsdk v${version} installed!`);
