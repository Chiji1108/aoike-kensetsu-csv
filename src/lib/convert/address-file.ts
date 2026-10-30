import { fileURLToPath, pathToFileURL } from "node:url"
import { ADDRESS_API_PATH, lookupAddresses, type AddressLookup } from "./address"

/** 同梱の住所データをファイルで読む（照合スクリプト・テスト用。Node・Bun だけ。画面は URL で読む） */
const api = pathToFileURL(fileURLToPath(new URL(`../../../public${ADDRESS_API_PATH}`, import.meta.url))).href

export const fileAddressLookup: AddressLookup = (raws) => lookupAddresses(raws, api)
