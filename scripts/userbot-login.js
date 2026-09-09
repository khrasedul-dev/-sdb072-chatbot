/**
 * One-time sign-in for the userbot.
 *
 * Telegram sends a code to the account being signed in, so this has to be run
 * somewhere you can type: your own terminal, not a deploy script. It saves the
 * session to data/userbot.session and prints it, so it can be copied to a
 * server as USERBOT_SESSION.
 *
 *   npm run userbot:login
 *
 * The session string is equivalent to being logged into the account. Treat it
 * exactly like the password.
 */
const readline = require("readline");
const { createClient, saveSession, SESSION_FILE } = require("../src/userbot");

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (hidden) {
      // Stop the terminal echoing the two-step password back.
      const onData = (char) => {
        if (["\n", "\r", "\u0004"].includes(char.toString())) process.stdin.removeListener("data", onData);
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

(async () => {
  if (!process.stdin.isTTY) {
    console.error("This needs a real terminal — Telegram will ask for a login code.");
    process.exit(1);
  }

  console.log("Signing in the account that will send /link and /ib.\n");

  const client = createClient("");
  await client.start({
    phoneNumber: () => ask("Phone number, with country code (e.g. +31612345678): "),
    phoneCode: () => ask("Code Telegram just sent: "),
    password: () => ask("Two-step verification password: ", { hidden: true }),
    onError: (err) => console.error("  ", err.message || err),
  });

  const me = await client.getMe();
  const session = client.session.save();
  const saved = saveSession(session);

  console.log(`\nSigned in as ${me.username ? "@" + me.username : me.firstName} (${me.id}).`);
  if (saved) console.log(`Session saved to ${SESSION_FILE}`);
  console.log("\nTo run this on a server instead, set:\n");
  console.log(`USERBOT_SESSION=${session}\n`);
  console.log("Anyone holding that string is signed into the account. Do not commit or paste it anywhere public.");

  await client.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Login failed:", err.message || err);
  process.exit(1);
});
