import "dotenv/config";

import { setGlobalDispatcher, ProxyAgent } from "undici";

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}
