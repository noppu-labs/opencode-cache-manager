/** Name of the trace file in the home folder, when the `debug` option gives no path. */
const DEBUG_LOG_FILENAME = 'opencode-cache-manager-debug.jsonl';

/** Start of a `debug.path` relative to the home folder. */
const DEBUG_HOME_PATH_PREFIX = '~/';

/** Cap on each end of a response excerpt, and on a logged error message. */
const DEBUG_BODY_CHARS = 600;

/** Longest string from a request body the trace prints; anything longer could be body text and logs as `string`. */
const DEBUG_FIELD_CHARS = 16;

/** The trace can hold response content, so only the owner may read it. */
const DEBUG_FILE_MODE = 0o600;

/** Length of the ID that tells one loaded plugin instance from another in a trace. */
const DEBUG_INSTANCE_ID_CHARS = 6;

export {
  DEBUG_BODY_CHARS,
  DEBUG_FIELD_CHARS,
  DEBUG_FILE_MODE,
  DEBUG_HOME_PATH_PREFIX,
  DEBUG_INSTANCE_ID_CHARS,
  DEBUG_LOG_FILENAME,
};
