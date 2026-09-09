/**
 * Reading and rewriting .env.
 *
 * Shared by the CLI login and the /login flow inside the bot, and careful
 * because this file also holds the bot token: only the USERBOT_SESSION line is
 * ever touched, and the write goes through a temp file so an interrupted run
 * cannot truncate what is already there.
 */
const fs = require("fs");
const path = require("path");

const ENV_FILE = process.env.ENV_FILE_OVERRIDE || path.join(__dirname, "..", ".env");

function readEnv() {
  try {
    return fs.readFileSync(ENV_FILE, "utf8");
  } catch {
    return "";
  }
}

/** Is a session already stored? */
function hasSession() {
  return /^USERBOT_SESSION=.+$/m.test(readEnv());
}

/**
 * Replace USERBOT_SESSION if it is there, fill in the commented placeholder if
 * that is what is there, otherwise append. Every other line — comments
 * included — is left exactly as it was.
 */
function writeSessionToEnv(session) {
  let contents = readEnv();
  const line = `USERBOT_SESSION=${session}`;

  if (/^USERBOT_SESSION=.*$/m.test(contents)) {
    contents = contents.replace(/^USERBOT_SESSION=.*$/m, line);
  } else if (/^#\s*USERBOT_SESSION=.*$/m.test(contents)) {
    contents = contents.replace(/^#\s*USERBOT_SESSION=.*$/m, line);
  } else {
    if (contents && !contents.endsWith("\n")) contents += "\n";
    contents += `\n# Written on ${new Date().toISOString().slice(0, 10)}.\n`;
    contents += "# This string IS the account — anyone holding it is signed in.\n";
    contents += `${line}\n`;
  }

  const tmp = `${ENV_FILE}.tmp`;
  fs.writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, ENV_FILE);
  try {
    fs.chmodSync(ENV_FILE, 0o600);
  } catch {
    // Windows has no POSIX modes; nothing to do.
  }
}

module.exports = { ENV_FILE, readEnv, hasSession, writeSessionToEnv };
