/**
 * address-bundled.test.ts が別のプロセスで動かす: Worker と同じくライブラリのブラウザ向けの版（住所データを fetch で読む）で
 * bundledAddressLookup を引き、結果を JSON で書く（Bun はふつう Node 向けの版を読むので、このプロセスだけ読み替える）。引数は住所の JSON
 */
import { readFileSync } from "node:fs"

const dir = new URL("../../../../", import.meta.url).pathname
Bun.plugin({
  name: "geolonia-browser-build",
  setup(build) {
    // Node 向けの版を読むところで、ブラウザ向けの版の中身を返す
    build.onLoad({ filter: /normalize-japanese-addresses\/dist\/main-node-esm\.mjs$/ }, async () => ({
      contents: await Bun.file(`${dir}node_modules/@geolonia/normalize-japanese-addresses/dist/main-esm.mjs`).text(),
      loader: "js",
    }))
  },
})
const { bundledAddressLookup } = await import("../address")
const ja: unknown = JSON.parse(readFileSync(`${dir}public/japanese-addresses/api/ja.json`, "utf8"))
const book = await bundledAddressLookup(ja)(JSON.parse(process.argv[2]!) as string[])
process.stdout.write(JSON.stringify(Object.fromEntries(book)))
