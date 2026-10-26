#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const scratch = join(repo, ".runtime/ingestion-demo");
const project = join(scratch, "project");
const cliPath = join(repo, "dist/cli.js");
const jar = resolve(repo, process.env.TLA2TOOLS_JAR || ".runtime/tla2tools.jar");
const ownership = "sgd-ingestion-demo-v1\n";
const marker = join(scratch, ".sgd-ingestion-demo");
const results = [];

function run(name, command, expectedExit = 0, includes = [], diagnostics = false) {
  const child = spawnSync(command[0], command.slice(1), {
    cwd: repo, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 180_000,
  });
  const stdout = child.stdout || "";
  const stderr = child.stderr || "";
  const passed = !child.error && child.status === expectedExit &&
    includes.every((text) => (stdout + stderr).includes(text)) &&
    (!diagnostics || stdout.trim() === "[]");
  results.push({ name, command, cwd: repo, expectedExit, exit: child.status,
    passed, stdout, stderr, ...(child.error ? { error: child.error.message } : {}) });
  writeFileSync(join(scratch, "results.json"), JSON.stringify({ version: 1, results }, null, 2) + "\n");
  if (!passed) throw new Error(`${name} failed. See ${join(scratch, "results.json")}`);
  console.log(`PASS ${name} (exit ${child.status})`);
}

function cli(command, ...args) {
  return [process.execPath, cliPath, command, ...args];
}

function sources(root) {
  function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
    });
  }
  return walk(join(root, "src")).sort();
}

function checker(model) {
  return [process.execPath, join(scratch, `${model}-checks`, "typescript/checker.mjs")];
}

function verify() {
  for (const required of [cliPath, jar, join(repo, "node_modules/typescript/bin/tsc")]) {
    if (!existsSync(required)) throw new Error(`Required file is missing: ${required}. Build/install repository dependencies and provide TLA2TOOLS_JAR first.`);
  }
  const parser = JSON.parse(readFileSync(join(repo, "node_modules/typescript/package.json"), "utf8"));
  if (parser.version !== "7.0.2") throw new Error("The example requires the repository's exact TypeScript 7.0.2 dependency.");
  if (existsSync(scratch)) {
    if (lstatSync(scratch).isSymbolicLink() || !existsSync(marker) || readFileSync(marker, "utf8") !== ownership) {
      throw new Error(`Refusing to replace an unowned scratch directory: ${scratch}`);
    }
    rmSync(scratch, { recursive: true });
  }
  mkdirSync(scratch, { recursive: true });
  writeFileSync(marker, ownership);
  cpSync(join(repo, "examples/ingestion"), project, { recursive: true });

  // Complete both real model runs before generating application checks.
  for (const model of ["ingestion", "architecture"]) {
    run(`${model}: TLC`, cli("model", "--project", join(project, `models/${model}.json`),
      "--jar", jar, "--out", join(scratch, `${model}-model`)));
    const log = readFileSync(join(scratch, `${model}-model/tlc.log`), "utf8");
    if (!log.includes("Model checking completed. No error has been found.") || !log.includes("0 states left on queue")) {
      throw new Error(`The ${model} TLC run did not report complete successful exploration.`);
    }
  }
  for (const model of ["ingestion", "architecture"]) {
    const output = join(scratch, `${model}-checks`);
    run(`${model}: inspect`, cli("inspect", "--ir", join(scratch, `${model}-model/automaton.json`)));
    run(`${model}: compile`, cli("compile", "--project", join(project, `models/${model}.json`),
      "--dot", join(scratch, `${model}-model/model.dot`), "--out", output));
    run(`${model}: TypeScript accepted`, [...checker(model), "--root", project,
      ...sources(project)], 0, [], true);
  }

  const forbidden = join(scratch, "forbidden-import");
  cpSync(project, forbidden, { recursive: true });
  run("TypeScript: forbidden transition", [...checker("ingestion"), "--root", project,
    join(project, "cases/forbidden-transition.ts")], 1, ["TLC001", "Received", "Persist", "Stored"]);
  run("TypeScript: nonliteral transition", [...checker("ingestion"), "--root", project,
    join(project, "cases/nonliteral-transition.ts")], 1, ["TLC002"]);
  const handler = join(forbidden, "src/handler.ts");
  writeFileSync(handler, readFileSync(handler, "utf8") +
    '\nimport { Storage } from "./storage.js";\nexport const directStorage = new Storage();\n');
  run("TypeScript: forbidden import", [...checker("architecture"), "--root", forbidden,
    ...sources(forbidden)], 1, ["TLC003", "Handler", "Storage"]);
  for (const [model, invariant] of [["ingestion", "StoredRequiresValidation"], ["architecture", "NoHandlerStorageDependency"]]) {
    run(`${model}: bad model`, cli("model", "--project", join(project, `models/${model}-bad.json`),
      "--jar", jar, "--out", join(scratch, `${model}-bad`)), 2, ["TLC102", invariant, "violated"]);
    run(`${model}: stable generation`, cli("compile", "--project", join(project, `models/${model}.json`),
      "--dot", join(scratch, `${model}-model/model.dot`), "--out", join(scratch, `${model}-checks`), "--check"));
  }

  run("TypeScript: native build", [process.execPath, join(repo, "node_modules/typescript/bin/tsc"), "--project", join(project, "tsconfig.json")]);
  run("TypeScript: native tests", [process.execPath, join(project, "native-typescript/pipeline.test.js")], 0, ["runtime tests passed"]);
  run("Pele: combined models", cli("visualize", "--ir", join(scratch, "architecture-model/automaton.json"),
    "--ir", join(scratch, "ingestion-model/automaton.json"), "--out", join(scratch, "pele")));
  console.log(`Results: ${join(scratch, "results.json")}\nPele: ${join(scratch, "pele/index.html")}`);
}

try {
  verify();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
