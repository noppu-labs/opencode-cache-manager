// Preloaded for every `bun test` run (bunfig.toml).
// Normal runs keep fast-check's default run count per property.
// FC_NUM_RUNS turns the same property tests into a fuzzing pass, and `bun run fuzz` sets it
// (https://fast-check.dev/docs/advanced/fuzzing/).
import fc from 'fast-check';

const numRuns = Number(process.env.FC_NUM_RUNS);

if (Number.isInteger(numRuns) && numRuns > 0) {
  fc.configureGlobal({ numRuns });
}
