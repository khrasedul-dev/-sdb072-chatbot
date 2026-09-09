/**
 * One-time sign-in for the userbot.
 *
 *   npm run userbot:login
 *
 * Telegram sends a login code, so this has to run somewhere you can type — your
 * own terminal or an SSH session, not a deploy script. On success it writes
 * USERBOT_SESSION straight into .env, which is the only place the userbot looks.
 *
 * The session string is equivalent to being logged into the account. Treat it
 * exactly like the password: .env is gitignored and written chmod 600.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ENV_FILE = process.env.USERBOT_LOGIN_ENV_FILE || path.join(__dirname, "..", ".env");

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (hidden) {
      // Stop the terminal echoing the two-step password back.
      const onData = (char) => {
        if (["\n", "\r", ""].includes(char.toString())) process.stdin.removeListener("data", onData);
        else process.stdout.write("\x1B[2K\x1B[200D" + question + "*".repeat(rl.line.length));
      };
      process.stdin.on("data", onData);
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

const readEnv = () => {
  try {
    return fs.readFileSync(ENV_FILE, "utf8");
  } catch {
    return "";
  }
};

/**
 * Replace USERBOT_SESSION if it is already there, append it if not, and leave
 * every other line — including comments — exactly as it was. Written to a temp
 * file and renamed, so an interrupted write cannot truncate the token that is
 * already in there.
 */
function writeSessionToEnv(session) {
  let contents = readEnv();
  const line = `USERBOT_SESSION=${session}`;

  if (/^USERBOT_SESSION=.*$/m.test(contents)) {
    contents = contents.replace(/^USERBOT_SESSION=.*$/m, line);
  } else if (/^#\s*USERBOT_SESSION=.*$/m.test(contents)) {
    // Uncomment the placeholder .env.example ships with.
    contents = contents.replace(/^#\s*USERBOT_SESSION=.*$/m, line);
  } else {
    if (contents && !contents.endsWith("\n")) contents += "\n";
    contents += `\n# Written by \`npm run userbot:login\` on ${new Date().toISOString().slice(0, 10)}.\n`;
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

async function main() {
  if (!process.stdin.isTTY) {
    console.error("This needs a real terminal — Telegram will ask for a login code.");
    process.exit(1);
  }

  // Read .env first: the api id and hash have to be there before we connect.
  require("dotenv").config({ path: ENV_FILE });
  const { createClient } = require("../src/userbot");

  if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
    console.error("TELEGRAM_API_ID and TELEGRAM_API_HASH are missing from .env.\n");
    console.error("Get them from https://my.telegram.org -> API development tools,");
    console.error("then add to .env:\n");
    console.error("  TELEGRAM_API_ID=1234567");
    console.error("  TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef\n");
    process.exit(1);
  }

  if (/^USERBOT_SESSION=.+$/m.test(readEnv())) {
    const answer = await ask("A session is already saved in .env. Replace it? [y/N] ");
    if (!/^y(es)?$/i.test(answer)) {
      console.log("Left as it was.");
      process.exit(0);
    }
  }

  console.log("\nSigning in the account that will send /link and /ib.");
  console.log("This is the ADMIN'S OWN account, not the bot.\n");

  const client = createClient("");
  await client.start({
    phoneNumber: () => ask("Phone number, with country code (e.g. +31612345678): "),
    phoneCode: () => ask("Code Telegram just sent: "),
    password: () => ask("Two-step verification password: ", { hidden: true }),
    onError: (err) => console.error("  ", err.message || err),
  });

  const me = await client.getMe();
  const session = client.session.save();
  writeSessionToEnv(session);

  console.log(`\nSigned in as ${me.username ? "@" + me.username : me.firstName} (${me.id}).`);
  console.log(`USERBOT_SESSION written to ${ENV_FILE}\n`);
  console.log("Start it with:  npm run userbot");
  console.log("\nTo run it on the server, copy that one line into the server's .env");
  console.log("(/srv/vip-bot/app/.env) and the deploy will pick it up.");
  console.log("\nThat string is the account. Do not commit it or paste it into a chat.");
  console.log("To revoke: Telegram -> Settings -> Devices -> terminate the session.");

  await client.disconnect();
  process.exit(0);
}

module.exports = { writeSessionToEnv, ENV_FILE };

if (require.main === module) {
  main().catch((err) => {
    console.error("\nLogin failed:", err.message || err);
    process.exit(1);
  });
}
