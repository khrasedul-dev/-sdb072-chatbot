/**
 * The editable messages, kept in MongoDB.
 *
 * messages.js still holds the texts, but as the *seed*: whatever is in Mongo
 * wins, and the admin edits it from Telegram with /edit. That is the whole
 * point — the client rewrites the VIP pitch whenever they like, without anyone
 * touching the repo.
 *
 * Reads are served from an in-memory copy so nothing on the hot path waits on a
 * database. A change stream keeps that copy current when one is available — an
 * edit made from another machine, or a second deployment, shows up without a
 * restart — and a slow poll covers the case where change streams are not.
 *
 * If Mongo is unreachable the seeds are used and the bot keeps working. Losing
 * the ability to edit a message is an inconvenience; going silent is an outage.
 */
const { MongoClient } = require("mongodb");

const DEFAULTS = require("./messages");
const { MONGODB_URI } = require("./config");

// Namespaced, because MONGODB_URI may point at a database another app already
// uses — sharing one is fine as long as nothing collides.
const COLLECTION = (process.env.MONGODB_COLLECTION || "vipbot_messages").trim();
const REFRESH_MS = 60_000;

/**
 * What /edit offers, in the order it offers it.
 *
 *   html — sent as a Telegram message, formatting and premium emoji preserved
 *   text — plain, used inside a button label or a pre-typed message
 *   url  — must parse as a link
 */
const EDITABLE = {
  WELCOME_MESSAGE: { label: "Welcome / VIP post", kind: "html" },
  WELCOME_BUTTON_TEXT: { label: "Welcome button label", kind: "text" },
  WELCOME_PREFILLED_DM: { label: "Pre-typed DM text", kind: "text" },
  LINK_MESSAGE: { label: "/link message", kind: "html" },
  LINK_BUTTON_TEXT: { label: "/link button label", kind: "text" },
  LINK_BUTTON_URL: { label: "/link button URL", kind: "url" },
  IB_MESSAGE: { label: "/ib message", kind: "html" },
  IB_BUTTON_TEXT: { label: "/ib button label", kind: "text" },
};

const KEYS = Object.keys(EDITABLE);

let client = null;
let collection = null;
let changeStream = null;
let refreshTimer = null;
let connected = false;

/** Edits layered over the seeds. Empty until Mongo says otherwise. */
const overrides = new Map();

/** The current value of one message — an override, else the seed. */
function get(key) {
  return overrides.has(key) ? overrides.get(key) : DEFAULTS[key];
}

/** Everything, shaped like messages.js so call sites read the same. */
function all() {
  const out = { ...DEFAULTS };
  for (const [key, value] of overrides) out[key] = value;
  return out;
}

/** Has this key been edited away from the seed? */
const isEdited = (key) => overrides.has(key);

const isConnected = () => connected;

/** @returns true when the read actually succeeded. */
async function refresh() {
  if (!collection) return false;
  try {
    const docs = await collection.find({ _id: { $in: KEYS } }).toArray();
    overrides.clear();
    for (const doc of docs) {
      if (typeof doc.value === "string") overrides.set(doc._id, doc.value);
    }
    return true;
  } catch (err) {
    console.warn("[store] Could not refresh from MongoDB:", err.message);
    return false;
  }
}

function watch() {
  if (!collection) return;
  try {
    changeStream = collection.watch([], { fullDocument: "updateLookup" });
    changeStream.on("change", () => {
      refresh().catch(() => {});
    });
    // A dropped stream must not take the process with it — the poll below keeps
    // things current until it can be re-established.
    changeStream.on("error", (err) => {
      console.warn("[store] Change stream stopped, falling back to polling:", err.message);
      changeStream = null;
    });
  } catch (err) {
    console.warn("[store] Change streams unavailable, polling instead:", err.message);
  }
}

/**
 * Connect, load, and start following changes. Safe to call when MONGODB_URI is
 * not set — the seeds are used and everything still runs.
 */
async function connect({ label = "app" } = {}) {
  if (!MONGODB_URI) {
    console.warn(`[store] MONGODB_URI is not set — using the texts in messages.js, and /edit will not work.`);
    return false;
  }

  try {
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
      // Reads are cached, so a brief outage should be waited out rather than
      // queueing writes forever.
      maxPoolSize: 5,
    });
    await client.connect();
    const dbName = client.db().databaseName;
    collection = client.db().collection(COLLECTION);

    // `client.connect()` succeeding only means the server answered — with auth
    // enabled it says nothing about whether this user may read the collection.
    // Reporting "connected" on that alone hid a database the bot could not
    // actually use, so the first read has to work before we claim anything.
    if (!(await refresh())) {
      connected = false;
      collection = null;
      await client.close().catch(() => {});
      client = null;
      console.warn(
        `[store] Reached MongoDB but cannot read "${dbName}.${COLLECTION}". The user in ` +
          "MONGODB_URI needs readWrite on that database. Using the texts in messages.js."
      );
      return false;
    }

    watch();

    refreshTimer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
    refreshTimer.unref?.();

    connected = true;
    console.log(
      `[store] MongoDB ready (${label}) — ${dbName}.${COLLECTION}, ` +
        `${overrides.size} of ${KEYS.length} messages edited.`
    );
    return true;
  } catch (err) {
    console.warn(`[store] MongoDB unavailable (${err.message}) — using the texts in messages.js.`);
    return false;
  }
}

/** Save an edited message. The change stream tells the other process. */
async function set(key, value, editedBy) {
  if (!EDITABLE[key]) throw new Error(`${key} is not editable`);
  if (!collection) throw new Error("Not connected to MongoDB, so nothing can be saved.");

  await collection.updateOne(
    { _id: key },
    { $set: { value, updatedAt: new Date(), updatedBy: editedBy || null } },
    { upsert: true }
  );
  // Apply locally at once rather than waiting for our own change event.
  overrides.set(key, value);
}

/** Drop an edit and go back to the text in messages.js. */
async function reset(key) {
  if (!EDITABLE[key]) throw new Error(`${key} is not editable`);
  if (!collection) throw new Error("Not connected to MongoDB, so nothing can be reset.");

  await collection.deleteOne({ _id: key });
  overrides.delete(key);
}

/** When each message was last changed, for the /edit menu. */
async function history() {
  if (!collection) return {};
  try {
    const docs = await collection.find({ _id: { $in: KEYS } }).toArray();
    return Object.fromEntries(docs.map((d) => [d._id, { updatedAt: d.updatedAt, updatedBy: d.updatedBy }]));
  } catch {
    return {};
  }
}

async function close() {
  clearInterval(refreshTimer);
  try {
    await changeStream?.close();
  } catch {
    // Already closed.
  }
  await client?.close().catch(() => {});
  connected = false;
}

module.exports = { EDITABLE, KEYS, connect, close, get, all, set, reset, history, isEdited, isConnected, refresh };
