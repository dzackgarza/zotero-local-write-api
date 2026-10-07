import createClient from "openapi-fetch";
import type { paths } from "./generated/openapi.js";

export function createZoteroLocalWriteClient(baseUrl: string = "http://127.0.0.1:23119") {
  return createClient<paths>({ baseUrl });
}
