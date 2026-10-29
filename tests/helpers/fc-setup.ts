// Preloaded for every `bun test` run (bunfig.toml). Normal runs keep fast-check's default
// Number of runs per property; FC_NUM_RUNS turns the same property tests into a fuzzing pass
// (https://fast-check.dev/docs/advanced/fuzzing/). `bun run fuzz` sets it.
import { configureGlobal } from 'fast-check';

const numRuns = Number(process.env.FC_NUM_RUNS);

if (Number.isInteger(numRuns) && numRuns > 0) {
  configureGlobal({ numRuns });
}
