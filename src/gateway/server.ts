/**
 * Gateway entry point.
 *
 * Reads configuration from the environment, wires the seams, and reports what
 * is live and what is refusing. That report is deliberate: a gateway that
 * boots silently with no relayer looks identical to a working one until the
 * first passkey prompt fails.
 *
 *   npm run gateway
 */

import { createGateway } from "./http";
import { createUnconfiguredPolicyDeployer } from "./policies";
import { createMemorySessionStore } from "./store";
import {
  createHttpRelayerSubmitter,
  createUnconfiguredSubmitter,
  relayerConfigFromEnv,
} from "./submitter";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const allowedOrigin = process.env.GATEWAY_ALLOWED_ORIGIN ?? "http://localhost:5173";

const relayer = relayerConfigFromEnv();
const submitter = relayer
  ? createHttpRelayerSubmitter({ config: relayer })
  : createUnconfiguredSubmitter();

const server = createGateway({
  allowedOrigin,
  sessions: createMemorySessionStore(),
  submitter,
  policies: createUnconfiguredPolicyDeployer(),
});

server.listen(port, () => {
  console.log(`two-key gateway listening on http://localhost:${port}`);
  console.log(`  cors origin      ${allowedOrigin}`);
  console.log(`  sessions         in-memory (forgotten on restart)`);
  console.log(`  submission       ${relayer ? `relayer at ${relayer.url}` : "NOT CONFIGURED — /wallet/submit will 503"}`);
  console.log(`  policy deploy    NOT CONFIGURED — generate/simulate/deploy will 503`);
});
