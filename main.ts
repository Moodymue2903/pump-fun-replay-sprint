// Pump.fun Replay Sprint — paper bot entrypoint.
// The grader runs `node /bot/main.ts`. The strategy lives in strategy.ts and
// the wire shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
