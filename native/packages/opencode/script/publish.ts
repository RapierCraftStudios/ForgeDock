#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"
import path from "path"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

const dryRun = process.argv.includes("--dry-run")
const forgeDockLicense = await Bun.file("../../../LICENSE").text()
const upstreamLicense = await Bun.file("../../LICENSE").text()

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (!dryRun && (await published(name, version))) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await Bun.file(path.join(dir, "LICENSE")).write(forgeDockLicense)
  await Bun.file(path.join(dir, "OPENCODE-MIT.txt")).write(upstreamLicense)
  await $`bun pm pack`.cwd(dir)
  if (dryRun) {
    console.log(`packed ${name}@${version}`)
    return
  }
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
}

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const candidate = await Bun.file(`./dist/${filepath}`).json()
  if (candidate.name === pkg.name || !candidate.name.startsWith(`${pkg.name}-`)) continue
  binaries[candidate.name] = candidate.version
}
console.log("binaries", binaries)
const version = Object.values(binaries)[0]
if (!version) throw new Error("No ForgeDock platform packages found. Build the native binaries before publishing.")

await $`mkdir -p ./dist/${pkg.name}`
await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/bin/${pkg.name}.exe`).write(
  [
    `echo "Error: ${pkg.name}'s postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${pkg.name} && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${pkg.name} without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      description: "ForgeDock's native autonomous software development CLI.",
      bin: {
        [pkg.name]: `./bin/${pkg.name}.exe`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      repository: {
        type: "git",
        url: "git+https://github.com/RapierCraftStudios/ForgeDock-CLI.git",
      },
      homepage: "https://github.com/RapierCraftStudios/ForgeDock-CLI",
      bugs: {
        url: "https://github.com/RapierCraftStudios/ForgeDock-CLI/issues",
      },
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

for (const [name] of Object.entries(binaries)) {
  await publish(`./dist/${name}`, name, binaries[name])
}
await publish(`./dist/${pkg.name}`, pkg.name, version)
