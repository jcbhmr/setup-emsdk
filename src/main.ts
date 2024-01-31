#!/usr/bin/env node
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as tc from "@actions/tool-cache";
import * as semver from "semver";
import { createUnauthenticatedAuth } from "@octokit/auth-unauthenticated";
import { cp, mkdir, rm } from "node:fs/promises";
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
const primaryKey = `emsdk-${version}`;
const batExt = process.platform === "win32" ? ".bat" : "";

let found = tc.find("emsdk", version);
let cacheHit = !!found;
if (!found) {
  found = join(process.env.RUNNER_TEMP!, Math.random().toString());
  await mkdir(found, { recursive: true });
  found = await tc.cacheDir(found, "emsdk", version);
  install_emsdk: try {
    if (workflowCache) {
      core.info(`Trying to restore cache with key: ${primaryKey}`);
      const hitKey = await cache.restoreCache([found], primaryKey);
      if (hitKey) {
        core.info(`Cache hit on key: ${hitKey}`);
        cacheHit = true;
        break install_emsdk;
      }
    }

    let archive = await tc.downloadTool(
      `https://github.com/emscripten-core/emsdk/archive/${version}.tar.gz`
    );
    archive = await tc.extractTar(archive);
    await cp(join(archive, `emsdk-${version}`), found, {
      recursive: true,
      force: true,
    });

    if (process.arch !== "x64") {
      throw new DOMException(`emsdk only supports x86_64`);
    }

    await $({
      stdio: "inherit",
      cwd: found,
    })`./emsdk${batExt} install sdk-${version}-64bit`;
    await $({
      stdio: "inherit",
      cwd: found,
    })`./emsdk${batExt} activate sdk-${version}-64bit`;

    if (workflowCache) {
      core.info(`Saving cache with key: ${primaryKey}`);
      await cache.saveCache([found], primaryKey);
    }
  } catch (error) {
    await rm(found, { recursive: true, force: true });
    throw error;
  }
}

const { all } = await $({
  all: true,
  cwd: found,
})`./emsdk${batExt} construct_env`;
core.group("construct_env", async () => core.info(all!));

for (const line of all!.split(/\r?\n/g)) {
  let match: RegExpMatchArray | null;
  if ((match = line.match(/PATH \+= (.+)/))) {
    core.info(`Adding ${match[1]} to PATH`);
    core.addPath(match[1]);
  } else if ((match = line.match(/(\S) = (.+)/))) {
    core.info(`Setting ${match[1]} to ${match[2]}`);
    core.exportVariable(match[1], match[2]);
  }
}

core.setOutput("cache-hit", cacheHit);
core.addPath(found);
core.setOutput("emsdk-version", version);
core.info(`✅ emsdk v${version} installed!`);

// '@actions/cache' hangs for a while unless explicitly exited. 🤷‍♀️
process.exit();
