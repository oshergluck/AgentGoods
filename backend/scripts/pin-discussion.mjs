#!/usr/bin/env node
/**
 * Pin or unpin a forum discussion, as the operator.
 *
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT. A pin is the only ordering on the board that is not
 * earned by activity or by votes: it puts a discussion above everything else under every sort. An
 * endpoint that granted it — however carefully authenticated — would make the most prominent
 * position on the board reachable by request, and the first participant to find it would own the
 * top of the page. There is no HTTP route that pins, for anyone, and this is why.
 *
 * It writes the flag directly, the same way the deployment reset does, and it is run with the
 * deployment's own environment injected so MONGODB_URI is never guessed at.
 *
 *     node backend/scripts/pin-discussion.mjs --chain 84532 --post <id>
 *     node backend/scripts/pin-discussion.mjs --chain 84532 --post <id> --unpin
 *     node backend/scripts/pin-discussion.mjs --chain 84532 --list
 */

import mongoose from "mongoose";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};

const chainId = Number(value("--chain"));
if (!Number.isInteger(chainId)) {
  console.error("name the chain: --chain 84532");
  process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Run this with the deployment's environment injected.");
  process.exit(1);
}

await mongoose.connect(uri);
const posts = mongoose.connection.collection("forumposts");

if (flag("--list")) {
  const pinned = await posts.find({ chainId, pinned: true }).toArray();
  console.log(`${pinned.length} pinned discussion(s) on chain ${chainId}`);
  for (const p of pinned) {
    console.log(`  ${p._id}  ${String(p.message).slice(0, 70).replace(/\s+/g, " ")}`);
  }
  await mongoose.disconnect();
  process.exit(0);
}

const postId = value("--post");
if (!postId) {
  console.error("name the post: --post <id>");
  process.exit(1);
}

let _id;
try {
  _id = new mongoose.Types.ObjectId(postId);
} catch {
  console.error(`"${postId}" is not a post id`);
  process.exit(1);
}

const post = await posts.findOne({ _id, chainId });
if (!post) {
  console.error(`no post ${postId} on chain ${chainId}`);
  process.exit(1);
}

/*
 * Only a ROOT can be pinned. Pinning a reply would put a discussion at the top of the board by way
 * of a message in the middle of it, and the list is a list of discussions.
 */
if (post.replyTo) {
  console.error("that is a reply, not a discussion. Pin the root post of the thread instead.");
  process.exit(1);
}

const unpin = flag("--unpin");
await posts.updateOne(
  { _id },
  unpin ? { $set: { pinned: false, pinnedAt: null } } : { $set: { pinned: true, pinnedAt: new Date() } }
);

console.log(`${unpin ? "unpinned" : "PINNED"} on chain ${chainId}: ${postId}`);
console.log(`  ${String(post.message).slice(0, 90).replace(/\s+/g, " ")}`);

const total = await posts.countDocuments({ chainId, pinned: true });
console.log(`  ${total} discussion(s) now pinned on this chain`);

await mongoose.disconnect();
