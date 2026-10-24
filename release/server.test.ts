/**
 * The ready-made server setups (release/server) say the same facts as their sources: the installer's command
 * (links.ts), the image launch.ts pushes as `latest`, the Dockerfile's volume, and the files the server docs fetch.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE, INSTALL_COMMAND } from "../packages/contract/src/links";

const ROOT = join(import.meta.dir, "..");
const DIR = join(import.meta.dir, "server");
const read = (f: string): string => readFileSync(join(ROOT, f), "utf8");

test("the first-boot script is POSIX sh and runs the official installer", () => {
  const src = read("release/server/user-data.sh");
  expect(src.startsWith("#!/bin/sh\n")).toBe(true);
  expect(src).toContain(INSTALL_COMMAND);
  expect(Bun.spawnSync(["sh", "-n", join(DIR, "user-data.sh")]).exitCode).toBe(0);
});

test("the compose file runs the published image on the host network, its home on the Dockerfile's volume", () => {
  const compose = Bun.YAML.parse(read("release/server/compose.yml")) as {
    services: { overhand: { image: string; container_name: string; network_mode: string; volumes: string[] } };
    volumes: { overhand: { name: string } };
  };
  const s = compose.services.overhand;
  expect(read("release/launch.ts")).toMatch(/`\$\{IMAGE\}:latest`/);
  expect(s.image).toBe(`${IMAGE}:latest`);
  // loopback only: the host network, never a published port
  expect(s.network_mode).toBe("host");
  expect(Object.keys(s)).not.toContain("ports");
  const home = read("Dockerfile").match(/^VOLUME (\S+)$/m)?.[1];
  expect(s.volumes).toEqual([`overhand:${home}`]);
  // the same container and volume names as the docs' docker run and docker exec
  const docs = read("site/pages/docs/server.html");
  expect(docs).toContain(`--name ${s.container_name} `);
  expect(docs).toContain(`-v ${compose.volumes.overhand.name}:${home} `);
});

test("the server docs fetch every ready-made setup, and only those", () => {
  const named = [...read("site/pages/docs/server.html").matchAll(/\{\{serverFiles\}\}\/([\w.-]+)/g)].map((m) => m[1]);
  expect(new Set(named)).toEqual(new Set(readdirSync(DIR)));
});
